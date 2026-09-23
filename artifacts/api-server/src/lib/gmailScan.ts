/**
 * Gmail scanning for booking confirmations.
 *
 * Raw Gmail REST API via fetch (no heavy googleapis dependency).
 * google-auth-library's OAuth2Client handles the refresh-token exchange.
 */

import { OAuth2Client } from "google-auth-library";
import { logger } from "./logger";
import type { InboundEmail } from "./reservationParser";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function appBaseUrl(): string {
  const url = process.env.APP_BASE_URL;
  if (!url) {
    throw new Error(
      "APP_BASE_URL is not set — Google OAuth needs the public app URL " +
        "(e.g. https://<repl>.replit.dev) to build the callback redirect URI.",
    );
  }
  return url.replace(/\/$/, "");
}

/** OAuth client for the connect flow (redirect-based). */
export function getOAuthClient(): OAuth2Client {
  if (!googleOAuthConfigured()) {
    throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)");
  }
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    `${appBaseUrl()}/api/integrations/google/callback`,
  );
}

/** OAuth client authenticated as a connected account (refresh token). */
export async function getAccountClient(refreshToken: string): Promise<OAuth2Client> {
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID!, process.env.GOOGLE_CLIENT_SECRET!);
  client.setCredentials({ refresh_token: refreshToken });
  await client.getAccessToken(); // throws on revoked/invalid grants
  return client;
}

export function getGoogleAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    state,
  });
}

async function gmailFetch(client: OAuth2Client, path: string): Promise<any> {
  const { token } = await client.getAccessToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const BOOKING_QUERY = [
  "newer_than:30d",
  "(",
  "subject:(confirmation OR booking OR reservation OR itinerary OR e-ticket)",
  "OR from:(getyourguide.com OR opentable.com OR resy.com OR united.com OR aa.com",
  "OR delta.com OR marriott.com OR hyatt.com OR airbnb.com OR vrbo.com OR sixt.com",
  "OR ticketmaster.com OR eventbrite.com)",
  ")",
].join(" ");

interface GmailHeader { name: string; value: string; }

function header(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function b64urlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function extractPlainText(payload: any): string {
  const parts: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.mimeType === "text/plain" && node.body?.data) {
      parts.push(b64urlDecode(node.body.data));
    } else if (node.mimeType === "text/html" && node.body?.data && parts.length === 0) {
      // Fallback: strip tags from HTML when no plain-text part exists.
      const html = b64urlDecode(node.body.data);
      parts.push(html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    }
    for (const part of node.parts ?? []) walk(part);
  };
  walk(payload);
  return parts.join("\n").slice(0, 20000);
}

export interface ScanResult {
  emails: (InboundEmail & { messageId: string })[];
  historyId?: string;
}

/**
 * Scan a connected Gmail account for booking confirmations.
 * Incremental via historyId when available; falls back to a search query.
 */
export async function scanGmail(
  client: OAuth2Client,
  lastHistoryId?: string | null,
): Promise<ScanResult> {
  let messageIds: string[] = [];
  let historyId: string | undefined;

  if (lastHistoryId) {
    try {
      const history = await gmailFetch(
        client,
        `/history?startHistoryId=${encodeURIComponent(lastHistoryId)}&historyTypes=messageAdded`,
      );
      historyId = history.historyId;
      for (const h of history.history ?? []) {
        for (const m of h.messagesAdded ?? []) {
          if (m.message?.id) messageIds.push(m.message.id);
        }
      }
    } catch (err) {
      // History expired (Google keeps ~7 days) — fall back to a fresh search.
      logger.info({ err }, "[Gmail] historyId expired, falling back to search");
    }
  }

  if (!lastHistoryId || messageIds.length === 0) {
    const list = await gmailFetch(
      client,
      `/messages?q=${encodeURIComponent(BOOKING_QUERY)}&maxResults=25`,
    );
    messageIds = (list.messages ?? []).map((m: any) => m.id);
    historyId = list.resultSizeEstimate !== undefined ? undefined : historyId;
  }

  // Always refresh the history watermark from the profile.
  try {
    const profile = await gmailFetch(client, `/profile`);
    if (profile.historyId) historyId = String(profile.historyId);
  } catch { /* non-fatal */ }

  const emails: (InboundEmail & { messageId: string })[] = [];
  for (const id of messageIds.slice(0, 25)) {
    try {
      const msg = await gmailFetch(client, `/messages/${id}?format=full`);
      const headers: GmailHeader[] = msg.payload?.headers ?? [];
      emails.push({
        messageId: id,
        from: header(headers, "From"),
        subject: header(headers, "Subject"),
        snippet: msg.snippet ?? "",
        bodyText: extractPlainText(msg.payload),
        receivedAt: header(headers, "Date"),
      });
    } catch (err) {
      logger.warn({ messageId: id, err }, "[Gmail] failed to fetch message, skipping");
    }
  }

  return { emails, historyId };
}

/** Fetch the authenticated Google user's email (used at connect time). */
export async function getGoogleUserEmail(client: OAuth2Client): Promise<string> {
  const { token } = await client.getAccessToken();
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`);
  const info = (await res.json()) as { email?: string };
  if (!info.email) throw new Error("Google did not return an email address");
  return info.email;
}

/** Revoke an OAuth token (used at disconnect). Best-effort. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });
  } catch (err) {
    logger.warn({ err }, "[Gmail] token revoke failed (non-fatal)");
  }
}
