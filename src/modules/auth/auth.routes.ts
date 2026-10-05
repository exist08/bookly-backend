import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { ApiError } from '../../lib/errors.js';
import { validateBody } from '../../lib/validate.js';
import { burnPasswordCheck, checkPassword, hashPassword } from '../../lib/passwords.js';
import { issueTokens, revokeAllSessions, revokeRefreshToken, rotateRefreshToken } from '../../lib/tokens.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { User, toPublicUser, type UserDoc } from '../../models/User.js';
import { refreshBody, signInBody, signOutBody, signUpBody } from './auth.schemas.js';
// import { googleSignIn } from './google.js'; // ← enable with Google sign-in (see google.ts)

export const authRouter = Router();

const clientInfo = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip });

/** Brute-force guard for the endpoints that take a password. */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res) =>
    res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' } }),
});

/**
 * POST /v1/auth/signup  { name, email, password }
 * Creates an email/password account. The user has no username yet
 * (profileComplete: false), so the app routes them to profile setup next.
 */
authRouter.post('/signup', credentialLimiter, validateBody(signUpBody), async (req, res) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };

  if (await User.exists({ email })) {
    throw ApiError.conflict('email_taken', 'An account with this email already exists.', 'email');
  }
  const user = (await User.create({
    email,
    displayName: name,
    passwordHash: await hashPassword(password),
    provider: 'password',
  })) as UserDoc;

  const tokens = await issueTokens(user, clientInfo(req));
  res.status(201).json({ user: toPublicUser(user), tokens });
});

/**
 * POST /v1/auth/signin  { email, password }
 * Same error for "no such email" and "wrong password" so the API never reveals
 * which emails have accounts.
 */
authRouter.post('/signin', credentialLimiter, validateBody(signInBody), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = (await User.findOne({ email }).select('+passwordHash')) as UserDoc | null;

  const ok = user?.passwordHash ? await checkPassword(password, user.passwordHash) : await burnPasswordCheck(password);
  if (!user || !ok) {
    if (user && !user.passwordHash && user.provider === 'google') {
      throw ApiError.badRequest('use_google', 'This account uses Google sign-in. Continue with Google instead.', 'password');
    }
    throw new ApiError(401, 'invalid_credentials', 'That email and password don’t match.', 'password');
  }

  const tokens = await issueTokens(user, clientInfo(req));
  res.json({ user: toPublicUser(user), tokens });
});

/**
 * POST /v1/auth/refresh  { refreshToken }
 * Trades a refresh token for a new pair. The old refresh token stops working.
 */
authRouter.post('/refresh', validateBody(refreshBody), async (req, res) => {
  const { refreshToken } = req.body as { refreshToken: string };
  const { user, tokens } = await rotateRefreshToken(
    refreshToken,
    async id => (await User.findById(id)) as UserDoc | null,
    clientInfo(req),
  );
  res.json({ user: toPublicUser(user), tokens });
});

/**
 * POST /v1/auth/signout  { refreshToken }
 * Signs this device out. Always 204, even for unknown tokens.
 */
authRouter.post('/signout', validateBody(signOutBody), async (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
  res.status(204).end();
});

/**
 * POST /v1/auth/signout-all   (Bearer)
 * Signs out every device: revokes all refresh tokens and invalidates access tokens.
 */
authRouter.post('/signout-all', requireAuth, async (req, res) => {
  const user = currentUser(req);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await revokeAllSessions(user._id);
  res.status(204).end();
});

/*
 * POST /v1/auth/google  { idToken }
 * ---------------------------------------------------------------------------
 * Disabled until Google Sign-In is set up in the app. To enable:
 *   1. Set GOOGLE_CLIENT_IDS in .env (iOS, Android and web client IDs).
 *   2. Uncomment the implementation in ./google.ts and its import above.
 *   3. Uncomment this route.
 *
 * authRouter.post('/google', credentialLimiter, validateBody(googleBody), async (req, res) => {
 *   const { idToken } = req.body as { idToken: string };
 *   const { user, created } = await googleSignIn(idToken);
 *   const tokens = await issueTokens(user, clientInfo(req));
 *   res.status(created ? 201 : 200).json({ user: toPublicUser(user), tokens });
 * });
 */
