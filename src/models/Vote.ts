import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** One reader's vote on one post: +1 or -1. "No vote" means no row. */
const voteSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    value: { type: Number, required: true, enum: [1, -1] },
  },
  { timestamps: true },
);

voteSchema.index({ postId: 1, userId: 1 }, { unique: true });

export type VoteDoc = HydratedDocument<InferSchemaType<typeof voteSchema>>;
export const Vote = mongoose.models.Vote ?? mongoose.model('Vote', voteSchema);
