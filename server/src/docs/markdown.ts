// Markdown → Confluence storage format (XHTML), dependency-free.
// Supported subset: headings, paragraphs, ordered/unordered lists (nested),
// fenced code blocks, blockquotes, tables, horizontal rules, links, images
// (degraded to links), bold/italic/inline code. Unknown constructs degrade
// to escaped text — conversion never throws.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** CDATA can't contain "]]>" — split the sequence across two sections. */
function escapeCdata(s: string): string {
  return s.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function inline(s: string): string {
  // Code spans opt out of all other inline processing.
  return s.split(/(`[^`]+`)/).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    let t = escapeHtml(part);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    return t;
  }).join("");
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```(\w*)\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

function codeMacro(lang: string, lines: string[]): string {
  const param = lang ? `<ac:parameter ac:name="language">${escapeHtml(lang)}</ac:parameter>` : "";
  return `<ac:structured-macro ac:name="code">${param}` +
    `<ac:plain-text-body><![CDATA[${escapeCdata(lines.join("\n"))}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`;
}

function tableHtml(rows: string[]): string {
  const cells = (line: string) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
  const [header, ...body] = [rows[0], ...rows.slice(2)].map(cells);
  const tr = (cols: string[], tag: string) =>
    `<tr>${cols.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
  return `<table><tbody>${tr(header, "th")}${body.map((r) => tr(r, "td")).join("")}</tbody></table>`;
}

/** Emits (possibly nested) list items; indent unit is 2 spaces. */
function listHtml(items: Array<{ indent: number; ordered: boolean; text: string }>): string {
  if (items.length === 0) return "";
  let html = "";
  const stack: string[] = []; // open list tags, one per depth level
  let curDepth = -1;
  for (const item of items) {
    const depth = Math.floor(item.indent / 2);
    if (depth > curDepth) {
      // Nested list opens inside the parent's still-open <li>.
      for (let d = curDepth; d < depth; d++) {
        const tag = item.ordered ? "ol" : "ul";
        html += `<${tag}>`;
        stack.push(tag);
      }
    } else {
      html += "</li>";
      for (let d = curDepth; d > depth; d--) html += `</${stack.pop()}></li>`;
    }
    html += `<li>${inline(item.text)}`;
    curDepth = depth;
  }
  html += "</li>";
  while (stack.length) {
    html += `</${stack.pop()}>`;
    if (stack.length) html += "</li>";
  }
  return html;
}

export function markdownToStorage(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(codeMacro(fence[1], code));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line) && !LIST_RE.test(line)) { out.push("<hr />"); i++; continue; }

    if (line.trimStart().startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quoted.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${inline(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])
      && lines[i + 1].includes("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(lines[i++]);
      out.push(tableHtml(rows));
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      out.push(listHtml(items));
      continue;
    }

    // Paragraph: merge consecutive plain lines.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !HEADING_RE.test(lines[i])
      && !FENCE_RE.test(lines[i]) && !LIST_RE.test(lines[i])
      && !lines[i].trimStart().startsWith(">")) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(" ").trim())}</p>`);
  }

  return out.join("");
}
