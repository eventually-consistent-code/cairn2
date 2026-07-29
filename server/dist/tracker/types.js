import { CairnError } from "../errors.js";
/** List-filter semantics after the widening: a state filter matches by
 *  semantic category OR by exact display name. */
export function matchesState(issue, state) {
    return issue.category === state || issue.state === state;
}
/** Guard for backends with NO custom-state surface — anything beyond the
 *  canonical three is a config error there, never a silent no-op. */
export function assertCanonicalState(state, backend) {
    if (state === undefined)
        return;
    if (state === "open" || state === "in_progress" || state === "closed")
        return;
    throw new CairnError("CONFIG_INVALID", `${backend} has no custom-state surface — unknown state '${state}'`, "use open/in_progress/closed on this backend");
}
