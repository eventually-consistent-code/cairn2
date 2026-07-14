import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Chunk {
  content: string;
  source: string;
  phase: number | null;
  issueId: string | null;
  createdAt: string;
}

export interface SearchResult {
  content: string;
  source: string;
  phase: number | null;
  issueId: string | null;
  createdAt: string;
}

export interface IndexStats {
  chunkCount: number;
  approxBytes: number;
  approxTokens: number;
}

export function indexDbPath(projectDir: string): string {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return join(homedir(), ".cairn", "index", `${basename(abs)}-${hash}.db`);
}

export class MemoryIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      content, source UNINDEXED, phase UNINDEXED, issue_id UNINDEXED, created_at UNINDEXED
    )`);
  }

  index(chunk: Chunk): void {
    this.db.prepare(
      "INSERT INTO chunks (content, source, phase, issue_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(chunk.content, chunk.source, chunk.phase, chunk.issueId, chunk.createdAt);
  }

  search(query: string, filter: { phase?: number; issueId?: string } = {}, limit = 10): SearchResult[] {
    // FTS5 has its own query grammar (apostrophes, leading hyphens, unbalanced
    // quotes/parens all mean something special). Wrap the raw agent-supplied
    // query as a quoted phrase so it's treated as literal text instead of
    // FTS5 syntax -- doubling internal quotes escapes them per FTS5 rules.
    const safeQuery = `"${query.replace(/"/g, '""')}"`;
    const conditions = ["chunks MATCH ?"];
    const params: unknown[] = [safeQuery];
    if (filter.phase !== undefined) { conditions.push("phase = ?"); params.push(filter.phase); }
    if (filter.issueId !== undefined) { conditions.push("issue_id = ?"); params.push(filter.issueId); }
    params.push(limit);
    return this.db.prepare(
      `SELECT content, source, phase, issue_id as issueId, created_at as createdAt
       FROM chunks WHERE ${conditions.join(" AND ")} ORDER BY rank LIMIT ?`,
    ).all(...params) as SearchResult[];
  }

  stats(): IndexStats {
    const row = this.db.prepare(
      "SELECT COUNT(*) as chunkCount, COALESCE(SUM(LENGTH(content)), 0) as approxBytes FROM chunks",
    ).get() as { chunkCount: number; approxBytes: number };
    return { ...row, approxTokens: Math.ceil(row.approxBytes / 4) };
  }

  close(): void {
    this.db.close();
  }
}
