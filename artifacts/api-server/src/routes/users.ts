import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and, count, ne } from "drizzle-orm";
import { db, usersTable, tripsTable, tripParticipantsTable } from "@workspace/db";
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

// Lookup a user by email — accessible to any authenticated user so trip admins
// can find travelers by email before adding them to a trip.
router.get("/users/lookup", requireAuth, async (req, res): Promise<void> => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : null;
  if (!email) {
    res.status(400).json({ error: "email query parameter is required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (!user) {
    res.status(404).json({ error: "No traveler found with that email address" });
    return;
  }

  // Count how many trips this user is a participant of
  const [{ tripCount }] = await db
    .select({ tripCount: count() })
    .from(tripParticipantsTable)
    .where(eq(tripParticipantsTable.userId, user.id));

  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    otherTripsCount: Number(tripCount),
  });
});

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

router.get("/users/:userId/trips", requireAdmin, async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  const rows = await db
    .select({ tripId: tripParticipantsTable.tripId })
    .from(tripParticipantsTable)
    .innerJoin(tripsTable, eq(tripsTable.id, tripParticipantsTable.tripId))
    .where(eq(tripParticipantsTable.userId, params.data.userId));

  res.json(rows.map(r => r.tripId));
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
