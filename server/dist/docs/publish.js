import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CairnError } from "../errors.js";
import { dirTocMarkdown, scanDocs, scanImages, tocMarkdown } from "./tree.js";
const MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
};
/** Resolve scanned image refs into PageImage payloads — unreadable files are
 *  skipped with a warning, never a failed publish. */
function loadImages(images) {
    const out = [];
    for (const img of images) {
        try {
            out.push({
                ref: img.ref,
                filename: basename(img.path),
                data: readFileSync(img.path),
                mediaType: MEDIA_TYPES[extname(img.path).toLowerCase()] ?? "application/octet-stream",
            });
        }
        catch (e) {
            console.error(`[cairn] docs publish: skipping unreadable image ${img.path}: ${e}`);
        }
    }
    return out;
}
function readReadme(projectDir) {
    try {
        return readFileSync(join(projectDir, "README.md"), "utf8");
    }
    catch {
        throw new CairnError("NOT_FOUND", `no README.md in ${projectDir}`, "create README.md — it becomes the project landing page");
    }
}
/** Default project name: the repo directory's basename. */
export function defaultProjectName(projectDir) {
    return basename(projectDir);
}
/**
 * Create-or-update by title under a parent — the idempotency primitive.
 * Confluence titles are unique per SPACE, not per parent: when the title is
 * already taken elsewhere in the space, the page is published under a
 * "Title (Context)" disambiguation instead of failing the whole publish.
 */
async function upsert(connector, title, markdown, parentId, context, container, sourceName, images) {
    const existing = await connector.findPage(title, parentId);
    if (existing) {
        return connector.updatePage(existing.id, { title, markdown, parentId, container, sourceName, images });
    }
    const taken = await connector.findPage(title);
    if (!taken)
        return connector.createPage({ title, markdown, parentId, container, sourceName, images });
    const alt = `${title} (${context})`;
    const existingAlt = await connector.findPage(alt, parentId);
    return existingAlt
        ? connector.updatePage(existingAlt.id, { title: alt, markdown, parentId, container, sourceName, images })
        : connector.createPage({ title: alt, markdown, parentId, container, sourceName, images });
}
/**
 * Publish one node and its subtree. Directory pages are published first with
 * their own markdown, then refreshed with a generated child list once the
 * children exist and have real URLs.
 */
async function publishNode(connector, node, parentId, context, sink) {
    let page = await upsert(connector, node.title, node.markdown, parentId, context, node.children.length > 0, node.sourceName, loadImages(node.images));
    sink.push({ title: page.title, url: page.url });
    if (node.children.length > 0) {
        const childEntries = [];
        for (const child of node.children) {
            const childPage = await publishNode(connector, child, page.id, node.title, sink);
            childEntries.push({ title: childPage.title, url: childPage.url });
        }
        if (!connector.capabilities.hasNativeToc) {
            const body = node.markdown
                ? `${node.markdown}\n\n${dirTocMarkdown(childEntries)}`
                : dirTocMarkdown(childEntries);
            page = await connector.updatePage(page.id, {
                title: page.title, markdown: body, parentId, container: true,
            });
        }
    }
    return page;
}
/**
 * Full documentation publish: README becomes the landing page, docs/ (plus a
 * root CHANGELOG.md) becomes the child page tree, and the landing page gains
 * a Documentation section linking the top-level children. Idempotent — pages
 * are matched by title + ancestry and updated in place.
 */
export async function publishTree(connector, projectDir, projectName) {
    const name = projectName ?? defaultProjectName(projectDir);
    const readme = readReadme(projectDir);
    const root = await connector.ensureRoot(name);
    const pages = [];
    const topEntries = [];
    for (const node of scanDocs(projectDir)) {
        const page = await publishNode(connector, node, root.id, name, pages);
        topEntries.push({ title: page.title, url: page.url });
    }
    const landing = connector.capabilities.hasNativeToc
        ? readme
        : `${readme}${tocMarkdown(topEntries)}`;
    const updatedRoot = await connector.updatePage(root.id, {
        title: name, markdown: landing, container: true,
        images: loadImages(scanImages(readme, projectDir)),
    });
    const warning = await connector.finalize?.();
    return { root: updatedRoot, published: 1 + pages.length, pages,
        ...(warning ? { warning } : {}) };
}
/**
 * The walking-skeleton publish: README.md only, no child tree. Kept as the
 * degenerate case — publishTree with an empty docs/ behaves identically.
 */
export async function publishReadme(connector, projectDir, projectName) {
    const name = projectName ?? defaultProjectName(projectDir);
    const markdown = readReadme(projectDir);
    const root = await connector.ensureRoot(name);
    const updated = await connector.updatePage(root.id, { title: name, markdown, container: true });
    const warning = await connector.finalize?.();
    return { root: updated, published: 1, pages: [], ...(warning ? { warning } : {}) };
}
