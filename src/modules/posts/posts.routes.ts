import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { validateBody } from '../../lib/validate.js';
import { paginate, afterCursor } from '../../lib/cursor.js';
import { destroyImage, isOwnCloudinaryUrl, publicIdFromUrl } from '../../lib/cloudinary.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { COVER_PALETTES, Post, type PostDoc } from '../../models/Post.js';
import { Vote } from '../../models/Vote.js';
import { toPostViewOne, toPostViews } from './posts.view.js';

export const FEED_PAGE = 10;

// ---------- validation (messages match the copy under each field in the apps) ----------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const postBody = z.object({
  bookTitle: z.string({ error: 'Add the book’s title.' }).trim().min(1, 'Add the book’s title.').max(200, 'Keep the title under 200 characters.'),
  bookAuthor: z
    .string()
    .trim()
    .max(120, 'Keep the author under 120 characters.')
    .nullish()
    .transform(v => v || null),
  review: z.string({ error: 'Say a few words about it.' }).trim().min(1, 'Say a few words about it.').max(500, 'Keep it under 500 characters.'),
  /** null = typographic cover. A photo must be uploaded first with POST /v1/uploads/cover. */
  coverUri: z
    .string()
    .url()
    .refine(isOwnCloudinaryUrl, 'Upload the cover with POST /v1/uploads/cover first.')
    .nullable(),
  coverPalette: z.object({ bg: hex, fg: hex }).optional(),
});
type PostBody = z.infer<typeof postBody>;

const voteBody = z.object({ value: z.union([z.literal(1), z.literal(0), z.literal(-1)], { error: 'value must be 1, 0 or -1.' }) });

async function findPost(id: string): Promise<PostDoc> {
  const post = mongoose.isValidObjectId(id) ? ((await Post.findById(id)) as PostDoc | null) : null;
  if (!post) throw ApiError.notFound('This post was deleted.');
  return post;
}

async function findOwnPost(id: string, userId: unknown): Promise<PostDoc> {
  const post = await findPost(id);
  if (String(post.authorId) !== String(userId)) throw ApiError.forbidden('You can only change your own posts.');
  return post;
}

/** Deletes a replaced/removed cover photo from Cloudinary (never throws). */
async function dropCover(url: string | null | undefined) {
  const publicId = url && isOwnCloudinaryUrl(url) ? publicIdFromUrl(url) : null;
  if (publicId) await destroyImage(publicId);
}

// ---------- GET /v1/feed ----------

export const feedRouter = Router();
feedRouter.use(requireAuth);

/** GET /v1/feed?cursor= — everyone's posts, newest first, 10 per page. */
feedRouter.get('/', async (req, res) => {
  const viewer = currentUser(req);
  const { rows, nextCursor } = await paginate(
    limit => Post.find(afterCursor(req.query.cursor)).sort({ createdAt: -1, _id: -1 }).limit(limit) as Promise<PostDoc[]>,
    FEED_PAGE,
  );
  res.json({ items: await toPostViews(rows, viewer), nextCursor });
});

// ---------- /v1/posts ----------

export const postsRouter = Router();
postsRouter.use(requireAuth);

/** POST /v1/posts  { bookTitle, bookAuthor?, review, coverUri, coverPalette? } → 201 PostView */
postsRouter.post('/', validateBody(postBody), async (req, res) => {
  const user = currentUser(req);
  const body = req.body as PostBody;
  const count = await Post.estimatedDocumentCount();
  const post = (await Post.create({
    authorId: user._id,
    bookTitle: body.bookTitle,
    bookAuthor: body.bookAuthor,
    review: body.review,
    coverUrl: body.coverUri,
    coverPalette: body.coverPalette ?? COVER_PALETTES[count % COVER_PALETTES.length],
  })) as PostDoc;
  res.status(201).json(await toPostViewOne(post, user));
});

/** GET /v1/posts/:id */
postsRouter.get('/:id', async (req, res) => {
  res.json(await toPostViewOne(await findPost(req.params.id as string), currentUser(req)));
});

/** PATCH /v1/posts/:id — same body as create; author only. A replaced cover photo is deleted from Cloudinary. */
postsRouter.patch('/:id', validateBody(postBody), async (req, res) => {
  const user = currentUser(req);
  const post = await findOwnPost(req.params.id as string, user._id);
  const body = req.body as PostBody;
  const oldCover = post.coverUrl;
  post.bookTitle = body.bookTitle;
  post.bookAuthor = body.bookAuthor;
  post.review = body.review;
  post.coverUrl = body.coverUri;
  if (body.coverPalette) post.coverPalette = body.coverPalette;
  await post.save();
  if (oldCover && oldCover !== post.coverUrl) await dropCover(oldCover);
  res.json(await toPostViewOne(post, user));
});

/** DELETE /v1/posts/:id — author only. Removes its votes and cover photo too. */
postsRouter.delete('/:id', async (req, res) => {
  const user = currentUser(req);
  const post = await findOwnPost(req.params.id as string, user._id);
  await Promise.all([Post.deleteOne({ _id: post._id }), Vote.deleteMany({ postId: post._id })]);
  await dropCover(post.coverUrl);
  res.status(204).end();
});

/**
 * PUT /v1/posts/:id/vote  { value: 1 | 0 | -1 } → PostView
 * Idempotent: sending the same value twice changes nothing; 0 clears the vote.
 */
postsRouter.put('/:id/vote', validateBody(voteBody), async (req, res) => {
  const user = currentUser(req);
  const { value } = req.body as z.infer<typeof voteBody>;
  const post = await findPost(req.params.id as string);
  const key = { postId: post._id, userId: user._id };

  // Swap the vote row and get the previous value in one step.
  const prev =
    value === 0
      ? await Vote.findOneAndDelete(key)
      : await Vote.findOneAndUpdate(key, { $set: { value } }, { upsert: true, returnDocument: 'before', setDefaultsOnInsert: true });
  const before = (prev?.value as number | undefined) ?? 0;

  if (before !== value) {
    const inc = { upvotes: (value === 1 ? 1 : 0) - (before === 1 ? 1 : 0), downvotes: (value === -1 ? 1 : 0) - (before === -1 ? 1 : 0) };
    await Post.updateOne({ _id: post._id }, { $inc: inc });
  }
  res.json(await toPostViewOne((await findPost(req.params.id as string)), user));
});
