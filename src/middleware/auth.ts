import type { RequestHandler } from 'express';
import { ApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { User, type UserDoc } from '../models/User.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
    }
  }
}

/**
 * Requires `Authorization: Bearer <accessToken>`. Loads the user and checks the
 * token's version, so tokens die immediately after a password change,
 * "sign out everywhere" or account deletion.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Sign in to continue.', 'missing_token');
  }
  const claims = verifyAccessToken(token);
  const user = (await User.findById(claims.sub)) as UserDoc | null;
  if (!user || (user.tokenVersion ?? 0) !== claims.tv) {
    throw ApiError.unauthorized();
  }
  req.user = user;
  next();
};

/** For handlers behind requireAuth. */
export function currentUser(req: Express.Request): UserDoc {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return req.user;
}
