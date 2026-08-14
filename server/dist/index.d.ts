#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import type { Tracker } from "./tracker/types.js";
import type { DocsConnector } from "./docs/types.js";
export declare function buildServer(deps: {
    projectDir: string;
    tracker?: Tracker;
    docsConnector?: DocsConnector;
    fetchLatestVersion?: () => Promise<string>;
}): McpServer;
