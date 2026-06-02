// The `sift` binary version this Action downloads as a release asset
// (sift_action_contract.md §7). It tracks the workspace release baseline — the
// pin-coherence gate's INV-8 asserts SIFT_VERSION == baseline so the Action can
// never silently ship pointing at a stale or absent binary release.
//
// Bump this in lockstep with the coordinated version cut (it is exactly the
// CR_PIN-class CI-vendoring pin the gate guards, applied to the Action).
export const SIFT_VERSION = '1.4.2';
