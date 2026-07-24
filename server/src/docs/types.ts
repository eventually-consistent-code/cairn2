// Docs connector SPI — sibling of the tracker SPI (tracker/types.ts).
// Trackers manage work items; docs connectors publish documentation trees.
// The SPI stays product-agnostic: bodies cross the boundary as markdown and
// each adapter owns the conversion to its native storage format.

export interface DocsCapability {
  /** Pages can nest under parent pages (tree, not flat list). */
  hasPageTree: boolean;
  /** Binary attachments can be uploaded to a page. */
  hasAttachments: boolean;
  /** Pages can carry labels/tags. */
  hasLabels: boolean;
}

export interface Page {
  id: string;
  title: string;
  parentId?: string;
  /** Backend version counter, when the product exposes one. */
  version?: number;
  url: string;
}

export interface PageSpec {
  title: string;
  /** Markdown source — the adapter converts to its native body format. */
  markdown: string;
  /** Omitted = top of the project tree (child of the project root page). */
  parentId?: string;
}

export interface DocsConnector {
  readonly capabilities: DocsCapability;
  /**
   * Ensure the project's root (landing) container exists and return it.
   * Idempotent — an existing root is returned, never duplicated.
   */
  ensureRoot(projectName: string): Promise<Page>;
  getPage(id: string): Promise<Page>;
  /** Locate a page by title under a parent — the identity probe for idempotent sync. */
  findPage(title: string, parentId?: string): Promise<Page | null>;
  listChildren(parentId: string): Promise<Page[]>;
  createPage(spec: PageSpec): Promise<Page>;
  updatePage(id: string, spec: PageSpec): Promise<Page>;
}
