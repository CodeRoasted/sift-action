// The CHANGED run's declared `needs:` job graph — this Action's producer of the DN-37.D18
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
// FAIL-SOFT BY DESIGN, and absent ≠ empty: every acquisition failure (no workflow ref, an
// unreadable file, a denied `contents: read`, a failed jobs listing) resolves to ABSENT — no flag,
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

// The DN-37.D18 wire entry. ALL FOUR FIELDS ALWAYS TRAVEL — `key` and `display` are required by
// the engine and never defaulted from each other (a graph keyed on the wrong coordinate folds
// nothing and reads exactly like a clean run); empty strings are first-class statements, not
// omissions.
export interface DeclaredJobWire {
    key: string;
    display: string;
    needs: string[];
    conclusion: string;
}

// The reusable-workflow rendering separator (DN-37.D14 — cited, never restated; the grammar's
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
        // one would make us the author of a verdict the platform did not state (DN-37.D16 — the
        // refusal stands; the fan-out's verdicts travel below at the grain the platform declared
        // them). Empty is NOT DECLARED (DN-32.D7) — a third state, and the honest one.
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
// file path. The one runner-provided coordinate that names WHICH file this run executed —
// `github.context.workflow` is the display name, which is not addressable. Null when the variable
// is absent or not of that shape (a source that cannot answer declares nothing).
export function workflowPathFromRef(workflowRef: string | undefined): string | null {
    if (!workflowRef) return null;
    const at = workflowRef.lastIndexOf('@refs/');
    if (at < 0) return null;
    const withOwner = workflowRef.slice(0, at);
    const path = withOwner.split('/').slice(2).join('/');
    return path || null;
}

export interface ResolveJobGraphParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number;
    /** `process.env.GITHUB_WORKFLOW_REF` — names the workflow file this run executed. */
    workflowRef: string | undefined;
    /**
     * The ref the workflow YAML is read at — the TRUSTED one, chosen by the caller (main.ts
     * states the DN-37.D7 trust argument where the choice is made).
     */
    contentRef: string;
    info: (message: string) => void;
}

// The graph, or null = ABSENT (no flag, fold inert) with the reason logged. Never throws: the
// graph is an enrichment, and a run must not fail because its enrichment could not be acquired.
export async function resolveChangedJobGraph(
    params: ResolveJobGraphParams,
): Promise<DeclaredJobWire[] | null> {
    const { octokit, owner, repo, runId, workflowRef, contentRef, info } = params;

    const path = workflowPathFromRef(workflowRef);
    if (!path) {
        info('Sift: no declared job graph — GITHUB_WORKFLOW_REF is absent or names no workflow path.');
        return null;
    }

    let declared: DeclaredJobRecord[];
    try {
        // `contents: read` is the one permission this fetch needs; a denial lands in the catch
        // below and self-reports, because a fold that silently stopped firing reads as clean.
        const response = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref: contentRef,
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
            `Sift: no declared job graph — could not read ${path}@${contentRef.slice(0, 12)} ` +
                `(${message}). The \`needs:\` fold needs \`contents: read\`; without it the diff ` +
                'still runs, aggregator rows just do not fold.',
        );
        return null;
    }

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
