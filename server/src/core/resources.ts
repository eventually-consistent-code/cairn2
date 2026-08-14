import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { ActiveContext } from "../active-context.js";
import { plansRoot } from "../planning/artifacts.js";
import { projectStatus } from "../planning/status.js";
import type { PhaseInfo } from "../planning/status.js";
import { readOutlook } from "./outlook.js";

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
export function resolveActivePhase(projectDir: string): PhaseInfo | null {
  const { phases } = projectStatus(projectDir);
  if (phases.length === 0) return null;
  const active = new ActiveContext(projectDir).get().phase;
  if (active !== undefined) {
    const match = phases.find((p) => p.number === active);
    if (match) return match;
  }
  return phases.find((p) => !p.hasVerification) ?? phases[phases.length - 1];
}

/** One text content block -- the shape every resource here serves. */
const text = (uri: URL, body: string, mimeType: string) => ({
  contents: [{ uri: uri.href, text: body, mimeType }],
});

/** Reads a plan artifact, or a placeholder when it isn't there yet. */
function readOr(path: string, placeholder: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : placeholder;
}

export function registerPlanResources(
  server: McpServer,
  dir: () => string,
): void {
  server.registerResource(
    "roadmap",
    "cairn://plans/roadmap",
    {
      title: "Project roadmap",
      description:
        "The project's phase roadmap (.cairn/plans/roadmap.md), read-only.",
      mimeType: "text/markdown",
    },
    async (uri) =>
      text(
        uri,
        readOr(
          join(plansRoot(dir()), "roadmap.md"),
          "no roadmap yet — scaffold one with plan_scaffold_project.",
        ),
        "text/markdown",
      ),
  );

  // The two active-phase artifacts share the same phase resolution; only the
  // filename differs, so both registrations come off this one helper.
  const activePhaseFile = (uri: URL, file: "PLAN.md" | "CONTEXT.md") => {
    const d = dir();
    const phase = resolveActivePhase(d);
    if (!phase) {
      return text(
        uri,
        "no phases scaffolded — create one with plan_scaffold_phase.",
        "text/markdown",
      );
    }
    return text(
      uri,
      readOr(
        join(plansRoot(d), "phases", phase.dir, file),
        `no ${file} for phase ${phase.number} (${phase.dir}) yet.`,
      ),
      "text/markdown",
    );
  };

  server.registerResource(
    "active-phase-plan",
    "cairn://plans/active-phase/plan",
    {
      title: "Active phase plan",
      description:
        "PLAN.md for the active phase (active context when set, else the " +
        "lowest unverified phase), read-only.",
      mimeType: "text/markdown",
    },
    async (uri) => activePhaseFile(uri, "PLAN.md"),
  );

  server.registerResource(
    "active-phase-context",
    "cairn://plans/active-phase/context",
    {
      title: "Active phase context",
      description:
        "CONTEXT.md for the active phase (active context when set, else the " +
        "lowest unverified phase), read-only.",
      mimeType: "text/markdown",
    },
    async (uri) => activePhaseFile(uri, "CONTEXT.md"),
  );

  server.registerResource(
    "outlook-snapshot",
    "cairn://outlook/snapshot",
    {
      title: "Outlook snapshot",
      description:
        "The project's outlook mirror snapshot (phases, sessions, tracker " +
        "rollup) as JSON, read-only.",
      mimeType: "application/json",
    },
    async (uri) => {
      const snapshot = readOutlook(dir());
      if (!snapshot) {
        return text(
          uri,
          "no snapshot yet — any write-through tool call emits one.",
          "text/plain",
        );
      }
      return text(uri, JSON.stringify(snapshot, null, 2), "application/json");
    },
  );
}
