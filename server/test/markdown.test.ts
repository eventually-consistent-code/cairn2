import { describe, it, expect } from "vitest";
import { markdownToStorage } from "../src/docs/markdown.js";

describe("markdownToStorage", () => {
  it("converts headings and paragraphs", () => {
    expect(markdownToStorage("# Title\n\nHello world.")).toBe("<h1>Title</h1><p>Hello world.</p>");
  });

  it("merges consecutive lines into one paragraph", () => {
    expect(markdownToStorage("line one\nline two")).toBe("<p>line one line two</p>");
  });

  it("converts inline bold, italic, code, and links", () => {
    expect(markdownToStorage("**b** *i* `c` [t](https://x.io)"))
      .toBe('<p><strong>b</strong> <em>i</em> <code>c</code> <a href="https://x.io">t</a></p>');
  });

  it("escapes HTML in text and code spans", () => {
    expect(markdownToStorage("a <div> & `x < y`"))
      .toBe("<p>a &lt;div&gt; &amp; <code>x &lt; y</code></p>");
  });

  it("converts flat lists", () => {
    expect(markdownToStorage("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("converts ordered lists", () => {
    expect(markdownToStorage("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("nests indented list items inside the parent item", () => {
    expect(markdownToStorage("- a\n  - sub\n- b"))
      .toBe("<ul><li>a<ul><li>sub</li></ul></li><li>b</li></ul>");
  });

  it("converts fenced code blocks to the code macro with CDATA", () => {
    expect(markdownToStorage("```ts\nconst x = 1;\n```"))
      .toBe('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>'
        + "<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>");
  });

  it("splits ]]> sequences inside code blocks", () => {
    expect(markdownToStorage("```\na]]>b\n```")).toContain("a]]]]><![CDATA[>b");
  });

  it("converts blockquotes", () => {
    expect(markdownToStorage("> quoted\n> more")).toBe("<blockquote><p>quoted more</p></blockquote>");
  });

  it("converts pipe tables with header row", () => {
    expect(markdownToStorage("| a | b |\n|---|---|\n| 1 | 2 |"))
      .toBe("<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>");
  });

  it("converts horizontal rules", () => {
    expect(markdownToStorage("above\n\n---\n\nbelow")).toBe("<p>above</p><hr /><p>below</p>");
  });

  it("degrades images to links", () => {
    expect(markdownToStorage("![alt](https://x.io/i.png)"))
      .toBe('<p><a href="https://x.io/i.png">alt</a></p>');
  });

  it("handles an unclosed fence without throwing", () => {
    expect(markdownToStorage("```\ncode")).toContain("<![CDATA[code]]>");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToStorage("")).toBe("");
  });
});
