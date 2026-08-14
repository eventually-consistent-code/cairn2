#!/usr/bin/env node

// Purpose: Tier E map drill (mechanical) — the knowledge-graph store per
//          verbs/map.md against the REAL dist server (no tracker needed):
//          chunked build done SAFELY (nodes across patches, edges in one
//          final patch), dangling-edge rejection with the store unchanged,
//          null-delete + delete-with-edges rejection, wholesale edge
//          replace, filtered queries, byte-equal reads.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "map-drill", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

// -- chunked build, the safe way -------------------------------------------------
console.log("building the graph: nodes chunked, edges in one final patch...");
await call("map_set", {
  patch: {
    nodes: {
      "mod-export": { type: "module", label: "export pipeline" },
      "mod-dashboard": { type: "module", label: "dashboard" },
    },
  },
});
await call("map_set", {
  patch: {
    nodes: {
      "phase-2": { type: "phase", label: "Phase 2 — dashboard" },
      "dec-streaming": {
        type: "decision",
        label: "streaming over batch export",
      },
    },
  },
});
// wholesale edges is rebuild-only since #71 — the from-scratch build says so
const built = await call("map_set", {
  patch: {
    edges: [
      { from: "mod-dashboard", to: "mod-export", type: "depends-on" },
      { from: "mod-dashboard", to: "phase-2", type: "implements" },
      { from: "mod-export", to: "dec-streaming", type: "decided-in" },
    ],
  },
  rebuild: true,
});
check(
  "build: 4 nodes, 3 edges",
  built.nodes === 4 && built.edges === 3,
  JSON.stringify(built.__error ?? built).slice(0, 100),
);

// -- dangling rejection leaves the store unchanged --------------------------------
const before = await call("map_get", {});
const dangling = await call("map_set", {
  patch: {
    edges: [{ from: "mod-export", to: "ghost-node", type: "depends-on" }],
  },
  rebuild: true,
});
check(
  "dangling edge rejected, missing id named",
  Boolean(dangling.__error) &&
    JSON.stringify(dangling.__error).includes("ghost-node"),
);
// ...and without rebuild: true the wholesale replace itself is refused (#71)
const noRebuild = await call("map_set", {
  patch: {
    edges: [{ from: "mod-dashboard", to: "mod-export", type: "depends-on" }],
  },
});
check(
  "wholesale edges without rebuild refused",
  Boolean(noRebuild.__error) &&
    JSON.stringify(noRebuild.__error).includes("rebuild"),
);
const after = await call("map_get", {});
check(
  "store unchanged after rejection (validate-before-write)",
  JSON.stringify(before) === JSON.stringify(after),
);

// -- byte-equal reads --------------------------------------------------------------
check(
  "two reads byte-equal",
  JSON.stringify(await call("map_get", {})) === JSON.stringify(before),
);

// -- filters -----------------------------------------------------------------------
const nodeView = await call("map_get", { node: "mod-export" });
check(
  "node filter: self + touching edges + neighbors",
  Boolean(nodeView.nodes["mod-export"]) &&
    Boolean(nodeView.nodes["mod-dashboard"]) &&
    Boolean(nodeView.nodes["dec-streaming"]) &&
    nodeView.edges.length === 2,
);
const mods = await call("map_get", { nodeType: "module" });
check(
  "nodeType filter narrows to modules",
  Object.keys(mods.nodes).length === 2,
);
const decideEdges = await call("map_get", { edgeType: "decided-in" });
check(
  "edgeType filter narrows edges",
  decideEdges.edges.length === 1 && decideEdges.edges[0].to === "dec-streaming",
);

// -- delete rules ------------------------------------------------------------------
const blockedDelete = await call("map_set", {
  patch: { nodes: { "mod-export": null } },
});
check("delete with attached edges rejected", Boolean(blockedDelete.__error));
// detach first (wholesale replace demonstrating the doc's warning — a
// rebuild-only move since #71), then delete
await call("map_set", {
  patch: {
    edges: [{ from: "mod-dashboard", to: "phase-2", type: "implements" }],
  },
  rebuild: true,
});
const wiped = await call("map_get", {});
check(
  "edges array replaces wholesale (the map.md warning is real)",
  wiped.edges.length === 1,
);
const deleted = await call("map_set", {
  patch: { nodes: { "mod-export": null, "dec-streaming": null } },
});
check(
  "null-delete works once detached",
  deleted.nodes === 2 && deleted.edges === 1,
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
