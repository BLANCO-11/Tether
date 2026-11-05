import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { schemaStore } from "./schema-store.js";
import { requireApiKey } from "./auth.js";

// Foundry MCP Bridge — exposes the parent app's cached datasource schema as
// read-only MCP tools so Tether's agent can drill into schema on demand
// (complements the manifest's inline summary). No data rows ever leave here.
const PORT = Number(process.env.MCP_BRIDGE_PORT ?? 4003);

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "foundry-schema-bridge", version: "1.0.0" });

  server.tool(
    "list_tables",
    "List tables/collections in a workspace's datasources (structure only).",
    { workspaceId: z.string(), prefix: z.string().optional() },
    async ({ workspaceId, prefix }) => jsonContent(await schemaStore.listTables(workspaceId, prefix)),
  );

  server.tool(
    "read_table_schema",
    "Read a table's columns, types, keys and row estimate.",
    { workspaceId: z.string(), tableName: z.string() },
    async ({ workspaceId, tableName }) => {
      const s = await schemaStore.readTableSchema(workspaceId, tableName);
      return jsonContent(s ?? { error: `table not found: ${tableName}` });
    },
  );

  server.tool(
    "describe_relationships",
    "Describe foreign-key relationships into and out of a table.",
    { workspaceId: z.string(), tableName: z.string() },
    async ({ workspaceId, tableName }) =>
      jsonContent(await schemaStore.describeRelationships(workspaceId, tableName)),
  );

  server.tool(
    "get_column_stats",
    "Get metadata/aggregate stats for a single column (no data values).",
    { workspaceId: z.string(), tableName: z.string(), columnName: z.string() },
    async ({ workspaceId, tableName, columnName }) => {
      const s = await schemaStore.getColumnStats(workspaceId, tableName, columnName);
      return jsonContent(s ?? { error: `column not found: ${tableName}.${columnName}` });
    },
  );

  return server;
}

const app = express();
/**
 * Express 5 changed two defaults this service was written against; keep Express 4's. `query parser` "extended" (qs)
 * keeps `?a[b]=1` an object, and `req.body` stays `{}` when nothing parsed one (body-parser 2 leaves it `undefined`).
 * Set before any parser, which still parses a body that arrives.
 */
app.set("query parser", "extended");
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(express.json({ limit: "1mb" }));

// Left open, matching the parent server's own health-endpoint precedent —
// FR-001 requires a credential on the schema tools, not on liveness.
app.get("/health", (_req, res) => res.json({ status: "ok", server: "foundry-schema-bridge" }));

// Stateless Streamable HTTP: a fresh server+transport per request.
app.post("/mcp", requireApiKey, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp-bridge] request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`[mcp-bridge] Foundry schema bridge on :${PORT}/mcp`);
});
