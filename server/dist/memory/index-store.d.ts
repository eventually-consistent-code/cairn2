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
export declare function indexDbPath(projectDir: string): string;
export declare class MemoryIndex {
    private db;
    constructor(dbPath: string);
    index(chunk: Chunk): void;
    search(query: string, filter?: {
        phase?: number;
        issueId?: string;
    }, limit?: number): SearchResult[];
    stats(): IndexStats;
    close(): void;
}
