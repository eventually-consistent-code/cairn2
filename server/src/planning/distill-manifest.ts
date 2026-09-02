// Purpose: per-phase distill manifest -- the scope contract for an
//   incremental `distill <N>` run. Resolves one phase (live under phases/ or
//   archived under milestones/vN), reads its PLAN.md issue list, and parses
//   its LEDGER.md lines back into structured entries so synthesis covers ONLY
//   what that phase actually changed. The line grammar here mirrors
//   ledger.ts's formatEntry exactly -- the ledger is append-only and stable,
//   so an honest parse is a safe parse. Malformed lines are skipped with a
//   note, never guessed at.
// Author(s): John Reed

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import {
  PHASE_NUMBER_ERROR, isValidPhaseNumber, parsePhaseDirName, plansRoot,
} from "./artifacts.js";
import { parsePlanDoc } from "./frontmatter.js";
import { projectStatus } from "./status.js";

export interface DistillLedgerEntry {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  closedDate: string;
}

export interface DistillManifest {
  /** `dir` is the phase's path relative to the plans root minus the live
   *  "phases/" prefix -- "01-core" live, "milestones/v1/01-core" archived --
   *  the same id convention docs-drift reports use. */
  phase: { number: number; name: string; dir: string; archived: boolean };
  issues: string[];
  ledgerEntries: DistillLedgerEntry[];
  /** Union range the ledger lines span: first entry's base to last entry's
   *  head (the ledger is append-only, so file order IS chronological order).
   *  Null when the ledger has no parsed entries. */
  commitRange: { base: string; head: string } | null;
  /** One note per ledger line that LOOKED like an entry but didn't match the
   *  writer's grammar -- surfaced, not silently dropped. */
  skipped: string[];
}

// The exact shape ledger.ts formatEntry writes -- em dashes and all:
//   - [x] <taskRef> — <summary> — commits <base7>..<head7> — [tdd <r>..<g> — ]<issueId> closed <date>
// taskRef and summary match lazily so the "commits <sha>..<sha>" anchor, not
// an em dash inside a summary, decides where the fields end.
const LEDGER_LINE_RE = new RegExp(
  "^- \\[x\\] (.+?) — (.+?) — commits ([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40}) — "
  + "(?:tdd [0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40} — )?(.+?) closed (.+)$",
);

interface ResolvedPhase {
  number: number; name: string; dir: string; archived: boolean; base: string;
}

// Live phases win; among archived copies (a number can recur across
// milestones) the newest vN wins -- that's the copy summit archived last.
function resolvePhase(projectDir: string, phaseNumber: number): ResolvedPhase {
  const root = plansRoot(projectDir);
  const live = projectStatus(projectDir).phases
    .find((p) => p.number === phaseNumber);
  if (live) {
    return {
      number: live.number, name: live.name, dir: live.dir, archived: false,
      base: join(root, "phases", live.dir),
    };
  }
  const msDir = join(root, "milestones");
  if (existsSync(msDir)) {
    const versions = readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    for (const v of versions) {
      for (const entry of readdirSync(join(msDir, v))) {
        const parsed = parsePhaseDirName(entry);
        if (!parsed || parsed.number !== phaseNumber) continue;
        return {
          number: parsed.number,
          name: parsed.slug.replace(/-/g, " "),
          dir: join("milestones", v, entry),
          archived: true,
          base: join(msDir, v, entry),
        };
      }
    }
  }
  throw new CairnError("NOT_FOUND",
    `no phase ${phaseNumber} under .cairn/plans/phases or .cairn/plans/milestones`,
    "run plan_status to list live phases, or check milestones/vN for archived ones");
}

// PLAN.md frontmatter issues at an arbitrary phase dir -- readPlanIssues
// hardcodes the live phases/ path, and archived plans live elsewhere.
function planIssuesAt(base: string): string[] {
  const path = join(base, "PLAN.md");
  if (!existsSync(path)) return [];
  return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
}

function parseLedger(base: string): {
  entries: DistillLedgerEntry[]; skipped: string[];
} {
  const entries: DistillLedgerEntry[] = [];
  const skipped: string[] = [];
  const path = join(base, "LEDGER.md");
  if (!existsSync(path)) return { entries, skipped };
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    // Only list lines are candidate entries; the header and the append-only
    // comment are the file's own furniture.
    if (!line.startsWith("- ")) continue;
    const m = LEDGER_LINE_RE.exec(line);
    if (!m) {
      skipped.push(`LEDGER.md line ${i + 1} does not match the ledger entry `
        + `format -- skipped: ${line.slice(0, 120)}`);
      continue;
    }
    entries.push({
      taskRef: m[1], summary: m[2], baseCommit: m[3], headCommit: m[4],
      issueId: m[5], closedDate: m[6],
    });
  }
  return { entries, skipped };
}

/**
 * Assemble the distill manifest for one phase: its PLAN.md issues, its
 * LEDGER.md entries (each carrying the commit range the task landed as), and
 * the union commit range those entries span. Pure filesystem reads -- no git,
 * no tracker, no LLM judgment; same repo state, same manifest.
 *
 * :param projectDir: project root (the dir holding .cairn/)
 * :param phaseNumber: phase number, integer or one-decimal (1, 1.5, ...)
 * :returns DistillManifest scoped to exactly what the phase changed
 * :throws CairnError CONFIG_INVALID for a malformed phase number,
 *   NOT_FOUND when no live or archived phase dir carries that number
 */
export function distillManifest(projectDir: string,
  phaseNumber: number): DistillManifest {
  if (!isValidPhaseNumber(phaseNumber)) {
    throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(phaseNumber));
  }
  const phase = resolvePhase(projectDir, phaseNumber);
  const { entries, skipped } = parseLedger(phase.base);
  const commitRange = entries.length === 0 ? null : {
    base: entries[0].baseCommit,
    head: entries[entries.length - 1].headCommit,
  };
  return {
    phase: {
      number: phase.number, name: phase.name,
      dir: phase.dir, archived: phase.archived,
    },
    issues: planIssuesAt(phase.base),
    ledgerEntries: entries,
    commitRange,
    skipped,
  };
}
