import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import router from "./routes";
import { mcpRouter } from "./mcp";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId: number;
    role: string;
  }
}

const app: Express = express();

// Trust the first proxy hop so req.protocol reflects the original HTTPS
// scheme forwarded by Replit's reverse proxy. Without this, express-session
// sees an HTTP connection in production and refuses to set secure cookies.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Allow any origin with credentials (needed for Expo dev server cross-subdomain requests)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PgStore = ConnectPgSimple(session);

app.use(
  session({
    store: new PgStore({ pool, tableName: "session", createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET || "trip-planner-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

app.use("/api", router);

// MCP read-only server — mounted outside /api so MCP clients can reach it
// at a stable path without the REST API prefix.
app.use(mcpRouter);

export default app;
