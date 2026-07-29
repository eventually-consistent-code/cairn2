export interface DocNode {
    /** Page title — first H1 in the file, else derived from the file/dir name. */
    title: string;
    /** Markdown body. Directories get an empty body; the publisher writes a TOC. */
    markdown: string;
    /** Source file/dir basename — lets filesystem backends mirror the layout. */
    sourceName: string;
    /** Local images the markdown references — ref as written + absolute path. */
    images: Array<{
        ref: string;
        path: string;
    }>;
    children: DocNode[];
}
/** Local image refs in a markdown body, resolved against baseDir — remote
 *  urls and refs that don't resolve to a real file are skipped. */
export declare function scanImages(markdown: string, baseDir: string): Array<{
    ref: string;
    path: string;
}>;
/** "0004-api-versioning" / "quick_start" → "Api Versioning" / "Quick Start". */
export declare function nameToTitle(name: string): string;
/**
 * Scan the project's documentation surface: everything under docs/, plus a
 * root CHANGELOG.md when present (distill writes both). The README is NOT in
 * this tree — it is the landing page itself.
 */
export declare function scanDocs(projectDir: string): DocNode[];
/** Markdown TOC section for the landing page, from published page links. */
export declare function tocMarkdown(entries: Array<{
    title: string;
    url: string;
}>): string;
/** Markdown body for a directory page: a plain list of its children. */
export declare function dirTocMarkdown(entries: Array<{
    title: string;
    url: string;
}>): string;
