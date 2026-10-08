import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { folders, signDirectUpload } from '../../lib/cloudinary.js';
import { validateBody } from '../../lib/validate.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const signatureBody = z.object({
  kind: z.enum(['cover'], { error: 'kind must be "cover".' }),
});

/**
 * POST /v1/uploads/signature  { kind: "cover" }
 * Signed params for uploading a book-cover photo straight to Cloudinary.
 * The app POSTs `file` + every entry of `fields` as multipart to `uploadUrl`,
 * then sends the returned `secure_url` with the post.
 * (Avatars go through POST /v1/me/avatar instead, which also resizes them.)
 */
uploadsRouter.post('/signature', validateBody(signatureBody), (req, res) => {
  const user = currentUser(req);
  const signed = signDirectUpload({ folder: `${folders.covers}/${user.id}`, publicId: randomUUID() });
  res.json(signed);
});
