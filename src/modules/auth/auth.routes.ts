import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { ApiError } from '../../lib/errors.js';
import { validateBody } from '../../lib/validate.js';
import { burnPasswordCheck, checkPassword, hashPassword } from '../../lib/passwords.js';
import { issueTokens, revokeAllSessions, revokeRefreshToken, rotateRefreshToken } from '../../lib/tokens.js';
import { requireAuth, currentUser } from '../../middleware/auth.js';
import { User, toPublicUser, type UserDoc } from '../../models/User.js';
import { forgotPasswordBody, refreshBody, resetPasswordBody, signInBody, signOutBody, signUpBody } from './auth.schemas.js';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { sendMail } from '../../lib/mailer.js';
import { PasswordReset } from '../../models/PasswordReset.js';
import { googleBody, googleSignIn } from './google.js';

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

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * POST /v1/auth/password/forgot  { email } → 202
 * Emails a one-hour reset link to email/password accounts. Always answers 202,
 * so the endpoint never reveals which emails have accounts.
 */
authRouter.post('/password/forgot', credentialLimiter, validateBody(forgotPasswordBody), async (req, res) => {
  const { email } = req.body as { email: string };
  const user = (await User.findOne({ email }).select('+passwordHash')) as UserDoc | null;
  if (user?.passwordHash) {
    const token = crypto.randomBytes(32).toString('base64url');
    await PasswordReset.deleteMany({ userId: user._id });
    await PasswordReset.create({ userId: user._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
    const link = `${env.APP_URL.replace(/\/+$/, '')}/reset?token=${token}`;
    await sendMail(
      user.email,
      'Reset your Bookly password',
      `Hi ${user.displayName},\n\nTap the link below to choose a new password. It works for one hour.\n\n${link}\n\nIf you didn’t ask for this, you can ignore this email.`,
    );
  }
  res.status(202).json({ ok: true });
});

/**
 * POST /v1/auth/password/reset  { token, password } → 204
 * Sets the new password and signs out every device.
 */
authRouter.post('/password/reset', credentialLimiter, validateBody(resetPasswordBody), async (req, res) => {
  const { token, password } = req.body as { token: string; password: string };
  const reset = await PasswordReset.findOne({ tokenHash: sha256(token) });
  if (!reset || reset.expiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('invalid_reset_token', 'This reset link has expired. Ask for a new one.');
  }
  const user = (await User.findById(reset.userId)) as UserDoc | null;
  if (!user) throw ApiError.badRequest('invalid_reset_token', 'This reset link has expired. Ask for a new one.');
  user.passwordHash = await hashPassword(password);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await Promise.all([PasswordReset.deleteMany({ userId: user._id }), revokeAllSessions(user._id)]);
  res.status(204).end();
});

/**
 * POST /v1/auth/google  { idToken }
 * Verifies the Google ID token, finds/links/creates the reader, issues Bookly tokens.
 * 201 for a new account (app sends them to profile setup), 200 otherwise.
 */
authRouter.post('/google', credentialLimiter, validateBody(googleBody), async (req, res) => {
  const { idToken } = req.body as { idToken: string };
  const { user, created } = await googleSignIn(idToken);
  const tokens = await issueTokens(user, clientInfo(req));
  res.status(created ? 201 : 200).json({ user: toPublicUser(user), tokens });
});
