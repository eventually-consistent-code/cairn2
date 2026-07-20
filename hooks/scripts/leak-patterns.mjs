#!/usr/bin/env node

/**
 * Purpose: THE single source for cairn leak patterns (#2221) -- consumed by
 *   the pretooluse-leakguard hook and, via the CLI mode, by the distill and
 *   ship verbs for output scrubbing. node: builtins only (lib.mjs rule).
 * Author(s): John Reed
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

export function buildPatterns(config) {
  const patterns = [
    { name: "cairn-path", re: /\.cairn\// },
    { name: "phase-ref", re: /\b(?:phases\/\d{2}(?:\.\d+)?-[a-z0-9-]+|milestones\/v\d+)\b/ },
    { name: "cairn-label", re: /cairn:(?:seed|backlog)/ },
  ];
  const projectKey = config?.tracker?.type === "jira"
    ? config?.tracker?.config?.projectKey : undefined;
  if (typeof projectKey === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(projectKey)) {
    patterns.push({ name: "tracker-id", re: new RegExp(`\\b${projectKey}-\\d+\\b`) });
  }
  for (const p of config?.leakGuard?.extraPatterns ?? []) {
    try {
      patterns.push({ name: "extra", re: new RegExp(p) });
    } catch {
      // invalid user regex: skip silently -- guard must never crash the flow
    }
  }
  return patterns;
}

export function scanLines(lines, patterns) {
  const hits = [];
  lines.forEach((text, i) => {
    for (const { name, re } of patterns) {
      const m = re.exec(text);
      if (m) hits.push({ line: i + 1, name, match: m[0] });
    }
  });
  return hits;
}

export function isAllowedPath(path, allow) {
  if (path.startsWith(".cairn/") || path.startsWith("docs/")) return true;
  if (path.endsWith(".md")) return true;
  const base = basename(path);
  if (base === "LEDGER.md" || base === "VERIFICATION.md") return true;
  for (const a of allow) {
    if (a.endsWith("/**") ? path.startsWith(a.slice(0, -2)) : path === a) return true;
  }
  return false;
}

// ---- CLI mode: node leak-patterns.mjs <file...> ----------------------------
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]) === "leak-patterns.mjs";
if (invokedDirectly && process.argv.length > 2) {
  let config = null;
  try {
    if (existsSync(join(process.cwd(), "cairn.json"))) {
      config = JSON.parse(readFileSync(join(process.cwd(), "cairn.json"), "utf8"));
    }
  } catch { /* no config: default patterns only */ }
  const patterns = buildPatterns(config);
  let bad = false;
  for (const file of process.argv.slice(2)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const h of scanLines(text.split("\n"), patterns)) {
      console.log(`${file}:${h.line}: [${h.name}] ${h.match}`);
      bad = true;
    }
  }
  process.exit(bad ? 1 : 0);
}
