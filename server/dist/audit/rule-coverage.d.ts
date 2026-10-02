/**
 * Purpose: the mechanical half of `audit security --surface`'s
 *   rule-to-control coverage check (#207). Finds every imperative rule line
 *   ("never", "do not", "must", "always") in the prose an agent is told to
 *   obey — CLAUDE.md, AGENTS.md, verb files, hook prose — and enumerates
 *   every deterministic control that exists to back one: registered hooks,
 *   permission deny/ask rules, server-side refusals, guard scripts, git
 *   hooks, CI workflows. Then it pairs each rule with its candidate controls
 *   by token overlap and names the control type that would most plausibly
 *   back it.
 *
 *   It never decides that a control ACTUALLY backs a rule — that is the
 *   auditing agent's judgment, made in the verb prose. A rule with no
 *   candidate is reported `uncovered`; a rule with candidates is reported
 *   `candidate` for the agent to confirm or reject.
 *
 *   Pure library, no tool surface (same precedent as dedupFindings): the
 *   verb runs it via node against dist. Read-only and deterministic: it
 *   reads a fixed set of paths under the scanned root, never follows a
 *   symlink out of that root, skips oversized files, and treats everything
 *   it reads as data — rule text is quoted back, never interpreted.
 * Author(s): John Reed
 */
export declare const MAX_FILE_BYTES: number;
export declare const MAX_RULE_CHARS = 240;
export declare const MAX_CANDIDATES = 3;
export declare const MIN_SHARED_TOKENS = 2;
export type RulePolarity = "prohibition" | "obligation";
export type RuleSourceKind = "instructions" | "verb" | "hook-prose";
/** One imperative sentence an agent is told to obey. */
export interface RuleLine {
    /** Root-relative POSIX path. */
    file: string;
    /** 1-based line the imperative keyword sits on. */
    line: number;
    /** The sentence, whitespace-collapsed and clipped. */
    text: string;
    /** The keyword that made it a rule (lowercased). */
    keyword: string;
    polarity: RulePolarity;
    sourceKind: RuleSourceKind;
}
export type ControlType = "hook" | "permission-deny" | "permission-ask" | "server-gate" | "guard-script" | "git-hook" | "ci-workflow";
/** One deterministic mechanism that can refuse or fail something. */
export interface Control {
    type: ControlType;
    /** Stable, human-readable id (e.g. `PreToolUse[Bash] pretooluse-leakguard.mjs`). */
    id: string;
    /** Root-relative POSIX path of the file that declares it. */
    source: string;
    /** What it does, as best the declaration says (matcher + command, deny rule, error codes). */
    detail: string;
    /** Lowercased tokens the matcher pairs rules against. */
    tokens: string[];
}
export interface RuleCandidate {
    controlId: string;
    type: ControlType;
    /** Distinct tokens the rule and the control share. */
    shared: string[];
}
export interface RuleCoverage {
    rule: RuleLine;
    /** `uncovered`: no control shares enough vocabulary to even be a candidate. */
    status: "uncovered" | "candidate";
    candidates: RuleCandidate[];
    /** The control type that would most plausibly back this rule. */
    nearestControlType: ControlType;
}
export interface SkippedPath {
    path: string;
    reason: "too-large" | "outside-root" | "unparseable" | "unreadable";
}
export interface RuleCoverageReport {
    root: string;
    rules: RuleLine[];
    controls: Control[];
    coverage: RuleCoverage[];
    skipped: SkippedPath[];
    summary: {
        rules: number;
        controls: number;
        uncovered: number;
        candidate: number;
        controlsByType: Partial<Record<ControlType, number>>;
    };
}
/**
 * Pulls imperative sentences out of markdown-ish text. Fenced code is
 * skipped (a `rm -rf` example isn't a rule); list items, table rows and
 * headings each start a new block so a sentence never spans two bullets;
 * wrapped prose lines join into one block so a rule split across lines is
 * still one rule, reported at the line its keyword sits on.
 */
export declare function extractRules(text: string, file: string, sourceKind: RuleSourceKind): RuleLine[];
/**
 * The header comment of a script — the `/** ... *\/` block or the run of
 * `//` / `#` comment lines at the top, after any shebang — with markers
 * stripped. Every other line is blanked so line numbers stay true.
 */
export declare function headerProse(text: string): string;
/** Lowercased content words, deduplicated, stopwords dropped. */
export declare function tokenize(text: string): string[];
/** Every deterministic control the root declares, in a stable order. */
export declare function enumerateControls(root: string, skipped?: SkippedPath[]): Control[];
/** Every rule the root's agent-facing prose states, in a stable order. */
export declare function collectRules(root: string, skipped?: SkippedPath[]): RuleLine[];
/** The control type that would most plausibly back a rule, by its vocabulary. */
export declare function nearestControlType(text: string): ControlType;
/** Pairs one rule with its candidate controls by shared tokens. */
export declare function pairRule(rule: RuleLine, controls: Control[]): RuleCoverage;
/**
 * The whole scan: rules, controls, pairing, summary. `root` is the repo
 * being audited — cairn itself or a user project; whatever isn't there
 * simply contributes nothing.
 */
export declare function scanRuleCoverage(root: string): RuleCoverageReport;
