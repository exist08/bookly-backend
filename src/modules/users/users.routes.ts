import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { afterCursor, paginate } from '../../lib/cursor.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { Post, type PostDoc } from '../../models/Post.js';
import { User, toPublicAuthor, toPublicUser, type UserDoc } from '../../models/User.js';
import { toPostViews } from '../posts/posts.view.js';

export const usersRouter = Router();

export const SHELF_PAGE = 30;

export const username = z
  .string({ error: 'Pick a username.' })
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,24}$/, '3–24 characters: letters, numbers, dots and underscores.');

/**
 * GET /v1/users/username-available?username=aarav.reads
 * Powers the live check under the username field. Public, so it works during profile setup.
 */
usersRouter.get('/username-available', async (req, res) => {
  const parsed = username.safeParse(req.query.username ?? '');
  if (!parsed.success) {
    res.json({ available: false, reason: 'invalid', message: parsed.error.issues[0]?.message });
    return;
  }
  const taken = await User.exists({ username: parsed.data });
  res.json({ available: !taken, reason: taken ? 'taken' : undefined });
});

async function findUser(id: string): Promise<UserDoc> {
  const user = mongoose.isValidObjectId(id) ? ((await User.findById(id)) as UserDoc | null) : null;
  if (!user) throw ApiError.notFound('This reader no longer has an account.');
  return user;
}

/** GET /v1/users/:id → { user, stats: { books, upvotes } } — a reader's profile header. */
usersRouter.get('/:id', requireAuth, async (req, res) => {
  const viewer = currentUser(req);
  const user = await findUser(req.params.id as string);
  const [stats] = await Post.aggregate<{ books: number; upvotes: number }>([
    { $match: { authorId: user._id } },
    { $group: { _id: null, books: { $sum: 1 }, upvotes: { $sum: '$upvotes' } } },
  ]);
  const isMe = String(user._id) === String(viewer._id);
  res.json({
    user: isMe ? toPublicUser(user) : toPublicAuthor(user),
    stats: { books: stats?.books ?? 0, upvotes: stats?.upvotes ?? 0 },
  });
});

/** GET /v1/users/:id/posts?cursor= — a reader's shelf, newest first, 30 per page. */
usersRouter.get('/:id/posts', requireAuth, async (req, res) => {
  const viewer = currentUser(req);
  const user = await findUser(req.params.id as string);
  const { rows, nextCursor } = await paginate(
    limit =>
      Post.find({ authorId: user._id, ...afterCursor(req.query.cursor) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit) as Promise<PostDoc[]>,
    SHELF_PAGE,
  );
  res.json({ items: await toPostViews(rows, viewer), nextCursor });
});
