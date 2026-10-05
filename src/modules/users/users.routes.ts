import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';

export const usersRouter = Router();

export const username = z
  .string({ error: 'Pick a username.' })
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,24}$/, '3–24 characters: letters, numbers, dots and underscores.');

/**
 * GET /v1/users/username-available?username=aarav.reads
 * Powers the live check under the username field. Public, so it works during profile setup.
 */
usersRouter.get('/username-available', async (req, res) => {
  const parsed = username.safeParse(req.query.username ?? '');
  if (!parsed.success) {
    res.json({ available: false, reason: 'invalid', message: parsed.error.issues[0]?.message });
    return;
  }
  const taken = await User.exists({ username: parsed.data });
  res.json({ available: !taken, reason: taken ? 'taken' : undefined });
});
