import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { readRoadmapMeta, patchRoadmapMeta } from "./milestones.js";

export interface OutOfBandCommit { sha: string; subject: string; files: string[] }
export interface ResyncReport {
  outOfBand: OutOfBandCommit[]; sinceSha: string | null;
  headSha: string; initialized?: boolean;
}

// Matches ledger.ts formatEntry: "… — commits abc1234..def5678 — …"
const RANGE_RE = /commits ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/;

function git(projectDir: string, args: string[]): string {
  try {
    return execFileSync("git", args,
      { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new CairnError("PRECONDITION_FAILED", `git ${args[0]} failed: ${e}`,
      "plan_resync needs a git repository with at least one commit");
  }
}

function ledgerRanges(projectDir: string): Array<{ base: string; head: string }> {
  const phasesDir = join(plansRoot(projectDir), "phases");
  const ranges: Array<{ base: string; head: string }> = [];
  if (!existsSync(phasesDir)) return ranges;
  for (const entry of readdirSync(phasesDir)) {
    const ledger = join(phasesDir, entry, "LEDGER.md");
    if (!existsSync(ledger)) continue;
    for (const line of readFileSync(ledger, "utf8").split("\n")) {
      const m = RANGE_RE.exec(line);
      if (m) ranges.push({ base: m[1], head: m[2] });
    }
  }
  return ranges;
}

export function resyncReport(projectDir: string): ResyncReport {
  const headSha = git(projectDir, ["rev-parse", "HEAD"]).trim();
  const meta = readRoadmapMeta(projectDir);
  if (!meta.lastResync) {
    // First run: initialize, never scan unbounded history.
    patchRoadmapMeta(projectDir, { lastResync: headSha });
    return { outOfBand: [], sinceSha: null, headSha, initialized: true };
  }

  const covered = new Set<string>();
  for (const r of ledgerRanges(projectDir)) {
    try {
      for (const sha of git(projectDir, ["rev-list", `${r.base}..${r.head}`])
        .split("\n").map((s) => s.trim()).filter(Boolean)) covered.add(sha);
    } catch {
      // range refers to unknown shas (rebased/gc'd) — skip it, stay honest elsewhere
    }
  }

  // \x1e separates commit records, \x1f separates sha from subject;
  // --name-only lists touched files after each record.
  const raw = git(projectDir, ["log", "--no-merges", "--format=%x1e%H%x1f%s",
    "--name-only", `${meta.lastResync}..HEAD`]);
  const outOfBand: OutOfBandCommit[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [sha, subject] = lines[0].split("\x1f");
    if (covered.has(sha)) continue;
    outOfBand.push({
      sha, subject: subject ?? "",
      files: lines.slice(1).map((l) => l.trim()).filter(Boolean),
    });
  }

  patchRoadmapMeta(projectDir, { lastResync: headSha });
  return { outOfBand, sinceSha: meta.lastResync, headSha };
}
