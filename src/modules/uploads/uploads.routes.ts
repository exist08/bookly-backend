import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { deliveryUrl, folders, signDirectUpload, uploadBuffer } from '../../lib/cloudinary.js';
import { imageUpload } from '../../lib/upload.js';
import { validateBody } from '../../lib/validate.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

/**
 * POST /v1/uploads/cover  multipart/form-data, field "cover" (JPG/PNG/WebP/HEIC, ≤ 8 MB) → { url }
 * Uploads a book-cover photo (resized to max 1200 px). Send the returned url as `coverUri`
 * in POST/PATCH /v1/posts.
 */
uploadsRouter.post('/cover', imageUpload('cover'), async (req, res) => {
  const user = currentUser(req);
  if (!req.file) throw ApiError.badRequest('photo_required', 'Choose a photo to upload.', 'cover');
  const result = await uploadBuffer(req.file.buffer, {
    folder: `${folders.covers}/${user.id}`,
    public_id: randomUUID(),
    transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
  });
  res.status(201).json({ url: deliveryUrl(result.public_id, result.version) });
});

const signatureBody = z.object({ kind: z.enum(['cover'], { error: 'kind must be "cover".' }) });

/**
 * POST /v1/uploads/signature  { kind: "cover" }
 * Alternative to /cover: signed params for uploading straight to Cloudinary from the client.
 */
uploadsRouter.post('/signature', validateBody(signatureBody), (req, res) => {
  const user = currentUser(req);
  res.json(signDirectUpload({ folder: `${folders.covers}/${user.id}`, publicId: randomUUID() }));
});
