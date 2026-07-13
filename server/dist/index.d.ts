#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tracker } from "./tracker/types.js";
export declare function buildServer(deps: {
    projectDir: string;
    tracker?: Tracker;
}): McpServer;
