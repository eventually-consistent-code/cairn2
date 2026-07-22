import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ActiveContext, type ActiveContextState } from "../active-context.js";
import { loadConfig } from "../config.js";
import { bannerPath } from "../core/continuity.js";
import { lastSessionEntry, listSessions } from "../sessions/store.js";
import { listCards, type Card } from "./cards.js";

/** Fetch cost is computed fresh at render time -- never stored on the card. */
function fetchCost(body: string): number {
  return Math.ceil(body.length / 4);
}

/** First line of the card body, trimmed and capped at 60 chars. */
function titleFor(body: string): string {
  const firstLine = (body.split("\n")[0] ?? "").trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

const byId = (a: Card, b: Card): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Buckets cards by scope-tightness against the active context: issue-scoped
 * cards that match the active issue, then phase-scoped cards that match the
 * active phase, then unscoped (project-wide) cards. A card scoped to a
 * *different* issue/phase than the active one is out of scope entirely --
 * it doesn't fall through to a looser bucket. Each bucket is sorted by id
 * for a deterministic, byte-stable tiebreak.
 */
function scopedCards(cards: Card[], active: ActiveContextState): Card[] {
  const issueCards: Card[] = [];
  const phaseCards: Card[] = [];
  const projectCards: Card[] = [];
  for (const card of cards) {
    const { scopeIssue, scopePhase } = card.frontmatter;
    if (scopeIssue !== undefined) {
      if (active.issueId !== undefined && scopeIssue === active.issueId) issueCards.push(card);
    } else if (scopePhase !== undefined) {
      if (active.phase !== undefined && scopePhase === String(active.phase)) phaseCards.push(card);
    } else {
      projectCards.push(card);
    }
  }
  issueCards.sort(byId);
  phaseCards.sort(byId);
  projectCards.sort(byId);
  return [...issueCards, ...phaseCards, ...projectCards];
}

interface BannerData {
  /** Rendered banner markdown, or null when disabled/no cards and no open sessions. */
  text: string | null;
  /** Sum of per-card fetch costs for the cards actually included in the banner. */
  cardCostTotal: number;
}

/** Shared render + stats core so renderBanner and bannerStats never drift on scoping logic. */
function computeBannerData(projectDir: string): BannerData {
  const { continuity } = loadConfig(projectDir);
  const { enabled, maxCards } = continuity.recallIndex;
  if (!enabled) return { text: null, cardCostTotal: 0 };

  const active = new ActiveContext(projectDir).get();
  const cards = scopedCards(listCards(projectDir), active).slice(0, maxCards);
  const open = (["trace", "probe", "draft", "thread"] as const)
    .flatMap((kind) => listSessions(projectDir, kind, "open"));
  if (cards.length === 0 && open.length === 0) return { text: null, cardCostTotal: 0 };

  const project = basename(resolve(projectDir));
  const headerParts = [`cairn recall index — ${project}`];
  if (active.phase !== undefined) headerParts.push(`phase ${active.phase}`);
  if (active.issueId !== undefined) headerParts.push(active.issueId);

  const lines = [`## ${headerParts.join(" / ")}`];
  let cardCostTotal = 0;

  if (cards.length > 0) {
    const rows = cards.map((card) => {
      const type = card.frontmatter.confidence
        ? `${card.frontmatter.type} (${card.frontmatter.confidence})`
        : card.frontmatter.type;
      return `| ${card.id} | ${type} | ${titleFor(card.body)} | ~${fetchCost(card.body)} tok |`;
    });
    cardCostTotal = cards.reduce((sum, card) => sum + fetchCost(card.body), 0);
    lines.push(
      "| id | type | title | fetch cost |",
      "|----|------|-------|-----------|",
      ...rows,
      `Fetch bodies on demand with mem_card_recall(id). Total if fetched: ~${cardCostTotal} tok.`,
    );
  }

  if (open.length > 0) {
    lines.push("", "open sessions:");
    for (const s of open) {
      const last = lastSessionEntry(projectDir, s.kind, s.id) ?? "none";
      lines.push(`- ${s.kind} ${s.id} — ${s.description} — issue ${s.issue} — since ${s.created} — last: ${last}`);
    }
  }

  return { text: `${lines.join("\n")}\n`, cardCostTotal };
}

/**
 * Renders the recall banner for `projectDir`: cards scoped issue > phase >
 * project (id tiebreak), capped at `recallIndex.maxCards`, followed by an
 * "open sessions:" section (sorted kind trace/probe/draft/thread, then id) when any
 * open sessions exist -- the banner is non-null if either cards or open
 * sessions are present. Byte-stable -- no timestamps beyond the dates already
 * in session frontmatter, no volatile ordering; bytes change only when the
 * card/session store or active context changes. Returns null (and deletes any
 * existing banner file) when `recallIndex.enabled` is false or there is
 * nothing to render.
 */
export function renderBanner(projectDir: string): string | null {
  const { text } = computeBannerData(projectDir);
  if (text === null) {
    const path = bannerPath(projectDir);
    if (existsSync(path)) unlinkSync(path);
  }
  return text;
}

/**
 * Writes (or clears) the pre-rendered banner cache. Best-effort, same
 * swallow rule as continuity's refreshHandoff -- the recall index is a
 * convenience cache, never authority, so a write failure (unwritable
 * ~/.cairn/banner, unregistered project, bad config) must never fail the
 * primary tool call that triggered it.
 */
export function writeBanner(projectDir: string): void {
  try {
    const text = renderBanner(projectDir);
    if (text === null) return;
    const path = bannerPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  } catch {
    // swallowed by design -- see comment above.
  }
}

/**
 * Token accounting for mem_stats: `bannerTokens` is the cost of the banner
 * itself; `tokensSavedVsFullInjection` is the sum of the scoped cards'
 * individual fetch costs minus that banner cost (floored at 0), i.e. what
 * fetching the pre-rendered index costs vs. injecting every card in full.
 * Best-effort like writeBanner -- mem_stats must keep working (reporting
 * zeros) for an unregistered project or any other config/read failure.
 */
export function bannerStats(projectDir: string): { bannerTokens: number; tokensSavedVsFullInjection: number } {
  try {
    const { text, cardCostTotal } = computeBannerData(projectDir);
    if (text === null) return { bannerTokens: 0, tokensSavedVsFullInjection: 0 };
    const bannerTokens = fetchCost(text);
    return { bannerTokens, tokensSavedVsFullInjection: Math.max(0, cardCostTotal - bannerTokens) };
  } catch {
    return { bannerTokens: 0, tokensSavedVsFullInjection: 0 };
  }
}
