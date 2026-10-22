import type { Types } from 'mongoose';
import { User, toPublicAuthor, toPublicUser, type UserDoc } from '../../models/User.js';
import { Vote } from '../../models/Vote.js';
import type { PostDoc } from '../../models/Post.js';

/**
 * A post as the app's `PostView` type expects it: the post, its author and
 * the viewer's own vote (-1 / 0 / 1). Field names match the clients exactly.
 */
function toPostView(post: PostDoc, author: UserDoc, myVote: number, viewer: UserDoc) {
  const isMe = String(author._id) === String(viewer._id);
  return {
    id: post.id as string,
    authorId: String(post.authorId),
    bookTitle: post.bookTitle,
    bookAuthor: post.bookAuthor ?? null,
    review: post.review,
    coverUri: post.coverUrl ?? null,
    coverPalette: { bg: post.coverPalette?.bg ?? '#34332F', fg: post.coverPalette?.fg ?? '#E9DFC9' },
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    score: post.upvotes - post.downvotes,
    createdAt: (post.createdAt as Date).toISOString(),
    updatedAt: (post.updatedAt as Date).toISOString(),
    author: isMe ? toPublicUser(author) : toPublicAuthor(author),
    myVote,
  };
}

/** Joins authors and the viewer's votes for a list of posts in two queries. */
export async function toPostViews(posts: PostDoc[], viewer: UserDoc) {
  if (!posts.length) return [];
  const authorIds = [...new Set(posts.map(p => String(p.authorId)))];
  const [authors, votes] = await Promise.all([
    User.find({ _id: { $in: authorIds } }) as Promise<UserDoc[]>,
    Vote.find({ userId: viewer._id, postId: { $in: posts.map(p => p._id) } }, { postId: 1, value: 1 }) as Promise<
      { postId: Types.ObjectId; value: number }[]
    >,
  ]);
  const byId = new Map(authors.map(a => [String(a._id), a]));
  const myVotes = new Map(votes.map(v => [String(v.postId), v.value]));
  // A post whose author vanished mid-request is skipped rather than failing the page.
  return posts.flatMap(p => {
    const author = byId.get(String(p.authorId));
    return author ? [toPostView(p, author, myVotes.get(String(p._id)) ?? 0, viewer)] : [];
  });
}

export async function toPostViewOne(post: PostDoc, viewer: UserDoc) {
  const [view] = await toPostViews([post], viewer);
  return view!;
}

export type PostView = Awaited<ReturnType<typeof toPostViewOne>>;
