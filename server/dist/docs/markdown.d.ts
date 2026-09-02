/** Exported for adapters that hand-build small storage fragments (e.g. the
 *  Confluence release-stamp footer). */
export declare function escapeHtml(s: string): string;
export declare function markdownToStorage(md: string, images?: Map<string, string>): string;
