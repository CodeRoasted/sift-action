// The `sift` ENGINE-BINARY version this Action downloads as a release asset
// (bibles/sift_action.md §7). This is the engine pin, NOT the Action's own
// version: it tracks the latest PUBLISHED engine release. It is never hand-edited
// and never rides the workspace platform bump — the engine for a version is not
// published until that version's cut, so a bumped pin names a release that does
// not exist and 404s every consumer at download.
//
// `./bump.sh` owns this value: it reads the published engine-v* release list,
// refuses any version whose binary and .sha256 are not both live, rewrites this
// file and the Jenkins example together, and repackages dist/. ci.yml re-probes
// the asset on every push, tag and PR, so the Action can never silently ship
// pointing at a stale or absent binary release.
//
// The Action's CONSUMER version (package.json + the floating @v1 / @vX tag that
// `uses: CodeRoasted/sift-action@…` resolves) is a SEPARATE, independent SemVer
// line that debuts at 1.0.0 — do NOT conflate the two numbers. Bump THIS to the
// latest published engine when cutting an Action release; bump package.json on the
// Action wrapper's own release cadence.
export const SIFT_VERSION = '1.9.5';
