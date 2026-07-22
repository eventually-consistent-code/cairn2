/**
 * Renders the recall banner for `projectDir`: cards scoped issue > phase >
 * project (id tiebreak), capped at `recallIndex.maxCards`, followed by an
 * "open sessions:" section (sorted kind trace/probe/draft, then id) when any
 * open sessions exist -- the banner is non-null if either cards or open
 * sessions are present. Byte-stable -- no timestamps beyond the dates already
 * in session frontmatter, no volatile ordering; bytes change only when the
 * card/session store or active context changes. Returns null (and deletes any
 * existing banner file) when `recallIndex.enabled` is false or there is
 * nothing to render.
 */
export declare function renderBanner(projectDir: string): string | null;
/**
 * Writes (or clears) the pre-rendered banner cache. Best-effort, same
 * swallow rule as continuity's refreshHandoff -- the recall index is a
 * convenience cache, never authority, so a write failure (unwritable
 * ~/.cairn/banner, unregistered project, bad config) must never fail the
 * primary tool call that triggered it.
 */
export declare function writeBanner(projectDir: string): void;
/**
 * Token accounting for mem_stats: `bannerTokens` is the cost of the banner
 * itself; `tokensSavedVsFullInjection` is the sum of the scoped cards'
 * individual fetch costs minus that banner cost (floored at 0), i.e. what
 * fetching the pre-rendered index costs vs. injecting every card in full.
 * Best-effort like writeBanner -- mem_stats must keep working (reporting
 * zeros) for an unregistered project or any other config/read failure.
 */
export declare function bannerStats(projectDir: string): {
    bannerTokens: number;
    tokensSavedVsFullInjection: number;
};
