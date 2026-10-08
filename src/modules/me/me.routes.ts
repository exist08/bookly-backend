import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { deliveryUrl, destroyImage, folders, isOwnCloudinaryUrl, uploadBuffer } from '../../lib/cloudinary.js';
import { imageUpload } from '../../lib/upload.js';
import { validateBody } from '../../lib/validate.js';
import { checkPassword, hashPassword } from '../../lib/passwords.js';
import { issueTokens, revokeAllSessions } from '../../lib/tokens.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { Session } from '../../models/Session.js';
import { User, toPublicUser, type UserDoc } from '../../models/User.js';
import { newPassword } from '../auth/auth.schemas.js';
import { username } from '../users/users.routes.js';

export const meRouter = Router();
meRouter.use(requireAuth);

/** GET /v1/me — the signed-in account. */
meRouter.get('/', (req, res) => {
  res.json({ user: toPublicUser(currentUser(req)) });
});

const updateMeBody = z
  .object({
    displayName: z.string().trim().min(1, 'Add your name.').max(60, 'Keep your name under 60 characters.'),
    username,
    bio: z.string().trim().max(160, 'Keep your bio under 160 characters.'),
    /**
     * null removes the photo. To set a new one use POST /v1/me/avatar; a URL is
     * only accepted if it's already on our Cloudinary account.
     */
    avatarUri: z
      .url({ error: 'avatarUri must be a URL.' })
      .max(2048)
      .refine(isOwnCloudinaryUrl, 'Upload the photo with POST /v1/me/avatar.')
      .nullable(),
  })
  .partial()
  .strict();

/**
 * PATCH /v1/me  { displayName?, username?, bio?, avatarUri? }
 * Used by profile setup (first username) and Edit profile.
 */
meRouter.patch('/', validateBody(updateMeBody), async (req, res) => {
  const user = currentUser(req);
  const body = req.body as z.infer<typeof updateMeBody>;

  if (body.username !== undefined && body.username !== user.username) {
    if (await User.exists({ username: body.username, _id: { $ne: user._id } })) {
      throw ApiError.conflict('username_taken', 'That username is taken.', 'username');
    }
    user.username = body.username;
  }
  if (body.displayName !== undefined) {
    user.displayName = body.displayName;
  }
  if (body.bio !== undefined) {
    user.bio = body.bio;
  }
  if (body.avatarUri !== undefined) {
    if (body.avatarUri === null && user.avatarUrl && isOwnCloudinaryUrl(user.avatarUrl)) {
      await destroyImage(avatarPublicId(user));
    }
    user.avatarUrl = body.avatarUri;
  }
  await user.save();
  res.json({ user: toPublicUser(user) });
});

/** One avatar per user, always at the same public id, so a new upload replaces the old one. */
const avatarPublicId = (user: UserDoc) => `${folders.avatars}/${user.id}`;

/**
 * POST /v1/me/avatar  multipart/form-data, field "avatar" (JPG/PNG/WebP/HEIC, ≤ 8 MB)
 * Uploads to Cloudinary, square-cropped around the face at 512 px, and sets it as the profile photo.
 */
meRouter.post('/avatar', imageUpload('avatar'), async (req, res) => {
  const user = currentUser(req);
  if (!req.file) {
    throw ApiError.badRequest('photo_required', 'Choose a photo to upload.', 'avatar');
  }
  const [folder, publicId] = [folders.avatars, user.id as string];
  const result = await uploadBuffer(req.file.buffer, {
    folder,
    public_id: publicId,
    overwrite: true,
    invalidate: true,
    transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face' }],
  });
  user.avatarUrl = deliveryUrl(result.public_id, result.version);
  await user.save();
  res.json({ user: toPublicUser(user) });
});

/** DELETE /v1/me/avatar — removes the profile photo (the app falls back to initials). */
meRouter.delete('/avatar', async (req, res) => {
  const user = currentUser(req);
  if (user.avatarUrl && isOwnCloudinaryUrl(user.avatarUrl)) {
    await destroyImage(avatarPublicId(user));
  }
  user.avatarUrl = null;
  await user.save();
  res.json({ user: toPublicUser(user) });
});

const changePasswordBody = z.object({
  currentPassword: z.string({ error: 'Enter your current password.' }).min(1, 'Enter your current password.'),
  newPassword,
});

/**
 * POST /v1/me/password  { currentPassword, newPassword }
 * Signs out every other device and returns fresh tokens for this one.
 */
meRouter.post('/password', validateBody(changePasswordBody), async (req, res) => {
  const { currentPassword, newPassword: next } = req.body as z.infer<typeof changePasswordBody>;
  const user = (await User.findById(currentUser(req)._id).select('+passwordHash')) as UserDoc;
  if (!user.passwordHash) {
    throw ApiError.badRequest('no_password', 'This account signs in with Google and has no password.');
  }
  if (!(await checkPassword(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest('wrong_password', 'That’s not your current password.', 'currentPassword');
  }
  user.passwordHash = await hashPassword(next);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await revokeAllSessions(user._id);
  const tokens = await issueTokens(user, { userAgent: req.get('user-agent'), ip: req.ip });
  res.json({ user: toPublicUser(user), tokens });
});

const deleteMeBody = z.object({
  /** Required for email/password accounts. */
  password: z.string().optional(),
  /** Google-only accounts have no password, so they confirm by sending "DELETE" (what the app asks them to type). */
  confirm: z.string().optional(),
});

/**
 * DELETE /v1/me  { password }  or  { confirm: "DELETE" }
 * Permanently deletes the account and signs out every device.
 */
meRouter.delete('/', validateBody(deleteMeBody), async (req, res) => {
  const { password, confirm } = req.body as z.infer<typeof deleteMeBody>;
  const user = (await User.findById(currentUser(req)._id).select('+passwordHash')) as UserDoc;

  if (user.passwordHash) {
    if (!password || !(await checkPassword(password, user.passwordHash))) {
      throw ApiError.badRequest('wrong_password', 'Enter your password to delete your account.', 'password');
    }
  } else if (confirm?.trim().toUpperCase() !== 'DELETE') {
    throw ApiError.badRequest('confirmation_required', 'Type DELETE to confirm.', 'confirm');
  }

  await Session.deleteMany({ userId: user._id });
  // TODO(posts): when posts and votes move to this API, delete the user's posts,
  // their cover images and their votes here too (ideally in a transaction).
  await User.deleteOne({ _id: user._id });
  await destroyImage(avatarPublicId(user));
  res.status(204).end();
});
