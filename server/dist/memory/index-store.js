import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
export function indexDbPath(projectDir) {
    const abs = resolve(projectDir);
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
    return join(homedir(), ".cairn", "index", `${basename(abs)}-${hash}.db`);
}
export class MemoryIndex {
    db;
    constructor(dbPath) {
        mkdirSync(join(dbPath, ".."), { recursive: true });
        this.db = new Database(dbPath);
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      content, source UNINDEXED, phase UNINDEXED, issue_id UNINDEXED, created_at UNINDEXED
    )`);
    }
    index(chunk) {
        this.db.prepare("INSERT INTO chunks (content, source, phase, issue_id, created_at) VALUES (?, ?, ?, ?, ?)").run(chunk.content, chunk.source, chunk.phase, chunk.issueId, chunk.createdAt);
    }
    search(query, filter = {}, limit = 10) {
        const conditions = ["chunks MATCH ?"];
        const params = [query];
        if (filter.phase !== undefined) {
            conditions.push("phase = ?");
            params.push(filter.phase);
        }
        if (filter.issueId !== undefined) {
            conditions.push("issue_id = ?");
            params.push(filter.issueId);
        }
        params.push(limit);
        return this.db.prepare(`SELECT content, source, phase, issue_id as issueId, created_at as createdAt
       FROM chunks WHERE ${conditions.join(" AND ")} ORDER BY rank LIMIT ?`).all(...params);
    }
    stats() {
        const row = this.db.prepare("SELECT COUNT(*) as chunkCount, COALESCE(SUM(LENGTH(content)), 0) as approxBytes FROM chunks").get();
        return { ...row, approxTokens: Math.ceil(row.approxBytes / 4) };
    }
    close() {
        this.db.close();
    }
}
