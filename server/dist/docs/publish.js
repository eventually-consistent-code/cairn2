import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { projectVersion } from "../core/versions.js";
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
async function upsert(connector, title, markdown, parentId, context, container, sourceName, images, releaseVersion) {
    const existing = await connector.findPage(title, parentId);
    if (existing) {
        return connector.updatePage(existing.id, { title, markdown, parentId, container, sourceName, images, releaseVersion });
    }
    const taken = await connector.findPage(title);
    if (!taken) {
        return connector.createPage({ title, markdown, parentId, container, sourceName, images, releaseVersion });
    }
    const alt = `${title} (${context})`;
    const existingAlt = await connector.findPage(alt, parentId);
    return existingAlt
        ? connector.updatePage(existingAlt.id, { title: alt, markdown, parentId, container, sourceName, images, releaseVersion })
        : connector.createPage({ title: alt, markdown, parentId, container, sourceName, images, releaseVersion });
}
async function publishNode(connector, node, parentId, context, sink, track, releaseVersion) {
    let page = await upsert(connector, node.title, node.markdown, parentId, context, node.children.length > 0, node.sourceName, loadImages(node.images), releaseVersion);
    sink.push({ title: page.title, url: page.url });
    track.ids.add(page.id);
    if (node.children.length > 0) {
        track.containers.push(page.id);
        const childEntries = [];
        for (const child of node.children) {
            const childPage = await publishNode(connector, child, page.id, node.title, sink, track, releaseVersion);
            childEntries.push({ title: childPage.title, url: childPage.url });
        }
        if (!connector.capabilities.hasNativeToc) {
            const body = node.markdown
                ? `${node.markdown}\n\n${dirTocMarkdown(childEntries)}`
                : dirTocMarkdown(childEntries);
            page = await connector.updatePage(page.id, {
                title: page.title, markdown: body, parentId, container: true, releaseVersion,
            });
        }
    }
    return page;
}
/**
 * Diff remote children against what this publish just wrote (#126). Remote
 * pages with no local counterpart are REPORTED, never deleted — a page whose
 * subtree is orphaned is reported once at its top. Warn-only is the locked
 * decision: deleting from a shared docs space stays a human call.
 */
async function findOrphans(connector, parentIds, publishedIds) {
    const orphans = [];
    for (const parentId of parentIds) {
        for (const child of await connector.listChildren(parentId)) {
            if (!publishedIds.has(child.id))
                orphans.push({ title: child.title, url: child.url });
        }
    }
    return orphans;
}
function orphanWarning(orphans) {
    if (orphans.length === 0)
        return undefined;
    const names = orphans.map((o) => `'${o.title}'`).join(", ");
    return `${orphans.length} remote page(s) have no local counterpart and were left untouched: `
        + `${names} — delete them in the docs backend if they are meant to be gone`;
}
/** Compose the degraded-step warnings (orphans + finalize) into one line. */
function joinWarnings(...warnings) {
    const real = warnings.filter((w) => Boolean(w));
    return real.length > 0 ? real.join("; ") : undefined;
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
    const releaseVersion = projectVersion(projectDir) ?? undefined;
    const root = await connector.ensureRoot(name);
    const pages = [];
    const topEntries = [];
    const track = { ids: new Set(), containers: [] };
    for (const node of scanDocs(projectDir)) {
        const page = await publishNode(connector, node, root.id, name, pages, track, releaseVersion);
        topEntries.push({ title: page.title, url: page.url });
    }
    const landing = connector.capabilities.hasNativeToc
        ? readme
        : `${readme}${tocMarkdown(topEntries)}`;
    const updatedRoot = await connector.updatePage(root.id, {
        title: name, markdown: landing, container: true, releaseVersion,
        images: loadImages(scanImages(readme, projectDir)),
    });
    const orphans = await findOrphans(connector, [root.id, ...track.containers], track.ids);
    const warning = joinWarnings(orphanWarning(orphans), await connector.finalize?.());
    return { root: updatedRoot, published: 1 + pages.length, pages,
        ...(releaseVersion ? { releaseVersion } : {}),
        ...(orphans.length > 0 ? { orphans } : {}),
        ...(warning ? { warning } : {}) };
}
/**
 * The walking-skeleton publish: README.md only, no child tree. Kept as the
 * degenerate case — publishTree with an empty docs/ behaves identically.
 */
export async function publishReadme(connector, projectDir, projectName) {
    const name = projectName ?? defaultProjectName(projectDir);
    const markdown = readReadme(projectDir);
    const releaseVersion = projectVersion(projectDir) ?? undefined;
    const root = await connector.ensureRoot(name);
    const updated = await connector.updatePage(root.id, { title: name, markdown, container: true, releaseVersion });
    // README-only publish owns no children — anything under the root is a stray.
    const orphans = await findOrphans(connector, [root.id], new Set());
    const warning = joinWarnings(orphanWarning(orphans), await connector.finalize?.());
    return { root: updated, published: 1, pages: [],
        ...(releaseVersion ? { releaseVersion } : {}),
        ...(orphans.length > 0 ? { orphans } : {}),
        ...(warning ? { warning } : {}) };
}
