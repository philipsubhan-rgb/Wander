import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  CreateUserBody,
  UpdateUserBody,
  GetUserParams,
  UpdateUserParams,
  DeleteUserParams,
  ChangeUserPasswordParams,
  ChangeUserPasswordBody,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

function serializeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

router.get("/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(users.map(serializeUser));
});

router.post("/users", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, name, password, email, role } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({ username, name, email: email ?? null, role: role ?? "traveler", passwordHash })
    .returning();

  res.status(201).json(serializeUser(user));
});

router.get("/users/:userId", requireAuth, async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(serializeUser(user));
});

router.patch("/users/:userId", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set(parsed.data)
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(serializeUser(user));
});

router.delete("/users/:userId", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const [user] = await db.delete(usersTable).where(eq(usersTable.id, params.data.userId)).returning();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ success: true });
});

router.post("/users/:userId/change-password", requireAdmin, async (req, res): Promise<void> => {
  const params = ChangeUserPasswordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const parsed = ChangeUserPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  const [user] = await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ success: true });
});

export default router;
