/**
 * Google sign-in — POST /v1/auth/google.
 *
 * How it will work
 *   1. The app signs in with @react-native-google-signin/google-signin and
 *      receives an ID token (a JWT signed by Google).
 *   2. The app POSTs it to /v1/auth/google.
 *   3. We verify the signature against Google's public keys, check the
 *      audience is one of OUR client IDs and the email is verified, then find
 *      or create the Bookly account and issue our own tokens.
 *
 * Account linking rules
 *   - Match on googleSub first (the stable Google account id).
 *   - Otherwise, if a Bookly account already exists for the same VERIFIED
 *     email, link it (set googleSub) so the reader keeps one account.
 *   - Otherwise create a new account with provider "google" and no password;
 *     it has no username yet, so the app sends the reader to profile setup.
 *
 *
 * Config: GOOGLE_CLIENT_IDS in .env (web, iOS and Android client IDs).
 */

import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { User, type UserDoc } from '../../models/User.js';

export const googleBody = z.object({
  idToken: z.string({ error: 'idToken is required.' }).min(100),
});

const client = new OAuth2Client();

function allowedAudiences(): string[] {
  const ids = (env.GOOGLE_CLIENT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) {
    throw new ApiError(503, 'google_not_configured', 'Google sign-in isn’t available right now.');
  }
  return ids;
}

export async function googleSignIn(idToken: string): Promise<{ user: UserDoc; created: boolean }> {
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: allowedAudiences() });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized('Google sign-in failed. Please try again.', 'invalid_google_token');
  }
  if (!payload?.sub || !payload.email) {
    throw ApiError.unauthorized('Google sign-in failed. Please try again.', 'invalid_google_token');
  }
  if (!payload.email_verified) {
    throw ApiError.forbidden('Verify your Google email address first.', 'google_email_unverified');
  }

  const email = payload.email.toLowerCase();

  // 1. Returning Google user
  const bySub = (await User.findOne({ googleSub: payload.sub })) as UserDoc | null;
  if (bySub) {
    return { user: bySub, created: false };
  }

  // 2. Existing email/password account with the same verified email → link it
  const byEmail = (await User.findOne({ email })) as UserDoc | null;
  if (byEmail) {
    byEmail.googleSub = payload.sub;
    if (!byEmail.avatarUrl && payload.picture) {
      byEmail.avatarUrl = payload.picture;
    }
    await byEmail.save();
    return { user: byEmail, created: false };
  }

  // 3. New reader
  const user = (await User.create({
    email,
    googleSub: payload.sub,
    provider: 'google',
    displayName: (payload.name ?? email.split('@')[0]).slice(0, 60),
    avatarUrl: payload.picture ?? null,
  })) as UserDoc;
  return { user, created: true };
}

