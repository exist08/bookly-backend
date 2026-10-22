import mongoose from 'mongoose';

/**
 * Keyset pagination for "newest first" lists. The cursor encodes the last
 * item's (createdAt, _id), so pages stay stable while new posts arrive.
 */
export function encodeCursor(doc: { createdAt: Date; _id: unknown }) {
  return Buffer.from(`${doc.createdAt.toISOString()}|${String(doc._id)}`).toString('base64url');
}

/** Mongo filter for "older than the cursor", or {} for the first page. Bad cursors start from the top. */
export function afterCursor(cursor: unknown): Record<string, unknown> {
  if (typeof cursor !== 'string' || !cursor) return {};
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime()) || !id || !mongoose.isValidObjectId(id)) return {};
  const _id = new mongoose.Types.ObjectId(id);
  return { $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: _id } }] };
}

/** Fetch one extra row to know whether there's a next page. */
export async function paginate<T extends { createdAt: Date; _id: unknown }>(
  fetch: (limit: number) => Promise<T[]>,
  size: number,
): Promise<{ rows: T[]; nextCursor: string | null }> {
  const rows = await fetch(size + 1);
  const more = rows.length > size;
  const page = more ? rows.slice(0, size) : rows;
  return { rows: page, nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
}
