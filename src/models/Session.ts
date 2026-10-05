import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * One row per signed-in device. The refresh token itself is never stored,
 * only its SHA-256 hash. Rows are rotated on every refresh and expire on
 * their own through the TTL index.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
    expiresAt: { type: Date, required: true },
    /** Set when the token was rotated or the device signed out. A revoked token being reused means it was stolen. */
    revokedAt: { type: Date, default: null },
    replacedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

// MongoDB deletes the document once expiresAt has passed.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;
export const Session = mongoose.models.Session ?? mongoose.model('Session', sessionSchema);
