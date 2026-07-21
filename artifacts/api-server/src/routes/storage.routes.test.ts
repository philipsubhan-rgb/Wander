/**
 * Integration tests for the storage route.
 *
 * Confirms that receipt photos stored in object storage are accessible only to
 * participants of the trip that owns the receipt, and that unauthenticated
 * callers and non-members are rejected.
 *
 * Strategy:
 *  - Mock ObjectStorageService so no real GCS calls are made.
 *  - Mock @workspace/db so no real Postgres queries are made.
 *  - Mount the storage router on a minimal Express app that injects a fake
 *    session, making every request look like a logged-in user.
 *  - Drive requests with the built-in fetch (Node ≥ 18).
 */

import http from "node:http";
import express from "express";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────
// The route calls eq() and and() to build query conditions; we only need them
// to return something (the mock DB chain ignores the values).

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
}));

// ── Mock @workspace/db ────────────────────────────────────────────────────────
//
// Two sequential DB queries are made per request:
//   1. Look up the expense by receiptUrl  → { tripId }
//   2. Verify the user is a trip participant
//
// Tests configure results through dbResults[], reset in beforeEach.

type DbQueryResult = () => Promise<unknown[]>;
let dbResults: DbQueryResult[] = [];
let dbCallIndex = 0;

vi.mock("@workspace/db", () => {
  // Each call to .where() consumes the next entry in dbResults.
  function makeChain(): any {
    return {
      select: () => makeChain(),
      from: () => makeChain(),
      innerJoin: () => makeChain(),
      where: () => {
        const fn = dbResults[dbCallIndex++];
        return fn ? fn() : Promise.resolve([]);
      },
    };
  }

  return {
    db: makeChain(),
    tripExpensesTable: { tripId: "trip_id", receiptUrl: "receipt_url" },
    tripParticipantsTable: { tripId: "trip_id", userId: "user_id" },
    expenseSplitsTable: {},
    usersTable: {},
  };
});

// ── Mock ObjectStorageService ─────────────────────────────────────────────────

let mockGetFileFn: () => Promise<unknown> = async () => ({ name: "fake-file" });
let mockDownloadFn: () => Promise<Response> = async () =>
  new Response("image-bytes", {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Content-Length": "11" },
  });

vi.mock("../lib/objectStorage.js", () => {
  class ObjectNotFoundError extends Error {
    constructor() {
      super("Object not found");
      this.name = "ObjectNotFoundError";
      Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
    }
  }

  class ObjectStorageService {
    async getObjectEntityFile(_objectPath: string) {
      return mockGetFileFn();
    }
    async downloadObject(_file: unknown) {
      return mockDownloadFn();
    }
    getObjectEntityUploadURL() {
      return Promise.resolve("https://storage.googleapis.com/bucket/obj");
    }
    normalizeObjectEntityPath(rawPath: string) {
      return rawPath;
    }
  }

  return { ObjectStorageService, ObjectNotFoundError };
});

// ── Test app builders ─────────────────────────────────────────────────────────

async function buildAuthApp(userId = 2) {
  const { default: storageRouter } = await import("./storage.js");

  const app = express();
  app.use(express.json());

  app.use((req: any, _res: any, next: any) => {
    req.session = { userId, role: "user" };
    next();
  });

  app.use("/api", storageRouter);
  return app;
}

async function buildNoAuthApp() {
  const { default: storageRouter } = await import("./storage.js");

  const app = express();
  app.use(express.json());

  app.use((req: any, _res: any, next: any) => {
    req.session = {};
    next();
  });

  app.use("/api", storageRouter);
  return app;
}

async function buildAdminApp() {
  const { default: storageRouter } = await import("./storage.js");

  const app = express();
  app.use(express.json());

  app.use((req: any, _res: any, next: any) => {
    req.session = { userId: 99, role: "admin" };
    next();
  });

  app.use("/api", storageRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let authServer: http.Server;
let authBase: string;

let noAuthServer: http.Server;
let noAuthBase: string;

let adminServer: http.Server;
let adminBase: string;

function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://localhost:${addr.port}/api` });
    });
  });
}

beforeAll(async () => {
  const [auth, noAuth, admin] = await Promise.all([
    buildAuthApp(2),
    buildNoAuthApp(),
    buildAdminApp(),
  ]);
  ({ server: authServer, base: authBase } = await listen(auth));
  ({ server: noAuthServer, base: noAuthBase } = await listen(noAuth));
  ({ server: adminServer, base: adminBase } = await listen(admin));
});

afterAll(() => {
  authServer.close();
  noAuthServer.close();
  adminServer.close();
});

beforeEach(() => {
  dbCallIndex = 0;

  // Default "happy path": the receipt belongs to trip 1, and userId 2 is a participant.
  dbResults = [
    async () => [{ tripId: 1 }],  // expense lookup returns a matching row
    async () => [{ id: 1 }],       // participant lookup confirms membership
  ];

  mockGetFileFn = async () => ({ name: "fake-file" });
  mockDownloadFn = async () =>
    new Response("image-bytes", {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Content-Length": "11" },
    });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /storage/objects/:path — authentication guard", () => {
  it("returns 401 when the caller has no session", async () => {
    const res = await fetch(`${noAuthBase}/storage/objects/uploads/some-receipt-uuid`);
    expect(res.status).toBe(401);
  });

  it("returns 401 JSON body with an error field", async () => {
    const res = await fetch(`${noAuthBase}/storage/objects/uploads/some-receipt-uuid`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /storage/objects/:path — cross-participant access (same trip)", () => {
  /**
   * Core scenario: User 1 uploaded the receipt (their userId is on the expense),
   * but User 2 (a different participant on the SAME trip) should be able to
   * retrieve it because they are a trip participant.
   */
  it("participant B can read a receipt uploaded by participant A on the same trip (returns 200)", async () => {
    // authServer uses userId=2; the receipt was uploaded by userId=1
    // DB: receipt found in trip 1, userId 2 is a participant of trip 1
    const res = await fetch(`${authBase}/storage/objects/uploads/receipt-from-user1`);
    expect(res.status).toBe(200);
  });

  it("response body contains the receipt bytes", async () => {
    const res = await fetch(`${authBase}/storage/objects/uploads/receipt-from-user1`);
    const text = await res.text();
    expect(text).toBe("image-bytes");
  });

  it("Content-Type header is forwarded from storage to the client", async () => {
    const res = await fetch(`${authBase}/storage/objects/uploads/receipt-from-user1`);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
  });

  it("nested path (uploads/subdir/uuid) is resolved correctly", async () => {
    const res = await fetch(`${authBase}/storage/objects/uploads/subdir/receipt-uuid`);
    expect(res.status).toBe(200);
  });
});

describe("GET /storage/objects/:path — cross-trip access denial", () => {
  /**
   * An authenticated user who is NOT a participant of the trip that owns the
   * receipt must receive 403, even though they are logged in.
   */
  it("returns 403 when the authenticated user does not belong to the receipt's trip", async () => {
    // DB: receipt belongs to trip 1; userId 2 is NOT a participant of trip 1
    dbResults = [
      async () => [{ tripId: 1 }],  // expense found
      async () => [],                 // no participant row → access denied
    ];

    const res = await fetch(`${authBase}/storage/objects/uploads/another-trips-receipt`);
    expect(res.status).toBe(403);
  });

  it("403 response includes a JSON error field", async () => {
    dbResults = [
      async () => [{ tripId: 1 }],
      async () => [],
    ];

    const res = await fetch(`${authBase}/storage/objects/uploads/another-trips-receipt`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("returns 403 when the object path is not associated with any expense", async () => {
    // Fail closed: path not found in tripExpensesTable → deny access
    dbResults = [
      async () => [], // no matching expense
    ];

    const res = await fetch(`${authBase}/storage/objects/uploads/unknown-path`);
    expect(res.status).toBe(403);
  });
});

describe("GET /storage/objects/:path — global admin bypass", () => {
  it("admin can access a receipt without a trip participant check (returns 200)", async () => {
    // The admin app skips the DB trip-ownership check entirely
    const res = await fetch(`${adminBase}/storage/objects/uploads/any-receipt`);
    expect(res.status).toBe(200);
  });
});

describe("GET /storage/objects/:path — object not found", () => {
  it("returns 404 when the object does not exist in storage", async () => {
    const { ObjectNotFoundError } = await import("../lib/objectStorage.js");
    mockGetFileFn = async () => { throw new ObjectNotFoundError(); };

    const res = await fetch(`${authBase}/storage/objects/uploads/missing-uuid`);
    expect(res.status).toBe(404);
  });

  it("404 response has a JSON error field", async () => {
    const { ObjectNotFoundError } = await import("../lib/objectStorage.js");
    mockGetFileFn = async () => { throw new ObjectNotFoundError(); };

    const res = await fetch(`${authBase}/storage/objects/uploads/missing-uuid`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /storage/objects/:path — downstream storage error", () => {
  it("returns 500 when the storage service throws an unexpected error", async () => {
    mockGetFileFn = async () => { throw new Error("GCS connection timeout"); };

    const res = await fetch(`${authBase}/storage/objects/uploads/some-receipt`);
    expect(res.status).toBe(500);
  });
});
