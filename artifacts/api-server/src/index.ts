import app from "./app";
import { logger } from "./lib/logger";
import { startBriefingScheduler } from "./lib/briefingScheduler";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function ensureSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the 15-minute daily-briefing scheduler (no immediate tick on boot).
  startBriefingScheduler();
  logger.info("Daily briefing scheduler started");

  // Do not block the HTTP startup probe on a database connection. Production
  // databases can take time to become reachable while an autoscale instance is
  // starting, but the health endpoint must respond promptly for promotion.
  void ensureSessionTable().catch((sessionTableError) => {
    logger.error(
      { err: sessionTableError },
      "Failed to ensure session table after server startup",
    );
  });
});
