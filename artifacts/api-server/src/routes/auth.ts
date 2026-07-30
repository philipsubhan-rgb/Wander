import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db, usersTable, passwordResetTokensTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../middlewares/auth";
import { sendPasswordResetEmail } from "../lib/email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function getJwtSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET environment variable is required for bearer token auth but was not set.",
    );
  }
  return secret;
}

export function signAuthToken(userId: number, role: string): string {
  return jwt.sign({ userId, role }, getJwtSecret(), { expiresIn: "30d" });
}

export function verifyAuthToken(token: string): { userId: number; role: string } | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as { userId: number; role: string };
    return payload;
  } catch {
    return null;
  }
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { username: rawUsername, password } = parsed.data;
  // Usernames are stored as lowercase email addresses. Normalise before lookup so
  // that mobile keyboards which auto-capitalise the first letter still succeed.
  const username = rawUsername.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));

  if (!user) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  req.session!.userId = user.id;
  req.session!.role = user.role;

  const token = signAuthToken(user.id, user.role);

  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email ?? null,
    token,
  });
});

// Forgot password — always returns 200 to avoid leaking account existence
router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body as { email?: unknown };

  if (!email || typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.trim().toLowerCase()));

  if (!user) {
    // Return 200 regardless — do not reveal whether the email is registered
    res.json({ success: true });
    return;
  }

  // Generate a cryptographically random token; store only its SHA-256 hash so
  // a DB read cannot be used to construct a working reset URL.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    token: tokenHash,
    expiresAt,
  });

  // Build the reset URL from a trusted env var only — never from request headers,
  // which are attacker-controlled and would allow host-header injection / token exfiltration.
  const appBaseUrl =
    process.env.APP_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);

  if (!appBaseUrl) {
    logger.warn(
      { userId: user.id },
      "APP_BASE_URL is not set — cannot construct a safe reset link; set APP_BASE_URL to enable password reset emails"
    );
    // Return success to avoid leaking account existence, but no email is sent.
    res.json({ success: true });
    return;
  }

  const resetUrl = `${appBaseUrl}/reset-password?token=${rawToken}`;

  await sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    resetUrl,
  });

  res.json({ success: true });
});

// Reset password — validates token, sets new password, marks token as used
router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const { token, newPassword } = req.body as { token?: unknown; newPassword?: unknown };

  if (!token || typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: "Reset token is required" });
    return;
  }
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const now = new Date();

  // Hash the incoming token before looking it up — the DB stores only hashes
  const incomingHash = crypto.createHash("sha256").update(token.trim()).digest("hex");

  const [resetToken] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(
      and(
        eq(passwordResetTokensTable.token, incomingHash),
        gt(passwordResetTokensTable.expiresAt, now),
        isNull(passwordResetTokensTable.usedAt),
      ),
    );

  if (!resetToken) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  // Update password and mark token as used in a single transaction
  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ passwordHash })
      .where(eq(usersTable.id, resetToken.userId));

    await tx
      .update(passwordResetTokensTable)
      .set({ usedAt: now })
      .where(eq(passwordResetTokensTable.id, resetToken.id));
  });

  res.json({ success: true });
});

router.post("/auth/logout", (req, res): void => {
  req.session?.destroy(() => {});
  res.json({ success: true });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, getAuthUserId(req, res)!));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email ?? null,
  });
});

// Self-service password change — any authenticated traveler can change their own password.
// Requires the current password to prevent account takeover from an unattended session.
router.post("/auth/change-password", requireAuth, async (req, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: unknown; newPassword?: unknown };

  if (!currentPassword || typeof currentPassword !== "string" || !currentPassword.trim()) {
    res.status(400).json({ error: "Current password is required" });
    return;
  }
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const userId = getAuthUserId(req, res)!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));

  res.json({ success: true });
});

export default router;
