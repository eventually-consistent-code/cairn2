import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CairnError } from "../errors.js";
import type { DocsConnector, Page } from "./types.js";

export interface PublishResult {
  root: Page;
  published: number;
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
 * The walking-skeleton publish: README.md becomes (or refreshes) the
 * project's landing page in the docs backend. Idempotent — the root is
 * located by name and updated in place.
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
  return { root: updated, published: 1 };
}
