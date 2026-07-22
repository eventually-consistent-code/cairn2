import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { plansRoot } from "./artifacts.js";

export interface PlanFinding {
  type: "contract-drift" | "unanchored-threshold";
  plan: string; line: number; detail: string;
  counterpart?: { plan: string; line: number };
}

// Path-like token — used both to spot a shared fixture between plans and to
// anchor a threshold to something concrete (a benchmark file, a spec doc).
const PATHLIKE = /\S+\.(?:md|json|ts|js|mjs|csv|txt)/;
const ANCHOR_WORDS = /\b(?:benchmark|fixture|measured|per spec|spec §|source:)\b/i;
const THRESHOLD_SRC = "(?:<=|>=|<|>|≤|≥|under|over|at least|at most|within)"
  + "\\s*\\d+(?:\\.\\d+)?\\s*(?:ms|s|%|rps|qps|kb|mb|gb|tok|tokens|rows|items)\\b";
const THRESHOLD = new RegExp(THRESHOLD_SRC, "gi");
const THRESHOLD_TEST = new RegExp(THRESHOLD_SRC, "i"); // stateless existence check
const CONTRACT = /^(\s*)- (Produces|Consumes): (.*)$/;
const FENCE = /^\s*```/;
const SYMBOL = /`([A-Za-z_$][\w$]*)`|([A-Za-z_$][\w$]*)\(/g;

interface Contract {
  kind: "Produces" | "Consumes";
  plan: string;      // path relative to projectDir
  line: number;       // 1-indexed
  text: string;       // raw joined contract text (incl. continuation lines)
  symbols: Set<string>;
}

const leadingSpaces = (line: string): number => /^(\s*)/.exec(line)![1].length;

// Every `identifier` and every identifier( token, deduped.
function extractSymbols(text: string): Set<string> {
  const symbols = new Set<string>();
  for (const m of text.matchAll(SYMBOL)) symbols.add(m[1] ?? m[2]);
  return symbols;
}

// Walk a PLAN.md's lines and pull out every Produces/Consumes contract,
// including its continuation lines (more-indented, or inside a code fence
// opened on/after the contract line).
function extractContracts(lines: string[], planRel: string): Contract[] {
  const contracts: Contract[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = CONTRACT.exec(lines[i]);
    if (!m) { i++; continue; }
    const indent = m[1].length;
    const kind = m[2] as "Produces" | "Consumes";
    const startLine = i;
    const parts = [m[3]];
    let inFence = false;
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (inFence) {
        parts.push(next);
        j++;
        if (FENCE.test(next)) inFence = false;
        continue;
      }
      if (next.trim() === "") {
        // Blank line ends the contract unless the next non-blank line is
        // still more-indented (blank-line + outdent ends it).
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k >= lines.length || leadingSpaces(lines[k]) <= indent) break;
        j++;
        continue;
      }
      const nextIndent = leadingSpaces(next);
      if (nextIndent > indent) {
        parts.push(next);
        if (FENCE.test(next)) inFence = true;
        j++;
        continue;
      }
      break; // outdent (or a sibling `- ` bullet at the same indent) ends it
    }
    contracts.push({
      kind, plan: planRel, line: startLine + 1,
      text: parts.join("\n"), symbols: extractSymbols(parts.join("\n")),
    });
    i = j;
  }
  return contracts;
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

// A threshold is anchored when the same line, or the line directly above or
// below it, names a path-like fixture or one of the anchor words. A
// neighboring line only lends its anchor if it isn't itself a separate,
// self-contained threshold statement — otherwise two independent
// requirements sitting on adjacent lines would anchor each other by accident.
function isAnchored(lines: string[], idx: number, hasThreshold: boolean[]): boolean {
  if (PATHLIKE.test(lines[idx]) || ANCHOR_WORDS.test(lines[idx])) return true;
  for (const i of [idx - 1, idx + 1]) {
    if (i < 0 || i >= lines.length || hasThreshold[i]) continue;
    if (PATHLIKE.test(lines[i]) || ANCHOR_WORDS.test(lines[i])) return true;
  }
  return false;
}

function scanThresholds(lines: string[], planRel: string): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const hasThreshold = lines.map((line) => THRESHOLD_TEST.test(line));
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(THRESHOLD)) {
      if (!isAnchored(lines, idx, hasThreshold)) {
        findings.push({ type: "unanchored-threshold", plan: planRel, line: idx + 1, detail: m[0] });
      }
    }
  });
  return findings;
}

interface ScannedPlan { rel: string; lines: string[]; text: string; contracts: Contract[] }

export function planCheck(projectDir: string, phase?: number):
  { findings: PlanFinding[]; scanned: number } {
  const phasesDir = join(plansRoot(projectDir), "phases");
  if (!existsSync(phasesDir)) return { findings: [], scanned: 0 };

  const prefix = phase !== undefined ? `${String(phase).padStart(2, "0")}-` : null;
  const plans: ScannedPlan[] = [];
  for (const entry of readdirSync(phasesDir)) {
    if (prefix && !entry.startsWith(prefix)) continue;
    const path = join(phasesDir, entry, "PLAN.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const rel = relative(projectDir, path);
    const lines = text.split("\n");
    plans.push({ rel, lines, text, contracts: extractContracts(lines, rel) });
  }

  const findings: PlanFinding[] = [];

  // Thresholds — independent per plan.
  for (const p of plans) findings.push(...scanThresholds(p.lines, p.rel));

  // Contract drift — pair every Produces against every Consumes in a
  // different plan that shares a symbol, flag on the consumer's line.
  const seen = new Set<string>();
  for (const producerPlan of plans) {
    for (const producer of producerPlan.contracts) {
      if (producer.kind !== "Produces") continue;
      for (const consumerPlan of plans) {
        if (consumerPlan.rel === producerPlan.rel) continue;
        for (const consumer of consumerPlan.contracts) {
          if (consumer.kind !== "Consumes") continue;
          const sharedSymbol = [...producer.symbols].find((s) => consumer.symbols.has(s));
          if (!sharedSymbol) continue;
          const key = `${producer.plan}:${producer.line}>${consumer.plan}:${consumer.line}`;
          if (seen.has(key)) continue;
          if (normalize(producer.text) === normalize(consumer.text)) continue;
          const producerFixtures: string[] = producerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
          const consumerFixtures: string[] = consumerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
          if (producerFixtures.some((f) => consumerFixtures.includes(f))) continue;
          seen.add(key);
          findings.push({
            type: "contract-drift", plan: consumer.plan, line: consumer.line,
            detail: `consumed contract for \`${sharedSymbol}\` differs from producer in ${producer.plan}:${producer.line}`,
            counterpart: { plan: producer.plan, line: producer.line },
          });
        }
      }
    }
  }

  findings.sort((a, b) => (a.plan === b.plan ? a.line - b.line : a.plan < b.plan ? -1 : 1));
  return { findings, scanned: plans.length };
}
