import { CairnError } from "../errors.js";
export function milestonesUnsupported(backend) {
    throw new CairnError("UNSUPPORTED", `${backend} adapter has no native milestone mapping yet`, "summit falls back to phase-close + git archive on this backend");
}
export function phaseCloseUnsupported(backend) {
    throw new CairnError("UNSUPPORTED", `${backend} phase primitive has no closed state`, "milestone_complete records this as a skipped phase close");
}
