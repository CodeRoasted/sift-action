// The CHANGED run's declared `needs:` job graph — this Action's producer of the ADR-22.D13
// wire (`--changed-job-graph`, a JSON file behind a flag). The engine folds a required-check
// aggregator row into the member that actually failed, but only from a DECLARED graph: `needs:`
// is a static list in the workflow file that cannot carry expressions, which is what makes the
// edge a declaration rather than a guess (ADR-22.D5 — acquisition derives, never infers).
//
// The acquisition mirrors the crawler's (insight-eidos sift/src/crawl/job_graph.cpp) because the
// two are the SAME producer contract over different transports, and a divergence between them
// would be a silent fork of one wire. Same rules, stated where they bind below: verbatim `name:`,
// the exactly-one conclusion refusal, key-less quoted renderings, and the edge gate.
//
// ⚠ WHY js-yaml AND NOT A SUBSET PARSER OF OUR OWN — the choice IS the point. The input is a
// workflow file a contributor can influence, and a hand-rolled reader would be a second reader of
// a format we do not own, over hostile-capable bytes, inside the one path whose whole
// justification is "declarations and no heuristic". js-yaml v4's `load` uses the expression-free
// default schema (no code execution, no !!js types), and the bytes arrive under the contents
// API's own response cap.
//
// READ ONLY WHERE A FOLD ROW CAN BE CORRECT (DN-118.D4). The fold replaces an aggregator's rows with
// a failed member's, so it needs rows from two jobs. A `target-job` diff holds one job's rows, and
// there every fold row the engine can mint is a misattribution; the entry does not call the resolver
// at that grain and logs `ONE_JOB_GRAIN_NO_GRAPH_LINE` instead. A `log:` file may hold several jobs'
// logs, where the fold is correct, so the graph is read for it.
//
// FAIL-SOFT BY DESIGN, and absent ≠ empty: every acquisition failure (no runner coordinate for the
// executed workflow file, an unreadable file, a denied `contents: read`, a failed jobs listing) resolves to ABSENT — no flag,
// fold inert, run unaffected — with one log line naming the reason, because a fold that silently
// stopped firing reads exactly like a clean run. A workflow that genuinely declares zero jobs is
// DECLARED-EMPTY (`[]`), a different fact the engine acts on.

import type { getOctokit } from '@actions/github';
import { load, YAMLException } from 'js-yaml';

type Octokit = ReturnType<typeof getOctokit>;

// One job as the workflow file declares it (pre-join): the mapping key, the verbatim `name:`,
// and the `needs:` edges by key.
export interface DeclaredJobRecord {
    key: string;
    name: string;
    needs: string[];
}

// One job as the run's listing renders it: the platform's own name and NATIVE conclusion.
export interface RenderedJob {
    name: string;
    conclusion: string;
}

// The ADR-22.D13 wire entry. ALL FOUR FIELDS ALWAYS TRAVEL — `key` and `display` are required by
// the engine and never defaulted from each other (a graph keyed on the wrong coordinate folds
// nothing and reads exactly like a clean run); empty strings are first-class statements, not
// omissions.
export interface DeclaredJobWire {
    key: string;
    display: string;
    needs: string[];
    conclusion: string;
}

// The reusable-workflow rendering separator (ADR-22.D13 — cited, never restated; the grammar's
// mirror witness lives in tests/joblog.test.ts).
const REUSABLE_SEPARATOR = ' / ';

// A YAML scalar's text, or '' for anything that is not a scalar — a workflow file is free to
// contain shapes we must not throw on. Verbatim for strings: a `name:` carrying a `${{ }}`
// expression is kept as written and simply fails the join — this producer does not render
// expressions, and a job whose rendering it cannot know stays UNRESOLVED rather than guessed.
function scalarText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The `needs:` edges a job body declares. GitHub accepts a bare scalar or a sequence — both
// shapes, one meaning.
function declaredNeeds(body: Record<string, unknown>): string[] {
    const declared = body['needs'];
    if (declared === undefined || declared === null) return [];
    if (!Array.isArray(declared)) {
        const key = scalarText(declared);
        return key ? [key] : [];
    }
    const needs: string[] = [];
    for (const entry of declared) {
        const key = scalarText(entry);
        if (key) needs.push(key);
    }
    return needs;
}

// Workflow YAML → the declared jobs, in document order (deterministic for a given file). Throws
// with the reason on an unreadable or jobs-less file — the caller turns that into ABSENT with the
// reason logged, never into a failed run.
export function parseWorkflowJobs(yaml: string): DeclaredJobRecord[] {
    let root: unknown;
    try {
        root = load(yaml);
    } catch (error) {
        const message = error instanceof YAMLException ? error.message : String(error);
        throw new Error(`workflow YAML is unreadable: ${message}`);
    }
    if (!isPlainMap(root)) {
        throw new Error('workflow file is not a YAML mapping');
    }
    const jobs = root['jobs'];
    if (!isPlainMap(jobs)) {
        throw new Error('workflow file declares no `jobs:` mapping');
    }

    const declared: DeclaredJobRecord[] = [];
    for (const [key, body] of Object.entries(jobs)) {
        if (!key) continue; // an empty key names nothing `needs:` could reference
        const job: DeclaredJobRecord = { key, name: '', needs: [] };
        if (isPlainMap(body)) {
            job.name = scalarText(body['name']);
            job.needs = declaredNeeds(body);
        }
        // A job whose body is null or a scalar declares no name and no edges, and it is still
        // KEPT: its key is a legitimate target of another job's `needs:`.
        declared.push(job);
    }
    return declared;
}

export function declaresAnEdge(declared: DeclaredJobRecord[]): boolean {
    return declared.some((job) => job.needs.length > 0);
}

// The declared jobs joined with the run's rendered listing — the acquirer resolves the mapping
// because it is the party holding both the YAML and the jobs listing (the engine never guesses
// across the two).
export function joinDeclaredJobs(
    declared: DeclaredJobRecord[],
    rendered: RenderedJob[],
): DeclaredJobWire[] {
    const joined: DeclaredJobWire[] = [];
    for (const job of declared) {
        // What the log renders this job under, per GitHub's own rule: the declared `name:`, else
        // the key. An ANCHOR, not a single row's name — the engine expands it over the
        // reusable-workflow fan-out at match time; the set is never stored (it would snapshot a
        // rendering only the platform authors, and the staleness would be silent).
        const anchor = job.name || job.key;
        const prefix = anchor + REUSABLE_SEPARATOR;
        const members = rendered.filter((row) => row.name === anchor || row.name.startsWith(prefix));
        // Rendered NOWHERE ⇒ `display` stays EMPTY — the acquirer's only honest statement about
        // this key, and the coordinate the engine counts for its coverage clause. Never filled
        // speculatively.
        //
        // ⚠ A CONCLUSION IS DECLARED FOR EXACTLY ONE RENDERED JOB, OR NOT AT ALL. When a declared
        // job fans out, GitHub emits N conclusions and NO row for the caller; rolling those N into
        // one would make us the author of a verdict the platform did not state (ADR-20.D23 — the
        // refusal stands; the fan-out's verdicts travel below at the grain the platform declared
        // them). Empty is NOT DECLARED (ADR-22.D10) — a third state, and the honest one.
        joined.push({
            key: job.key,
            display: members.length > 0 ? anchor : '',
            needs: job.needs,
            conclusion: members.length === 1 ? members[0]!.conclusion : '',
        });
    }
    // The rendered rows, QUOTED — the platform's own verdicts at the platform's own grain. NO
    // `key`, and that is the type doing the work: `key` is what `needs:` references, and a
    // rendering is not referenceable — nothing may declare an edge to one. Reachable only by
    // containment under a declared anchor, which keeps the causal graph exactly as big as the
    // producer declared it.
    for (const row of rendered) {
        joined.push({ key: '', display: row.name, needs: [], conclusion: row.conclusion });
    }
    return joined;
}

// `$GITHUB_WORKFLOW_REF` ("owner/repo/.github/workflows/ci.yml@refs/…") → the in-repo workflow
// file path. `github.context.workflow` is the display name, which is not addressable. Null when
// the value is not of that shape (a source that cannot answer declares nothing).
function workflowPathFromRef(workflowRef: string): string | null {
    const at = workflowRef.lastIndexOf('@refs/');
    if (at < 0) return null;
    const withOwner = workflowRef.slice(0, at);
    const path = withOwner.split('/').slice(2).join('/');
    return path || null;
}

// A commit id as git spells it: SHA-1 (40 hex) or SHA-256 (64 hex). A branch or tag name is
// refused, because the contents API would resolve it to wherever the name points NOW.
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// The two runner variables that name the workflow file a run executed. Passed as the runner
// sets them (`process.env`), so no caller can substitute a ref of its own choosing.
export interface RunnerWorkflowEnv {
    readonly GITHUB_WORKFLOW_REF?: string | undefined;
    readonly GITHUB_WORKFLOW_SHA?: string | undefined;
}

// The file to read and the commit to read it at, or the reason neither can be named.
export type WorkflowCoordinate =
    | { readonly kind: 'executed'; readonly path: string; readonly sha: string }
    | { readonly kind: 'refused'; readonly reason: string };

// WHICH declaration the fold may follow, placed where a test executes it (DN-118.D1). It lived in
// main.ts until 2026-09-27, read a PR's workflow at `base.sha`, and no test ran it.
//
// The runner is the one declarer of the executed file: `GITHUB_WORKFLOW_REF` names its path and
// `GITHUB_WORKFLOW_SHA` the commit it was loaded from. On `pull_request` that commit is the PR's
// MERGE commit, which carries every edit the PR makes to the workflow, from a fork too; on
// `pull_request_target` it is the base. No ref from the event payload is used, on any event:
// `pull_request.base.sha` names a file that did not run on `pull_request`, `head.sha` is not the
// merge commit either, and `github.context.sha` is right on `push` and wrong elsewhere. A second
// declarer that agrees on some events is how the base read shipped.
//
// The executed file is also the TRUSTED one, on every event. The threat is a declaration that did
// not run steering the report's fold. On the file that did run, a contributor controls nothing
// beyond the run they authored: the jobs, their names, their `needs:` and every log byte Sift reads
// come from that same file. So there is no second, "safer" ref — reading the base on a PR is the
// threat itself, not a defence against it.
//
// NO FALLBACK: an absent or malformed variable refuses the coordinate, and the graph is ABSENT.
export function executedWorkflowCoordinate(env: RunnerWorkflowEnv): WorkflowCoordinate {
    const refusals: string[] = [];
    const workflowRef = env.GITHUB_WORKFLOW_REF ?? '';
    const workflowSha = env.GITHUB_WORKFLOW_SHA ?? '';
    const path = workflowRef ? workflowPathFromRef(workflowRef) : null;
    if (!workflowRef) {
        refusals.push('GITHUB_WORKFLOW_REF is absent or empty');
    } else if (!path) {
        refusals.push(`GITHUB_WORKFLOW_REF "${workflowRef}" names no workflow path`);
    }
    if (!workflowSha) {
        refusals.push('GITHUB_WORKFLOW_SHA is absent or empty');
    } else if (!COMMIT_ID.test(workflowSha)) {
        refusals.push(`GITHUB_WORKFLOW_SHA "${workflowSha}" is not a commit id`);
    }
    if (refusals.length > 0 || !path) {
        return { kind: 'refused', reason: refusals.join('; ') };
    }
    return { kind: 'executed', path, sha: workflowSha };
}

// The one log line of a `target-job` run, stated where the resolver lives because it is the same
// absent-graph family as the resolver's own lines, and the reason is the fold's, not the entry's.
export const ONE_JOB_GRAIN_NO_GRAPH_LINE =
    "Sift: no declared job graph — this run diffs one job's log, and the `needs:` fold needs rows " +
    'from two jobs.';

export interface ResolveJobGraphParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number;
    /** The executed workflow file, from `executedWorkflowCoordinate(process.env)`. */
    workflow: WorkflowCoordinate;
    info: (message: string) => void;
}

// The graph, or null = ABSENT (no flag, fold inert) with the reason logged. Never throws: the
// graph is an enrichment, and a run must not fail because its enrichment could not be acquired.
export async function resolveChangedJobGraph(
    params: ResolveJobGraphParams,
): Promise<DeclaredJobWire[] | null> {
    const { octokit, owner, repo, runId, workflow, info } = params;

    if (workflow.kind === 'refused') {
        info(
            `Sift: no declared job graph — ${workflow.reason}. The diff still runs; aggregator ` +
                'rows do not fold.',
        );
        return null;
    }
    const { path, sha } = workflow;

    let declared: DeclaredJobRecord[];
    try {
        // `contents: read` is the one permission this fetch needs; a denial lands in the catch
        // below and self-reports, because a fold that silently stopped firing reads as clean.
        const response = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref: sha,
            mediaType: { format: 'raw' },
        });
        const yaml = response.data;
        if (typeof yaml !== 'string') {
            throw new Error(`the contents API returned no raw file for ${path}`);
        }
        declared = parseWorkflowJobs(yaml);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        info(
            `Sift: no declared job graph — could not read ${path} at ${sha} ` +
                `(${message}). The diff still runs; aggregator rows do not fold.`,
        );
        return null;
    }
    // The coordinate is stated on every successful read, so a run's log says which commit its fold
    // followed — the one fact a reader needs to check a fold row against the workflow that ran.
    const edgeCount = declared.reduce((sum, job) => sum + job.needs.length, 0);
    info(
        `Sift: declared job graph read from ${path} at ${sha} (GITHUB_WORKFLOW_SHA, the commit ` +
            `this run executed): ${declared.length} jobs, ${edgeCount} \`needs:\` edges.`,
    );

    // No edge anywhere ⇒ the fold cannot fire whatever the join resolves, so the jobs listing is
    // pure cost. The declarations still travel: they are a true statement about this run, and an
    // empty-`needs:` graph is exactly the degenerate case the fold is inert on by construction.
    if (!declaresAnEdge(declared)) {
        return joinDeclaredJobs(declared, []);
    }

    try {
        const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
            owner,
            repo,
            run_id: runId,
            per_page: 100,
        });
        const rendered: RenderedJob[] = jobs.map((job) => ({
            name: job.name,
            conclusion: job.conclusion ?? '',
        }));
        return joinDeclaredJobs(declared, rendered);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        info(`Sift: no declared job graph — the run's jobs listing failed (${message}).`);
        return null;
    }
}
