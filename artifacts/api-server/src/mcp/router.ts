/**
 * Express router for the MCP endpoint.
 *
 * Mounts at /mcp (registered directly in app.ts, outside the /api prefix).
 *
 * Routes:
 *   POST   /mcp          — MCP Streamable HTTP (JSON-RPC requests)
 *   GET    /mcp          — MCP Streamable HTTP (SSE event stream)
 *   DELETE /mcp          — MCP Streamable HTTP (session termination)
 *   GET    /mcp/health   — Secret-free diagnostics
 */
import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveMcpUser, validateMcpUserId } from "./auth";
import { registerTools } from "./tools";
import { logger } from "../lib/logger";

const router = Router();

/** Build a fresh McpServer configured for a specific authenticated user. */
function buildMcpServer(auth: { userId: number; role: string }): McpServer {
  const server = new McpServer(
    { name: "wander-group-travel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, auth);
  return server;
}

/** Authenticate, then dispatch to a per-request MCP server/transport. */
async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  // ── Authenticate ────────────────────────────────────────────────────────────
  const rawAuth = await resolveMcpUser(req);
  if (!rawAuth) {
    logger.warn({ url: req.url, method: req.method }, "[MCP] unauthenticated request rejected");
    res.status(401).json({ error: "Unauthenticated: provide a valid session or Bearer token." });
    return;
  }

  // Validate the user still exists in the DB (guards stale / misconfigured dev tokens)
  const user = await validateMcpUserId(rawAuth.userId);
  if (!user) {
    logger.warn({ userId: rawAuth.userId }, "[MCP] auth resolved to non-existent user — rejected");
    res.status(401).json({ error: "Unauthenticated: user not found." });
    return;
  }

  const auth = { userId: user.id, role: user.role };

  // ── Per-request stateless transport + server ────────────────────────────────
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new transport per request
  });

  const server = buildMcpServer(auth);

  res.on("close", () => {
    transport.close().catch(() => { /* non-fatal */ });
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ userId: auth.userId, err }, "[MCP] transport error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

// ── MCP Streamable HTTP transport routes ──────────────────────────────────────
router.post("/mcp", (req, res) => { void handleMcpRequest(req, res); });
router.get("/mcp",  (req, res) => { void handleMcpRequest(req, res); });
router.delete("/mcp", (req, res) => { void handleMcpRequest(req, res); });

// ── Health / diagnostics ──────────────────────────────────────────────────────
// Reveals no secrets, credentials, or internal configuration.
router.get("/mcp/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "wander-group-travel",
    version: "0.1.0",
    transport: "streamable-http",
    devAuthEnabled:
      process.env.NODE_ENV !== "production" &&
      process.env.MCP_DEV_AUTH_ENABLED === "true",
  });
});

export default router;
