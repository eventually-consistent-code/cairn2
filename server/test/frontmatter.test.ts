import { describe, it, expect } from "vitest";
import {
  parseFrontmatter, serializeFrontmatter, parsePlanDoc,
} from "../src/planning/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses strings and lists, returns body", () => {
    const text = "---\nissues: [PROJ-1, PROJ-2]\ndepth: deep\n---\n# Plan\nbody here\n";
    const { data, body } = parseFrontmatter(text);
    expect(data.issues).toEqual(["PROJ-1", "PROJ-2"]);
    expect(data.depth).toBe("deep");
    expect(body).toBe("# Plan\nbody here\n");
  });

  it("empty list and no-frontmatter cases", () => {
    expect(parseFrontmatter("---\nissues: []\n---\nx").data.issues).toEqual([]);
    const plain = parseFrontmatter("# just body");
    expect(plain.data).toEqual({});
    expect(plain.body).toBe("# just body");
  });

  it("throws CONFIG_INVALID on unterminated frontmatter", () => {
    expect(() => parseFrontmatter("---\nissues: [A]\nno terminator"))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("round-trips through serialize", () => {
    const text = serializeFrontmatter({ issues: ["A-1"], depth: "quick" }, "# T\n");
    const back = parseFrontmatter(text);
    expect(back.data).toEqual({ issues: ["A-1"], depth: "quick" });
    expect(back.body).toBe("# T\n");
  });
});

describe("parsePlanDoc", () => {
  it("defaults issues to [] and validates depth", () => {
    expect(parsePlanDoc("# no fm").frontmatter.issues).toEqual([]);
    expect(() => parsePlanDoc("---\ndepth: turbo\n---\nx"))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
