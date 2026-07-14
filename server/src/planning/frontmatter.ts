import { z } from "zod";
import { CairnError } from "../errors.js";

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

export function parseFrontmatter(text: string): {
  data: Record<string, string | string[]>; body: string;
} {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new CairnError("CONFIG_INVALID", "unterminated frontmatter block");
  }
  const data: Record<string, string | string[]> = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      throw new CairnError("CONFIG_INVALID",
        `unsupported frontmatter line: ${line} (flat key: value or key: [a, b] only)`);
    }
    const [, key, raw] = m;
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) {
        throw new CairnError("CONFIG_INVALID", `unterminated list for ${key}`);
      }
      const inner = raw.slice(1, -1).trim();
      data[key] = inner ? inner.split(",").map((s) => s.trim()) : [];
    } else {
      data[key] = raw.trim();
    }
  }
  return { data, body: text.slice(end + 5) };
}

export function serializeFrontmatter(
  data: Record<string, string | string[]>, body: string,
): string {
  const lines = Object.entries(data).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export const PlanFrontmatterSchema = z.object({
  issues: z.array(z.string()).default([]),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
});

export function parsePlanDoc(text: string): {
  frontmatter: z.infer<typeof PlanFrontmatterSchema>; body: string;
} {
  const { data, body } = parseFrontmatter(text);
  const known = { issues: data.issues, depth: data.depth };
  const result = PlanFrontmatterSchema.safeParse(
    Object.fromEntries(Object.entries(known).filter(([, v]) => v !== undefined)));
  if (!result.success) {
    throw new CairnError("CONFIG_INVALID", `PLAN.md frontmatter: ${result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { frontmatter: result.data, body };
}
