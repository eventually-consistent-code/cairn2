import type { McpServer } from "@modelcontextprotocol/server";
import type { PhaseInfo } from "../planning/status.js";
/**
 * The server's first resources surface (#99): read-only plan artifacts as
 * cairn:// URIs, so non-Claude harnesses can read project state without a
 * tool round-trip. Four fixed URIs -- roadmap, the ACTIVE phase's PLAN.md
 * and CONTEXT.md, and the outlook mirror snapshot.
 *
 * Every read resolves the project dir fresh through the injected `dir()`
 * (workspace focus can move mid-session, same rule as the tools), and a
 * missing file reads as friendly placeholder text -- a browsing client
 * must never see a thrown error just because a project hasn't scaffolded
 * plans yet.
 */
/**
 * The phase a read of cairn://plans/active-phase/* serves: the ActiveContext
 * phase when set (and scaffolded), else the lowest unverified phase, else
 * the highest phase (everything verified). Null only when no phases exist.
 */
export declare function resolveActivePhase(projectDir: string): PhaseInfo | null;
export declare function registerPlanResources(server: McpServer, dir: () => string): void;
