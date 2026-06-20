// The `sift` ENGINE-BINARY version this Action downloads as a release asset
// (sift_action_contract.md §7). This is the engine pin, NOT the Action's own
// version: it tracks the latest PUBLISHED engine, which is at or behind the open
// dev baseline — never AHEAD of it (the engine-v<X> release for a not-yet-cut X
// cannot exist, so the Action would 404). The pin-coherence gate's INV-8 asserts
// SIFT_VERSION <= baseline, and scripts/verify_sift_engine_asset.sh asserts the
// engine-v<SIFT_VERSION> release asset actually exists — together the Action can
// never silently ship pointing at a stale or absent binary release.
//
// The Action's CONSUMER version (package.json + the floating @v1 / @vX tag that
// `uses: CodeRoasted/sift-action@…` resolves) is a SEPARATE, independent SemVer
// line that debuts at 1.0.0 — do NOT conflate the two numbers. Bump THIS to the
// latest published engine when cutting an Action release; bump package.json on the
// Action wrapper's own release cadence.
export const SIFT_VERSION = '1.5.5';
