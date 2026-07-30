/**
 * MCP Authentication Adapter
 *
 * Derives an authenticated Wander user from an Express request using:
 *   1. Session cookie (req.session.userId) — standard web path
 *   2. Existing Wander JWT Bearer token — standard mobile / API path
 *   3. Dev-only bearer token — gated behind MCP_DEV_AUTH_ENABLED=true,
 *      only in development, maps to a server-side-configured user ID;
 *      never usable in production.
 *
 * Structured so that an OAuth / delegated-user layer can slot in later
 * by adding a new branch before the dev-token check.
 */
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { verifyAuthToken } from "../routes/auth";
import { logger } from "../lib/logger";

export interface McpAuthUser {
  userId: number;
  role: string;
}

/**
 * Returns the authenticated Wander user for an MCP request, or null if
 * the request is unauthenticated.  Never throws; returns null on any error.
 */
export async function resolveMcpUser(req: Request): Promise<McpAuthUser | null> {
  // ── 1. Session cookie ──────────────────────────────────────────────────────
  if (req.session?.userId) {
    return { userId: req.session.userId, role: req.session.role ?? "traveler" };
  }

  // ── 2. Existing Wander JWT Bearer ─────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Dev-only token path (checked first so it short-circuits before JWT verify)
    const devUser = resolveDevToken(token);
    if (devUser !== null) return devUser;

    // Standard Wander JWT
    const payload = verifyAuthToken(token);
    if (payload) {
      return { userId: payload.userId, role: payload.role };
    }
  }

  return null;
}

// ─── Development-only bearer token ───────────────────────────────────────────
//
// Only active when ALL of:
//   • NODE_ENV !== 'production'
//   • MCP_DEV_AUTH_ENABLED === 'true'
//   • MCP_DEV_TOKEN is set to a non-empty value
//   • MCP_DEV_USER_ID is a valid integer that resolves to a real DB user
//
// The token value and user mapping are stored only in Replit Secrets and
// never committed to the repository.

function resolveDevToken(token: string): McpAuthUser | null {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.MCP_DEV_AUTH_ENABLED !== "true") return null;

  const devToken = process.env.MCP_DEV_TOKEN;
  if (!devToken || devToken.trim() === "") return null;

  if (token !== devToken) return null;

  const rawUserId = process.env.MCP_DEV_USER_ID;
  const userId = rawUserId ? parseInt(rawUserId, 10) : NaN;
  if (isNaN(userId)) {
    logger.warn({ rawUserId }, "[MCP] MCP_DEV_USER_ID is not a valid integer — dev token rejected");
    return null;
  }

  return { userId, role: "traveler" };
}

/**
 * Look up the full user record from the DB and validate it still exists.
 * Used to guard against dev-token user IDs pointing to deleted accounts.
 */
export async function validateMcpUserId(userId: number): Promise<{ id: number; name: string; role: string } | null> {
  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    return user ?? null;
  } catch {
    return null;
  }
}
