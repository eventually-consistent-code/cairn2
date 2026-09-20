/**
 * Rent per unit of delivered work.
 *
 * The obvious denominator -- whatever issue the active-context tag named when
 * a session stopped -- covers 7 of 33 recorded sessions and 4 distinct issues
 * in total. So work is counted from durable timestamped facts instead: issues
 * the tracker closed and commits the repo landed, joined to the session spans
 * they fall inside. Nothing here fetches; callers supply both lists, which is
 * what makes it testable without a tracker or a git repo.
 */

export interface SessionSpan {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  /** cache_read tokens this session paid -- the `ctx_sum` metrics field. */
  rent: number;
}

export interface WorkItem {
  id: string;
  closedAt: string;
  kind: "issue" | "commit";
}

export interface ItemRent {
  id: string;
  kind: "issue" | "commit";
  rent: number;
  sessions: string[];
}

export interface RentAttribution {
  items: ItemRent[];
  /** Rent from sessions that closed nothing -- overhead, not free. */
  unclaimedRent: number;
  /** Items closed inside no session span; reported, never silently dropped. */
  orphanItems: string[];
  rentPerItem: number;
}

/** Epoch ms, or null when the stamp cannot be trusted. */
function stamp(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * An item is attributed to every session whose span contains its close, and a
 * session's rent divides evenly among the items it closed. A session spanning
 * two closes therefore contributes half its rent to each; an item closed
 * during two overlapping sessions carries rent from both. Double-counting
 * across overlapping sessions is deliberate -- both sessions really did pay.
 *
 * :param spans: session spans with their rent
 * :param items: work items with close timestamps
 * :returns attribution with unclaimed rent and orphans reported separately
 */
export function attributeRent(spans: SessionSpan[], items: WorkItem[]): RentAttribution {
  // An issue and the commit that closed it are one delivery, not two. Issue
  // wins: it is the unit the tracker -- and the human -- counts in.
  const byId = new Map<string, WorkItem>();
  for (const it of items) {
    const prior = byId.get(it.id);
    if (!prior || (prior.kind === "commit" && it.kind === "issue")) byId.set(it.id, it);
  }

  const claimed = new Map<string, { item: WorkItem; sessions: string[] }>();
  const orphanItems: string[] = [];

  for (const it of byId.values()) {
    const at = stamp(it.closedAt);
    const sessions = at === null ? [] : spans
      .filter((s) => {
        const from = stamp(s.startedAt);
        const to = stamp(s.endedAt);
        return from !== null && to !== null && at >= from && at <= to;
      })
      .map((s) => s.sessionId);
    if (sessions.length === 0) orphanItems.push(it.id);
    else claimed.set(it.id, { item: it, sessions });
  }

  const countBySession = new Map<string, number>();
  for (const { sessions } of claimed.values()) {
    for (const s of sessions) countBySession.set(s, (countBySession.get(s) ?? 0) + 1);
  }

  const rentBySession = new Map(spans.map((s) => [s.sessionId, s.rent]));
  const items_: ItemRent[] = [...claimed.values()].map(({ item, sessions }) => ({
    id: item.id,
    kind: item.kind,
    rent: sessions.reduce(
      (sum, s) => sum + (rentBySession.get(s) ?? 0) / (countBySession.get(s) ?? 1), 0),
    sessions,
  }));

  const unclaimedRent = spans
    .filter((s) => !countBySession.has(s.sessionId))
    .reduce((sum, s) => sum + s.rent, 0);

  const totalAttributed = items_.reduce((sum, i) => sum + i.rent, 0);
  return {
    items: items_,
    unclaimedRent,
    orphanItems,
    rentPerItem: items_.length === 0 ? 0 : totalAttributed / items_.length,
  };
}
