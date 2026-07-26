// Publisher behavior behind the hasNativeToc capability: no generated TOC
// markdown, container hints on directory pages, finalize warning surfaced.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FakeDocsConnector } from "../src/docs/fake.js";
import { publishTree } from "../src/docs/publish.js";
import type { DocsCapability, PageSpec } from "../src/docs/types.js";

/** Fake flipped to native-TOC mode, recording container hints and finalize. */
class NativeTocFake extends FakeDocsConnector {
  override readonly capabilities: DocsCapability = {
    hasPageTree: true, hasAttachments: false, hasLabels: false, hasNativeToc: true,
  };
  containers: string[] = [];
  finalized = false;
  override async createPage(spec: PageSpec) {
    if (spec.container) this.containers.push(spec.title);
    return super.createPage(spec);
  }
  async finalize(): Promise<string | undefined> {
    this.finalized = true;
    return "commit skipped: not a git repo";
  }
}

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-pub-"));
  writeFileSync(join(dir, "README.md"), "# Proj\n\nlanding");
  mkdirSync(join(dir, "docs", "guide"), { recursive: true });
  writeFileSync(join(dir, "docs", "intro.md"), "# Intro\n\nhello");
  writeFileSync(join(dir, "docs", "guide", "setup.md"), "# Setup\n\nsteps");
  return dir;
}

describe("publishTree with hasNativeToc", () => {
  it("appends no generated TOC markdown anywhere", async () => {
    const c = new NativeTocFake();
    await publishTree(c, fixtureProject(), "proj");
    for (const p of c.pages.values()) {
      expect(p.markdown).not.toContain("## Documentation");
      expect(p.markdown).not.toMatch(/^- \[.*\]\(fake:\/\//m);
    }
  });

  it("passes the container hint for directory nodes only", async () => {
    const c = new NativeTocFake();
    await publishTree(c, fixtureProject(), "proj");
    expect(c.containers).toContain("Guide");
    expect(c.containers).not.toContain("Intro");
  });

  it("calls finalize and surfaces its warning on the result", async () => {
    const c = new NativeTocFake();
    const result = await publishTree(c, fixtureProject(), "proj");
    expect(c.finalized).toBe(true);
    expect(result.warning).toBe("commit skipped: not a git repo");
  });

  it("without hasNativeToc the landing TOC is still generated", async () => {
    const c = new FakeDocsConnector();
    await publishTree(c, fixtureProject(), "proj");
    const bodies = [...c.pages.values()].map((p) => p.markdown).join("\n");
    expect(bodies).toContain("## Documentation");
  });
});
