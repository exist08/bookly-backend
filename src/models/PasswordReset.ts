import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** A pending "forgot password" link. Only the SHA-256 of the token is stored; rows expire after an hour. */
const passwordResetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PasswordResetDoc = HydratedDocument<InferSchemaType<typeof passwordResetSchema>>;
export const PasswordReset = mongoose.models.PasswordReset ?? mongoose.model('PasswordReset', passwordResetSchema);
