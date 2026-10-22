import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Colours for the typographic cover shown when a post has no photo. */
export const COVER_PALETTES = [
  { bg: '#2F4A3A', fg: '#F1E4C3' },
  { bg: '#1F3A5F', fg: '#F3EBDD' },
  { bg: '#E8DCC4', fg: '#7A1F1F' },
  { bg: '#C9A24A', fg: '#1B1814' },
  { bg: '#6B2E3A', fg: '#F4E6D8' },
  { bg: '#C8553A', fg: '#FBF3E4' },
  { bg: '#34332F', fg: '#E9DFC9' },
  { bg: '#EFD8CF', fg: '#6B2E3A' },
  { bg: '#0F2D2A', fg: '#D9B26A' },
  { bg: '#5A1E24', fg: '#EFD9C4' },
  { bg: '#DCE3DA', fg: '#2F4A3A' },
  { bg: '#2B2440', fg: '#E8D9B8' },
];

const postSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bookTitle: { type: String, required: true, trim: true, maxlength: 200 },
    bookAuthor: { type: String, default: null, trim: true, maxlength: 120 },
    review: { type: String, required: true, trim: true, maxlength: 500 },
    /** Cloudinary URL, or null for a typographic cover. */
    coverUrl: { type: String, default: null },
    coverPalette: {
      bg: { type: String, required: true },
      fg: { type: String, required: true },
    },
    /** Denormalised vote counts, kept in step by PUT /v1/posts/:id/vote. */
    upvotes: { type: Number, default: 0, min: 0 },
    downvotes: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// Feed: newest first. Shelf: one author's posts, newest first. _id breaks ties for stable paging.
postSchema.index({ createdAt: -1, _id: -1 });
postSchema.index({ authorId: 1, createdAt: -1, _id: -1 });

export type PostAttrs = InferSchemaType<typeof postSchema>;
export type PostDoc = HydratedDocument<PostAttrs>;
export const Post = mongoose.models.Post ?? mongoose.model('Post', postSchema);
