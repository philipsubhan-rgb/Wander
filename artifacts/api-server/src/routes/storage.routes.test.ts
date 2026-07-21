/**
 * Integration tests for the storage route.
 *
 * Confirms that receipt photos stored in object storage are accessible to any
 * authenticated trip participant — not only the uploader — and that
 * unauthenticated callers are rejected.
 *
 * Strategy:
 *  - Mock ObjectStorageService so no real GCS calls are made.
 *  - Mount the storage router on a minimal Express app that injects a fake
 *    session, making every request look like a logged-in user.
 *  - Drive requests with the built-in fetch (Node ≥ 18).
 */

import http from "node:http";
import express from "express";
import { Readable } from "node:stream";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// ── Mock ObjectStorageService ─────────────────────────────────────────────────
//
// We replace the entire objectStorage module so the route never touches GCS.
// Tests override mockGetFile / mockDownload per-scenario via module-level vars.

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
    async getObjectEntityFile(objectPath: string) {
      return mockGetFileFn();
    }
    async downloadObject(file: unknown) {
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

async function buildAuthApp() {
  // A fresh dynamic import is needed so the vi.mock above takes effect
  const { default: storageRouter } = await import("./storage.js");

  const app = express();
  app.use(express.json());

  // Simulate a logged-in user (userId = 2, different from the "uploader" userId = 1)
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId: 2, role: "user" };
    next();
  });

  app.use("/api", storageRouter);
  return app;
}

async function buildNoAuthApp() {
  const { default: storageRouter } = await import("./storage.js");

  const app = express();
  app.use(express.json());

  // No session — simulates an unauthenticated caller
  app.use((req: any, _res: any, next: any) => {
    req.session = {};
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

function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://localhost:${addr.port}/api` });
    });
  });
}

beforeAll(async () => {
  const [auth, noAuth] = await Promise.all([buildAuthApp(), buildNoAuthApp()]);
  ({ server: authServer, base: authBase } = await listen(auth));
  ({ server: noAuthServer, base: noAuthBase } = await listen(noAuth));
});

afterAll(() => {
  authServer.close();
  noAuthServer.close();
});

beforeEach(() => {
  // Reset to "happy path" defaults before each test
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

describe("GET /storage/objects/:path — cross-participant access", () => {
  /**
   * Core scenario: User 1 uploaded the receipt (their userId is on the expense),
   * but User 2 (a different participant on the same trip) should be able to
   * retrieve it. The storage endpoint only requires auth — no trip-scoping — so
   * any authenticated user gets through.
   */
  it("participant B can read a receipt uploaded by participant A (returns 200)", async () => {
    // authServer uses userId=2; the receipt was uploaded by userId=1
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

describe("GET /storage/objects/:path — object not found", () => {
  it("returns 404 when the object does not exist in storage", async () => {
    // Override the mock to throw ObjectNotFoundError
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
