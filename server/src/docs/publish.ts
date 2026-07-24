import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CairnError } from "../errors.js";
import type { DocsConnector, Page } from "./types.js";
import { dirTocMarkdown, scanDocs, tocMarkdown, type DocNode } from "./tree.js";

export interface PublishResult {
  root: Page;
  published: number;
  pages: Array<{ title: string; url: string }>;
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
): Promise<Page> {
  const existing = await connector.findPage(title, parentId);
  if (existing) return connector.updatePage(existing.id, { title, markdown, parentId });
  const taken = await connector.findPage(title);
  if (!taken) return connector.createPage({ title, markdown, parentId });
  const alt = `${title} (${context})`;
  const existingAlt = await connector.findPage(alt, parentId);
  return existingAlt
    ? connector.updatePage(existingAlt.id, { title: alt, markdown, parentId })
    : connector.createPage({ title: alt, markdown, parentId });
}

/**
 * Publish one node and its subtree. Directory pages are published first with
 * their own markdown, then refreshed with a generated child list once the
 * children exist and have real URLs.
 */
async function publishNode(
  connector: DocsConnector,
  node: DocNode,
  parentId: string,
  context: string,
  sink: Array<{ title: string; url: string }>,
): Promise<Page> {
  let page = await upsert(connector, node.title, node.markdown, parentId, context);
  sink.push({ title: page.title, url: page.url });
  if (node.children.length > 0) {
    const childEntries: Array<{ title: string; url: string }> = [];
    for (const child of node.children) {
      const childPage = await publishNode(connector, child, page.id, node.title, sink);
      childEntries.push({ title: childPage.title, url: childPage.url });
    }
    const body = node.markdown
      ? `${node.markdown}\n\n${dirTocMarkdown(childEntries)}`
      : dirTocMarkdown(childEntries);
    page = await connector.updatePage(page.id, {
      title: page.title, markdown: body, parentId,
    });
  }
  return page;
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
  const root = await connector.ensureRoot(name);

  const pages: Array<{ title: string; url: string }> = [];
  const topEntries: Array<{ title: string; url: string }> = [];
  for (const node of scanDocs(projectDir)) {
    const page = await publishNode(connector, node, root.id, name, pages);
    topEntries.push({ title: page.title, url: page.url });
  }

  const updatedRoot = await connector.updatePage(root.id, {
    title: name,
    markdown: `${readme}${tocMarkdown(topEntries)}`,
  });
  return { root: updatedRoot, published: 1 + pages.length, pages };
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
  const root = await connector.ensureRoot(name);
  const updated = await connector.updatePage(root.id, { title: name, markdown });
  return { root: updated, published: 1, pages: [] };
}
