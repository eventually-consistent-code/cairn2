import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, parsePlanDoc, serializeFrontmatter } from "./frontmatter.js";

export const plansRoot = (projectDir: string) => join(projectDir, ".cairn", "plans");

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new CairnError("CONFIG_INVALID", `cannot derive a slug from '${name}'`);
  }
  return slug;
}

export function phaseDirName(number: number, slug: string): string {
  if (!Number.isInteger(number) || number < 1 || number > 99) {
    throw new CairnError("CONFIG_INVALID", `phase number must be 1..99, got ${number}`);
  }
  return `${String(number).padStart(2, "0")}-${slug}`;
}

export const PROJECT_TEMPLATE = (name: string) => `# ${name}

## Vision

<!-- what this project is and why -->

## Requirements

<!-- REQ-01: ... one per line; issues are created in the tracker per requirement -->
`;

export const ROADMAP_TEMPLATE = (name: string) => `# ${name} — Roadmap

| Phase | Name | Status |
|-------|------|--------|
`;

export const CONTEXT_TEMPLATE = (number: number, name: string) =>
  `# Phase ${number}: ${name} — Context

## Locked decisions

<!-- decisions made for this phase; on conflict these WIN over tracker issue text -->
`;

export const PLAN_TEMPLATE = (number: number, name: string) =>
  serializeFrontmatter({ issues: [] }, `# Phase ${number}: ${name} — Plan

## Tasks

<!-- tasks; frontmatter 'issues' lists the tracker ids this plan advances -->
`);

export const RESEARCH_TEMPLATE = (number: number, name: string) =>
  `# Phase ${number}: ${name} — Research

<!-- deep-mode research brief -->
`;

function createIfAbsent(path: string, content: string,
  created: string[], skipped: string[]): void {
  if (existsSync(path)) { skipped.push(path); return; }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  created.push(path);
}

export function scaffoldProject(projectDir: string, name: string): {
  created: string[]; skipped: string[];
} {
  const root = plansRoot(projectDir);
  const created: string[] = []; const skipped: string[] = [];
  createIfAbsent(join(root, "PROJECT.md"), PROJECT_TEMPLATE(name), created, skipped);
  createIfAbsent(join(root, "roadmap.md"), ROADMAP_TEMPLATE(name), created, skipped);
  return { created, skipped };
}

export function scaffoldPhase(projectDir: string, number: number, name: string,
  opts: { research?: boolean } = {}): { dir: string; created: string[]; skipped: string[] } {
  const dirName = phaseDirName(number, slugify(name));
  const base = join(plansRoot(projectDir), "phases", dirName);
  const created: string[] = []; const skipped: string[] = [];
  createIfAbsent(join(base, "CONTEXT.md"), CONTEXT_TEMPLATE(number, name), created, skipped);
  createIfAbsent(join(base, "PLAN.md"), PLAN_TEMPLATE(number, name), created, skipped);
  if (opts.research) {
    createIfAbsent(join(base, "RESEARCH.md"), RESEARCH_TEMPLATE(number, name), created, skipped);
  }
  return { dir: dirName, created, skipped };
}

export function readPlanIssues(projectDir: string, phaseDir: string): string[] {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) return [];
  return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
}

const ISSUE_ID_BREAKING_CHARS_RE = /[,[\]\n]/;

export function writePlanIssues(projectDir: string, phaseDir: string,
  issues: string[]): void {
  for (const id of issues) {
    if (ISSUE_ID_BREAKING_CHARS_RE.test(id)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid issue id '${id}': commas, brackets, and newlines are not allowed (breaks frontmatter)`);
    }
  }
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : PLAN_TEMPLATE(0, phaseDir);
  const { data, body } = parseFrontmatter(raw);
  writeFileSync(path, serializeFrontmatter({ ...data, issues }, body));
}
