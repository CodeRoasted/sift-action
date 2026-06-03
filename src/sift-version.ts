// The `sift` ENGINE-BINARY version this Action downloads as a release asset
// (sift_action_contract.md §7). This is the engine pin, NOT the Action's own
// version: it tracks the workspace platform baseline so the downloaded binary
// always matches the engine the cut shipped, and the pin-coherence gate's INV-8
// asserts SIFT_VERSION == baseline so the Action can never silently ship pointing
// at a stale or absent binary release.
//
// The Action's CONSUMER version (package.json + the floating @v1 / @vX tag that
// `uses: CodeRoasted/sift-action@…` resolves) is a SEPARATE, independent SemVer
// line that debuts at 1.0.0 — do NOT conflate the two numbers. Bump THIS in
// lockstep with the coordinated platform cut (the CR_PIN-class vendoring pin the
// gate guards); bump package.json on the Action wrapper's own release cadence.
export const SIFT_VERSION = '1.4.2';
