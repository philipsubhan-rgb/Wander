import { Readable } from 'stream';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';
import { eq, and } from 'drizzle-orm';

import { requireAuth, getAuthUserId, getAuthRole } from '../middlewares/auth';
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';
import { db, tripExpensesTable, tripParticipantsTable } from '@workspace/db';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires auth so public callers cannot mint write-capable URLs.
 */
router.post(
  '/storage/uploads/request-url',
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      console.error('[storage] Error generating upload URL', error);
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * Callers must be authenticated AND be a participant of the trip that owns
 * the receipt. Global admins bypass the trip-membership check.
 */
router.get(
  '/storage/objects/*path',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
      const objectPath = `/objects/${wildcardPath}`;

      // ── Trip-ownership check ──────────────────────────────────────────────
      // Look up which trip this receipt URL belongs to, then verify that the
      // requesting user is actually a participant of that trip.
      // Fail closed: if the path isn't associated with any expense, deny access.
      const userId = getAuthUserId(req, res)!;
      const role = getAuthRole(req, res);

      if (role !== 'admin') {
        const [expense] = await db
          .select({ tripId: tripExpensesTable.tripId })
          .from(tripExpensesTable)
          .where(eq(tripExpensesTable.receiptUrl, objectPath));

        if (!expense) {
          res.status(403).json({ error: 'Trip access required' });
          return;
        }

        const [participant] = await db
          .select()
          .from(tripParticipantsTable)
          .where(
            and(
              eq(tripParticipantsTable.tripId, expense.tripId),
              eq(tripParticipantsTable.userId, userId),
            ),
          );

        if (!participant) {
          res.status(403).json({ error: 'Trip access required' });
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const objectFile =
        await objectStorageService.getObjectEntityFile(objectPath);

      const response = await objectStorageService.downloadObject(objectFile);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }
      console.error('[storage] Error serving object', error);
      res.status(500).json({ error: 'Failed to serve object' });
    }
  },
);

export default router;
