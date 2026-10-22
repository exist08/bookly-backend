import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const AVATAR_COLORS = ['#2F4A3A', '#8C5F12', '#6B2E3A', '#3D5A80', '#C8553A', '#34332F'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    /** bcrypt hash. Absent for accounts that only ever signed in with Google. Never selected by default. */
    passwordHash: { type: String, select: false },
    /**
     * Google account id (the ID token's `sub`). Unused until Google sign-in is
     * enabled — see src/modules/auth/google.ts. Kept in the schema now so the
     * index exists before the first Google user arrives.
     */
    googleSub: { type: String },
    provider: { type: String, enum: ['password', 'google'], required: true, default: 'password' },
    /** Empty until the reader finishes profile setup in the app. */
    username: { type: String, lowercase: true, trim: true, minlength: 3, maxlength: 24, match: /^[a-z0-9._]+$/ },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    bio: { type: String, default: '', trim: true, maxlength: 160 },
    avatarUrl: { type: String, default: null },
    avatarColor: { type: String, default: () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] },
    /**
     * Bumped on password change, "sign out everywhere" and account deletion.
     * Access tokens carry it, so bumping it invalidates every outstanding token at once.
     */
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Unique only when set: new accounts have no username yet.
userSchema.index({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } });
userSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } });

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);

/**
 * The account as the app sees it — same field names as the app's `User` type
 * (src/types/models.ts), so the mock API can be swapped out without touching screens.
 */
export function toPublicUser(user: UserDoc) {
  return {
    id: user.id as string,
    email: user.email,
    username: user.username ?? '',
    displayName: user.displayName,
    bio: user.bio ?? '',
    avatarUri: user.avatarUrl ?? null,
    avatarColor: user.avatarColor,
    provider: user.provider,
    profileComplete: Boolean(user.username),
    createdAt: (user.createdAt as Date).toISOString(),
  };
}

export type PublicUser = ReturnType<typeof toPublicUser>;

/** Another reader as others see them: no email address. */
export function toPublicAuthor(user: UserDoc) {
  return { ...toPublicUser(user), email: '' };
}
