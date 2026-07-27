// Dependency-graph computations over the tracker SPI's Issue + IssueLink
// shapes. Pure functions — no filesystem, no backend coupling — so any
// adapter with hasDependencies (local first) gets these features for free.
// Scale assumption: a project tracker is thousands of nodes, so everything
// runs in memory; there is deliberately no index or database.

import type { Issue, IssueLink } from "./types.js";

export interface PriorityEntry {
  id: string;
  declared?: string;
  effective: string;
  inheritedFrom?: string;
}

/** priority:P<n> label → n; missing/unparseable ranks weakest. */
function declaredPriority(issue: Issue): string | undefined {
  const hit = issue.labels.find((l) => /^priority:/.test(l));
  return hit?.slice("priority:".length);
}

function rank(priority: string | undefined): number {
  const m = priority && /^P(\d+)$/i.exec(priority);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Open issues with no open blockers — the pick-next-work list.
 * `A blocks B` means B waits on A; only `blocks` edges gate readiness.
 */
export function readyFrontier(issues: Issue[], links: IssueLink[]): Issue[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return issues.filter((i) => i.state === "open"
    && links.every((l) => l.type !== "blocks" || l.to !== i.id
      || byId.get(l.from)?.state === "closed"));
}

/**
 * Dependency-chain priority inheritance: an issue is effectively as urgent
 * as the most urgent OPEN work it transitively blocks. Returns only issues
 * whose effective priority beats their declared one.
 */
export function effectivePriorities(issues: Issue[], links: IssueLink[]): PriorityEntry[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const blocks = links.filter((l) => l.type === "blocks");
  const out: PriorityEntry[] = [];

  for (const i of issues) {
    if (i.state === "closed") continue;
    // walk everything i transitively blocks, tracking the strongest priority
    let best = { rank: rank(declaredPriority(i)), from: undefined as string | undefined };
    const seen = new Set<string>([i.id]);
    const stack = blocks.filter((l) => l.from === i.id).map((l) => l.to);
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = byId.get(cur);
      if (!node || node.state === "closed") continue;
      const r = rank(declaredPriority(node));
      if (r < best.rank) best = { rank: r, from: cur };
      for (const l of blocks) if (l.from === cur) stack.push(l.to);
    }
    if (best.from !== undefined) {
      out.push({
        id: i.id,
        declared: declaredPriority(i),
        effective: declaredPriority(byId.get(best.from)!)!,
        inheritedFrom: best.from,
      });
    }
  }
  return out;
}

/**
 * Iteration lineage through `supersedes` edges, oldest → newest.
 * `A supersedes B` means A is the next iteration of B.
 */
export function lineage(issues: Issue[], links: IssueLink[], id: string): string[] {
  const sup = links.filter((l) => l.type === "supersedes");
  const older = (of: string) => sup.find((l) => l.from === of)?.to;
  const newer = (of: string) => sup.find((l) => l.to === of)?.from;

  const chain = [id];
  const seen = new Set(chain);
  for (let cur = older(id); cur !== undefined && !seen.has(cur); cur = older(cur)) {
    chain.unshift(cur);
    seen.add(cur);
  }
  for (let cur = newer(id); cur !== undefined && !seen.has(cur); cur = newer(cur)) {
    chain.push(cur);
    seen.add(cur);
  }
  return chain;
}

/** Links whose endpoints no longer exist — medic's repair list. */
export function danglingEdges(issues: Issue[], links: IssueLink[]): IssueLink[] {
  const ids = new Set(issues.map((i) => i.id));
  return links.filter((l) => !ids.has(l.from) || !ids.has(l.to));
}
