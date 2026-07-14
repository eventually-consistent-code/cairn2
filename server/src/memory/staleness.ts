import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ProvenanceStatus = "unchanged" | "changed" | "deleted" | "unknown";

export function checkProvenance(projectDir: string, file: string, commit: string): ProvenanceStatus {
  // commit comes from card frontmatter -- cards are git-committed and shareable,
  // so a hostile PR could smuggle in something like "--output=some/file" here.
  // It sits in option position ahead of "--" in the execFileSync call below, so
  // refuse anything that isn't shaped like a real hex SHA before we shell out.
  if (!/^[0-9a-f]{4,40}$/i.test(commit)) return "unknown";
  if (!existsSync(join(projectDir, file))) return "deleted";
  try {
    execFileSync("git", ["diff", "--quiet", commit, "--", file], { cwd: projectDir, stdio: "ignore" });
    return "unchanged";
  } catch (e) {
    return (e as { status?: number }).status === 1 ? "changed" : "unknown";
  }
}

export interface StaleCheck {
  stale: boolean;
  reasons: string[];
}

export function checkCardStaleness(
  projectDir: string, provenance: Array<{ file: string; commit: string }>,
): StaleCheck {
  const reasons: string[] = [];
  for (const p of provenance) {
    const status = checkProvenance(projectDir, p.file, p.commit);
    if (status === "changed") reasons.push(`${p.file} changed since ${p.commit.slice(0, 7)}`);
    else if (status === "deleted") reasons.push(`${p.file} no longer exists`);
    else if (status === "unknown") reasons.push(`${p.file}: could not verify against ${p.commit.slice(0, 7)}`);
  }
  return { stale: reasons.length > 0, reasons };
}
