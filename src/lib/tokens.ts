import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Session } from '../models/Session.js';
import { ApiError } from './errors.js';
import type { UserDoc } from '../models/User.js';

const ISSUER = 'bookly-api';
const AUDIENCE = 'bookly-app';

export interface AccessClaims {
  sub: string;
  /** user.tokenVersion at signing time */
  tv: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** seconds until the access token expires */
  expiresIn: number;
}

export function signAccessToken(user: UserDoc): { token: string; expiresIn: number } {
  const options: SignOptions = {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: user.id as string,
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  };
  const token = jwt.sign({ tv: user.tokenVersion ?? 0 }, env.JWT_ACCESS_SECRET, options);
  const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
  return { token, expiresIn: exp - iat };
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.tv !== 'number') {
      throw new Error('malformed');
    }
    return { sub: payload.sub, tv: payload.tv };
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token expired.', 'token_expired');
    }
    throw ApiError.unauthorized('Invalid access token.', 'invalid_token');
  }
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newOpaqueToken = () => crypto.randomBytes(48).toString('base64url');

interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

/** Creates a session row and returns a fresh access + refresh pair. */
export async function issueTokens(user: UserDoc, client: ClientInfo = {}): Promise<TokenPair> {
  const refreshToken = newOpaqueToken();
  await Session.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    userAgent: client.userAgent?.slice(0, 300),
    ip: client.ip,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
  });
  const access = signAccessToken(user);
  return { accessToken: access.token, refreshToken, expiresIn: access.expiresIn };
}

/**
 * Refresh-token rotation with reuse detection: each refresh token works once.
 * If an already-rotated token shows up again, someone else has a copy, so
 * every session for that user is revoked and they must sign in again.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  loadUser: (id: string) => Promise<UserDoc | null>,
  client: ClientInfo = {},
): Promise<{ user: UserDoc; tokens: TokenPair }> {
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) });
  if (!session) {
    throw ApiError.unauthorized('Please sign in again.', 'invalid_refresh_token');
  }
  if (session.revokedAt) {
    await Session.updateMany({ userId: session.userId, revokedAt: null }, { revokedAt: new Date() });
    throw ApiError.unauthorized('Please sign in again.', 'refresh_token_reused');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Please sign in again.', 'refresh_token_expired');
  }
  const user = await loadUser(String(session.userId));
  if (!user) {
    throw ApiError.unauthorized('Please sign in again.', 'invalid_refresh_token');
  }
  const tokens = await issueTokens(user, client);
  const next = await Session.findOne({ tokenHash: hashToken(tokens.refreshToken) }, { _id: 1 });
  session.revokedAt = new Date();
  session.replacedBy = next?._id ?? null;
  await session.save();
  return { user, tokens };
}

/** Signs one device out. Unknown tokens are ignored so sign-out is always safe to call. */
export async function revokeRefreshToken(refreshToken: string) {
  await Session.updateOne({ tokenHash: hashToken(refreshToken), revokedAt: null }, { revokedAt: new Date() });
}

export async function revokeAllSessions(userId: unknown) {
  await Session.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
}
