import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";

export const CardFrontmatterSchema = z.object({
  type: z.enum(["decision", "constraint", "gotcha", "reference", "note"]),
  scopePhase: z.string().optional(),
  scopeIssue: z.string().optional(),
  scopeRole: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
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
  type: "decision" | "constraint" | "gotcha" | "reference" | "note";
  body: string;
  scopePhase?: number;
  scopeIssue?: string;
  scopeRole?: string;
  confidence?: "high" | "medium" | "low";
  provenance?: Array<{ file: string; commit: string }>;
  provenanceFiles?: string[];
  provenanceCommits?: string[];
}): Card {
  // Both provenance shapes persist (#164): the paired form and the flat
  // arrays callers were already passing (which used to vanish silently).
  const provenanceFiles = [
    ...(input.provenance ?? []).map((p) => p.file),
    ...(input.provenanceFiles ?? []),
  ];
  const provenanceCommits = [
    ...(input.provenance ?? []).map((p) => p.commit),
    ...(input.provenanceCommits ?? []),
  ];
  const data: Record<string, string | string[]> = {
    type: input.type,
    provenanceFiles,
    provenanceCommits,
    created: new Date().toISOString().slice(0, 10),
  };
  if (input.scopePhase !== undefined) data.scopePhase = String(input.scopePhase);
  if (input.scopeIssue !== undefined) data.scopeIssue = input.scopeIssue;
  if (input.scopeRole !== undefined) data.scopeRole = input.scopeRole;
  if (input.confidence !== undefined) data.confidence = input.confidence;

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

export interface CardPatch {
  confidence?: "high" | "medium" | "low";
  scopeRole?: string;
  provenanceFiles?: string[];
  provenanceCommits?: string[];
}

export function updateCard(projectDir: string, id: string, patch: CardPatch): Card {
  // Partial patches (#164): every field optional, at least one required --
  // a provenance-only patch must never demand an unrelated confidence.
  if (patch.confidence === undefined && patch.scopeRole === undefined
    && patch.provenanceFiles === undefined && patch.provenanceCommits === undefined) {
    throw new CairnError("CONFIG_INVALID",
      "empty patch: pass at least one of confidence, scopeRole, provenanceFiles, provenanceCommits");
  }
  const path = join(cardsDir(projectDir), `${id}.md`);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no card '${id}'`,
      "list ids with mem_card_list");
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  if (patch.confidence !== undefined) data.confidence = patch.confidence;
  if (patch.scopeRole !== undefined) data.scopeRole = patch.scopeRole;
  if (patch.provenanceFiles !== undefined) data.provenanceFiles = patch.provenanceFiles;
  if (patch.provenanceCommits !== undefined) data.provenanceCommits = patch.provenanceCommits;
  const frontmatter = validateFrontmatter(data, `card '${id}' frontmatter`);
  writeFileSync(path, serializeFrontmatter(data, body));
  return { id, frontmatter, body };
}

/** Card ids are `<type>-<hash>`; anything else must never reach a path join. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Retires a card by deleting its file (#172). Card bodies are immutable, so
 * retirement is deletion -- never an edit in place, and never a body rewritten
 * to say "archived". The archive card that replaces a retired batch is a new
 * card written before any of this runs; see memory/compaction.ts.
 *
 * Returns false when the card was already gone, so retrying a half-finished
 * compaction is a no-op rather than an error.
 *
 * :param projectDir: repository root
 * :param id: card id, validated before it is joined onto a path
 * :returns: true when a file was removed
 */
export function deleteCard(projectDir: string, id: string): boolean {
  // Ids flow in from tool input and card frontmatter, both of which can carry
  // a hostile "../..". Reads survive that; an unlink must not.
  if (!SAFE_ID.test(id)) {
    throw new CairnError("CONFIG_INVALID", `invalid card id '${id}'`,
      "list ids with mem_card_list");
  }
  const path = join(cardsDir(projectDir), `${id}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function updateCardConfidence(projectDir: string, id: string,
  confidence: "high" | "medium" | "low"): Card {
  return updateCard(projectDir, id, { confidence });
}

export function listCards(projectDir: string,
  filter: { scopePhase?: number; scopeIssue?: string; scopeRole?: string } = {}): Card[] {
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
    if (filter.scopeRole !== undefined && card.frontmatter.scopeRole !== filter.scopeRole) continue;
    cards.push(card);
  }
  return cards;
}
