// Pure structure mapping: repo doc files → a logical page tree. No HTTP —
// the publisher walks this tree against a DocsConnector.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
const H1_RE = /^#\s+(.+)$/m;
/** "0004-api-versioning" / "quick_start" → "Api Versioning" / "Quick Start". */
export function nameToTitle(name) {
    return name
        .replace(/\.md$/i, "")
        .replace(/^\d+[-_]/, "")
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}
function fileNode(path) {
    const markdown = readFileSync(path, "utf8");
    const h1 = H1_RE.exec(markdown);
    return {
        title: h1 ? h1[1].trim() : nameToTitle(basename(path)),
        markdown,
        sourceName: basename(path),
        children: [],
    };
}
function dirNode(path) {
    const entries = readdirSync(path).filter((e) => !e.startsWith(".")).sort();
    const children = [];
    for (const entry of entries) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) {
            const sub = dirNode(full);
            if (sub)
                children.push(sub);
        }
        else if (/\.md$/i.test(entry)) {
            children.push(fileNode(full));
        }
    }
    if (children.length === 0)
        return null;
    return { title: nameToTitle(basename(path)), markdown: "",
        sourceName: basename(path), children };
}
/**
 * Scan the project's documentation surface: everything under docs/, plus a
 * root CHANGELOG.md when present (distill writes both). The README is NOT in
 * this tree — it is the landing page itself.
 */
export function scanDocs(projectDir) {
    const nodes = [];
    const docsDir = join(projectDir, "docs");
    if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
        const root = dirNode(docsDir);
        if (root)
            nodes.push(...root.children);
    }
    const changelog = join(projectDir, "CHANGELOG.md");
    if (existsSync(changelog))
        nodes.push(fileNode(changelog));
    return nodes;
}
/** Markdown TOC section for the landing page, from published page links. */
export function tocMarkdown(entries) {
    if (entries.length === 0)
        return "";
    const lines = entries.map((e) => `- [${e.title}](${e.url})`);
    return `\n\n## Documentation\n\n${lines.join("\n")}\n`;
}
/** Markdown body for a directory page: a plain list of its children. */
export function dirTocMarkdown(entries) {
    return entries.map((e) => `- [${e.title}](${e.url})`).join("\n");
}
