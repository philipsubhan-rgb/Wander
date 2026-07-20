import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../middlewares/auth";

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

  const { username, password } = parsed.data;
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

export default router;
