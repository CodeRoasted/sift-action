// Job-log sourcing — the zero-plumbing way to feed Sift (`target-job` input).
// Instead of tee-ing a build step into a file, a later job (`needs: <build>`)
// points Sift at the finished job by NAME; the action downloads that job's log
// from the GitHub API, strips the runner's per-line timestamps, and (optionally)
// slices the user-marked capture sections. No shell plumbing in the build job.
//
// Capture markers — plain lines the build steps emit (`echo`):
//   SIFT_CAPTURE            open an anonymous section
//   SIFT_CAPTURE <name>     open a named section (independent baseline lineages
//                           from one job: ci vs release, etc.)
//   SIFT_CAPTURE_END        close the open section
// Matching is EXACT on the whole (timestamp-stripped) line, so the runner's
// script-echo of `echo "SIFT_CAPTURE ci"` in the ##[group] header can never
// false-match. The `capture` input selects: `auto` (default — if any sections
// exist use them all, else the whole log), `off` (whole log always), or a
// section name (only that section's parts; absent ⇒ config error, fail loud).
//
// The target job must be COMPLETED (the API serves logs for finished jobs), so
// the Sift invocation lives in a job that `needs:` it — which is also what makes
// `build-status: needs.<job>.result` trivial for the caller.

import type { getOctokit } from '@actions/github';

type Octokit = ReturnType<typeof getOctokit>;

// The runner prefixes every log line with an ISO-8601 timestamp + one space.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;

export function stripRunnerTimestamps(raw: string): string[] {
    return raw.split(/\r?\n/).map((line) => line.replace(TIMESTAMP_PREFIX, ''));
}

interface CaptureSection {
    name: string; // '' for an anonymous section
    lines: string[];
}

export function extractCaptureSections(lines: string[]): CaptureSection[] {
    const sections: CaptureSection[] = [];
    let open: CaptureSection | null = null;
    for (const line of lines) {
        if (line === 'SIFT_CAPTURE' || line.startsWith('SIFT_CAPTURE ')) {
            open = { name: line.slice('SIFT_CAPTURE'.length).trim(), lines: [] };
            continue;
        }
        if (line === 'SIFT_CAPTURE_END') {
            if (open) sections.push(open);
            open = null;
            continue;
        }
        if (open) open.lines.push(line);
    }
    // An unterminated section still counts — the job may have died mid-capture,
    // and that tail is exactly what a red-build diff needs to see.
    if (open) sections.push(open);
    return sections;
}

// `capture`: 'auto' | 'off' | <section name>. Returns the log text to diff.
export function sliceJobLog(raw: string, capture: string): string {
    const lines = stripRunnerTimestamps(raw);
    const mode = capture || 'auto';
    if (mode === 'off') {
        return lines.join('\n');
    }
    const sections = extractCaptureSections(lines);
    if (mode === 'auto') {
        if (sections.length === 0) {
            return lines.join('\n');
        }
        return sections.map((section) => section.lines.join('\n')).join('\n');
    }
    const named = sections.filter((section) => section.name === mode);
    if (named.length === 0) {
        const seen = [...new Set(sections.map((s) => s.name || '(anonymous)'))];
        throw new Error(
            `capture section "${mode}" not found in the target job's log ` +
                `(sections seen: ${seen.length ? seen.join(', ') : 'none'}). ` +
                `Emit it with \`echo "SIFT_CAPTURE ${mode}"\` … \`echo "SIFT_CAPTURE_END"\`.`,
        );
    }
    return named.map((section) => section.lines.join('\n')).join('\n');
}

export interface FetchJobLogParams {
    octokit: Octokit;
    owner: string;
    repo: string;
    runId: number;
    jobName: string;
    capture: string; // 'auto' | 'off' | <section name>
}

// Resolve the job by name within THIS run and download its log. The current log
// is load-bearing (no log ⇒ no diff at all), so failures here THROW — unlike
// baseline resolution, which degrades to a cold start.
export async function fetchTargetJobLog(params: FetchJobLogParams): Promise<string> {
    const { octokit, owner, repo, runId, jobName, capture } = params;

    const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
        owner,
        repo,
        run_id: runId,
        per_page: 100,
    });
    // Exact name first; a reusable-workflow job renders as "<caller job> / <name>",
    // so fall back to a unique "…/ <name>" suffix match.
    let matches = jobs.filter((job) => job.name === jobName);
    if (matches.length === 0) {
        matches = jobs.filter((job) => job.name.endsWith(`/ ${jobName}`));
    }
    if (matches.length === 0) {
        throw new Error(
            `target-job "${jobName}" not found in this run (jobs: ${jobs.map((j) => j.name).join(', ')})`,
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `target-job "${jobName}" is ambiguous in this run (${matches.map((j) => j.name).join(' | ')}) — use the full job name`,
        );
    }
    const job = matches[0]!;
    if (job.status !== 'completed') {
        throw new Error(
            `target-job "${job.name}" has not completed (status: ${job.status}) — run Sift in a job that \`needs:\` it`,
        );
    }

    const download = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
    });
    const raw =
        typeof download.data === 'string'
            ? download.data
            : Buffer.from(download.data as ArrayBuffer).toString('utf8');
    return sliceJobLog(raw, capture);
}
