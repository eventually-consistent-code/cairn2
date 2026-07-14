import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export const CardFrontmatterSchema = z.object({
  type: z.enum(["decision", "constraint", "gotcha", "reference"]),
  scopePhase: z.string().optional(),
  scopeIssue: z.string().optional(),
  provenanceFiles: z.array(z.string()).default([]),
  provenanceCommits: z.array(z.string()).default([]),
  created: z.string(),
}).refine(
  (d) => d.provenanceFiles.length === d.provenanceCommits.length,
  { message: "provenanceFiles and provenanceCommits must be the same length" },
);

export interface Card {
  id: string;
  frontmatter: z.infer<typeof CardFrontmatterSchema>;
  body: string;
}

export const cardsDir = (projectDir: string) => join(projectDir, ".cairn", "memory", "cards");

function cardId(type: string, body: string): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return `${type}-${hash}`;
}

function validateFrontmatter(data: Record<string, string | string[]>, context: string):
  z.infer<typeof CardFrontmatterSchema> {
  const result = CardFrontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new CairnError("CONFIG_INVALID", `${context}: ${result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

export function createCard(projectDir: string, input: {
  type: "decision" | "constraint" | "gotcha" | "reference";
  body: string;
  scopePhase?: number;
  scopeIssue?: string;
  provenance?: Array<{ file: string; commit: string }>;
}): Card {
  const provenanceFiles = (input.provenance ?? []).map((p) => p.file);
  const provenanceCommits = (input.provenance ?? []).map((p) => p.commit);
  const data: Record<string, string | string[]> = {
    type: input.type,
    provenanceFiles,
    provenanceCommits,
    created: new Date().toISOString().slice(0, 10),
  };
  if (input.scopePhase !== undefined) data.scopePhase = String(input.scopePhase);
  if (input.scopeIssue !== undefined) data.scopeIssue = input.scopeIssue;

  const frontmatter = validateFrontmatter(data, "card validation");
  const id = cardId(input.type, input.body);
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  mkdirSync(cardsDir(projectDir), { recursive: true });
  writeFileSync(join(cardsDir(projectDir), `${id}.md`), serializeFrontmatter(data, body));
  return { id, frontmatter, body };
}

export function readCard(projectDir: string, id: string): Card {
  const path = join(cardsDir(projectDir), `${id}.md`);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no card '${id}'`);
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  return { id, frontmatter: validateFrontmatter(data, `card '${id}' frontmatter`), body };
}

export function listCards(projectDir: string, filter: { scopePhase?: number; scopeIssue?: string } = {}): Card[] {
  const dir = cardsDir(projectDir);
  if (!existsSync(dir)) return [];
  const cards: Card[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    let card: Card;
    try {
      card = readCard(projectDir, entry.slice(0, -3));
    } catch {
      continue; // malformed card: skip rather than brick the whole list (P2 lesson)
    }
    if (filter.scopePhase !== undefined && card.frontmatter.scopePhase !== String(filter.scopePhase)) continue;
    if (filter.scopeIssue !== undefined && card.frontmatter.scopeIssue !== filter.scopeIssue) continue;
    cards.push(card);
  }
  return cards;
}
