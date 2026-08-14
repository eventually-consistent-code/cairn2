import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { forgetProject, readRegistry, registerProject, registryPath } from "../src/core/registry.js";

const dirs: string[] = [];
const dir = (prefix = "cairn-registry-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const registered = () => {
  const d = dir("cairn-registry-proj-");
  writeFileSync(join(d, "cairn.json"),
    JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("registryPath", () => {
  it("lives at ~/.cairn/registry.json under the given home", () => {
    const home = dir();
    expect(registryPath(home)).toBe(join(home, ".cairn", "registry.json"));
  });
});

describe("registerProject", () => {
  it("registers a cairn project with absolute path and both timestamps", () => {
    const home = dir();
    const proj = registered();
    registerProject(proj, home);

    const reg = readRegistry(home);
    expect(reg.version).toBe(1);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0].path).toBe(resolve(proj));
    expect(reg.projects[0].name).toBe(proj.split("/").pop());
    expect(reg.projects[0].firstSeen).toBe(reg.projects[0].lastSeen);
  });

  it("re-run refreshes lastSeen and never duplicates the entry", async () => {
    const home = dir();
    const proj = registered();
    registerProject(proj, home);
    const first = readRegistry(home).projects[0];

    await new Promise((r) => setTimeout(r, 5));
    registerProject(proj, home);

    const reg = readRegistry(home);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0].firstSeen).toBe(first.firstSeen);
    expect(reg.projects[0].lastSeen >= first.lastSeen).toBe(true);
  });

  it("skips silently for a non-cairn directory", () => {
    const home = dir();
    const notAProject = dir("cairn-registry-plain-");
    registerProject(notAProject, home);
    expect(readRegistry(home).projects).toHaveLength(0);
  });

  it("a corrupt registry file is treated as empty, then replaced by a valid one", () => {
    const home = dir();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(registryPath(home), "{not json");

    const proj = registered();
    registerProject(proj, home);

    const reg = readRegistry(home);
    expect(reg.projects).toHaveLength(1);
    // and the file on disk is valid JSON again
    expect(() => JSON.parse(readFileSync(registryPath(home), "utf8"))).not.toThrow();
  });

  it("keeps other projects' entries when a second project registers", () => {
    const home = dir();
    const a = registered();
    const b = registered();
    registerProject(a, home);
    registerProject(b, home);

    const paths = readRegistry(home).projects.map((p) => p.path).sort();
    expect(paths).toEqual([resolve(a), resolve(b)].sort());
  });
});

describe("forgetProject", () => {
  it("removes by name substring and reports what went; unknown name removes nothing", () => {
    const home = dir();
    const a = registered();
    const b = registered();
    registerProject(a, home);
    registerProject(b, home);

    const removed = forgetProject(a.split("/").pop()!, home);
    expect(removed.map((r) => r.path)).toEqual([resolve(a)]);
    expect(readRegistry(home).projects.map((p) => p.path)).toEqual([resolve(b)]);

    expect(forgetProject("no-such-project-anywhere", home)).toEqual([]);
    expect(readRegistry(home).projects).toHaveLength(1);
  });

  it("removes by exact path", () => {
    const home = dir();
    const a = registered();
    registerProject(a, home);
    expect(forgetProject(resolve(a), home)).toHaveLength(1);
    expect(readRegistry(home).projects).toHaveLength(0);
  });
});

describe("readRegistry", () => {
  it("missing file reads as an empty registry", () => {
    expect(readRegistry(dir()).projects).toEqual([]);
  });

  it("schema-invalid content reads as empty rather than throwing", () => {
    const home = dir();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(registryPath(home), JSON.stringify({ version: 99, projects: "nope" }));
    expect(readRegistry(home).projects).toEqual([]);
  });
});
