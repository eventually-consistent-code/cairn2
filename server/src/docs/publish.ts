import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { projectVersion } from "../core/versions.js";
import { CairnError } from "../errors.js";
import type { DocsConnector, Page, PageImage } from "./types.js";
import { dirTocMarkdown, scanDocs, scanImages, tocMarkdown, type DocNode } from "./tree.js";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
};

/** Resolve scanned image refs into PageImage payloads — unreadable files are
 *  skipped with a warning, never a failed publish. */
function loadImages(images: Array<{ ref: string; path: string }>): PageImage[] {
  const out: PageImage[] = [];
  for (const img of images) {
    try {
      out.push({
        ref: img.ref,
        filename: basename(img.path),
        data: readFileSync(img.path),
        mediaType: MEDIA_TYPES[extname(img.path).toLowerCase()] ?? "application/octet-stream",
      });
    } catch (e) {
      console.error(`[cairn] docs publish: skipping unreadable image ${img.path}: ${e}`);
    }
  }
  return out;
}

export interface PublishResult {
  root: Page;
  published: number;
  pages: Array<{ title: string; url: string }>;
  /** Release stamp applied to every published page — the project's
   *  package.json version. Absent = project has no version to stamp. */
  releaseVersion?: string;
  /** Remote pages under the project root with no local counterpart (#126).
   *  Reported only — cairn never deletes remote pages; pruning a shared docs
   *  space is a human decision. */
  orphans?: Array<{ title: string; url: string }>;
  /** Degraded-but-successful post-publish step (e.g. auto-commit skipped,
   *  orphan pages left behind). */
  warning?: string;
}

function readReadme(projectDir: string): string {
  try {
    return readFileSync(join(projectDir, "README.md"), "utf8");
  } catch {
    throw new CairnError("NOT_FOUND", `no README.md in ${projectDir}`,
      "create README.md — it becomes the project landing page");
  }
}

/** Default project name: the repo directory's basename. */
export function defaultProjectName(projectDir: string): string {
  return basename(projectDir);
}

/**
 * Create-or-update by title under a parent — the idempotency primitive.
 * Confluence titles are unique per SPACE, not per parent: when the title is
 * already taken elsewhere in the space, the page is published under a
 * "Title (Context)" disambiguation instead of failing the whole publish.
 */
async function upsert(
  connector: DocsConnector,
  title: string,
  markdown: string,
  parentId: string,
  context: string,
  container: boolean,
  sourceName?: string,
  images?: PageImage[],
  releaseVersion?: string,
): Promise<Page> {
  const existing = await connector.findPage(title, parentId);
  if (existing) {
    return connector.updatePage(existing.id,
      { title, markdown, parentId, container, sourceName, images, releaseVersion });
  }
  const taken = await connector.findPage(title);
  if (!taken) {
    return connector.createPage({ title, markdown, parentId, container, sourceName, images, releaseVersion });
  }
  const alt = `${title} (${context})`;
  const existingAlt = await connector.findPage(alt, parentId);
  return existingAlt
    ? connector.updatePage(existingAlt.id,
      { title: alt, markdown, parentId, container, sourceName, images, releaseVersion })
    : connector.createPage({ title: alt, markdown, parentId, container, sourceName, images, releaseVersion });
}

/**
 * Publish one node and its subtree. Directory pages are published first with
 * their own markdown, then refreshed with a generated child list once the
 * children exist and have real URLs.
 */
/** What a publish wrote, for the post-publish orphan diff: every page id it
 *  touched, plus the container pages whose children it owns. */
interface PublishTrack {
  ids: Set<string>;
  containers: string[];
}

async function publishNode(
  connector: DocsConnector,
  node: DocNode,
  parentId: string,
  context: string,
  sink: Array<{ title: string; url: string }>,
  track: PublishTrack,
  releaseVersion?: string,
): Promise<Page> {
  let page = await upsert(connector, node.title, node.markdown, parentId, context,
    node.children.length > 0, node.sourceName, loadImages(node.images), releaseVersion);
  sink.push({ title: page.title, url: page.url });
  track.ids.add(page.id);
  if (node.children.length > 0) {
    track.containers.push(page.id);
    const childEntries: Array<{ title: string; url: string }> = [];
    for (const child of node.children) {
      const childPage = await publishNode(connector, child, page.id, node.title, sink,
        track, releaseVersion);
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
async function findOrphans(
  connector: DocsConnector,
  parentIds: string[],
  publishedIds: Set<string>,
): Promise<Array<{ title: string; url: string }>> {
  const orphans: Array<{ title: string; url: string }> = [];
  for (const parentId of parentIds) {
    for (const child of await connector.listChildren(parentId)) {
      if (!publishedIds.has(child.id)) orphans.push({ title: child.title, url: child.url });
    }
  }
  return orphans;
}

function orphanWarning(orphans: Array<{ title: string; url: string }>): string | undefined {
  if (orphans.length === 0) return undefined;
  const names = orphans.map((o) => `'${o.title}'`).join(", ");
  return `${orphans.length} remote page(s) have no local counterpart and were left untouched: `
    + `${names} — delete them in the docs backend if they are meant to be gone`;
}

/** Compose the degraded-step warnings (orphans + finalize) into one line. */
function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const real = warnings.filter((w): w is string => Boolean(w));
  return real.length > 0 ? real.join("; ") : undefined;
}

/**
 * Full documentation publish: README becomes the landing page, docs/ (plus a
 * root CHANGELOG.md) becomes the child page tree, and the landing page gains
 * a Documentation section linking the top-level children. Idempotent — pages
 * are matched by title + ancestry and updated in place.
 */
export async function publishTree(
  connector: DocsConnector,
  projectDir: string,
  projectName?: string,
): Promise<PublishResult> {
  const name = projectName ?? defaultProjectName(projectDir);
  const readme = readReadme(projectDir);
  const releaseVersion = projectVersion(projectDir) ?? undefined;
  const root = await connector.ensureRoot(name);

  const pages: Array<{ title: string; url: string }> = [];
  const topEntries: Array<{ title: string; url: string }> = [];
  const track: PublishTrack = { ids: new Set(), containers: [] };
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
export async function publishReadme(
  connector: DocsConnector,
  projectDir: string,
  projectName?: string,
): Promise<PublishResult> {
  const name = projectName ?? defaultProjectName(projectDir);
  const markdown = readReadme(projectDir);
  const releaseVersion = projectVersion(projectDir) ?? undefined;
  const root = await connector.ensureRoot(name);
  const updated = await connector.updatePage(root.id,
    { title: name, markdown, container: true, releaseVersion });
  // README-only publish owns no children — anything under the root is a stray.
  const orphans = await findOrphans(connector, [root.id], new Set());
  const warning = joinWarnings(orphanWarning(orphans), await connector.finalize?.());
  return { root: updated, published: 1, pages: [],
    ...(releaseVersion ? { releaseVersion } : {}),
    ...(orphans.length > 0 ? { orphans } : {}),
    ...(warning ? { warning } : {}) };
}
