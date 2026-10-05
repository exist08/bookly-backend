import { z } from 'zod';

// Messages match the copy the app already shows under each field.
export const email = z
  .string({ error: 'Enter your email.' })
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address.' }));

export const newPassword = z
  .string({ error: 'Enter a password.' })
  .min(8, 'Use at least 8 characters.')
  // bcrypt only looks at the first 72 bytes.
  .refine(p => Buffer.byteLength(p, 'utf8') <= 72, 'Use 72 characters or fewer.');

export const signUpBody = z.object({
  name: z.string({ error: 'Add your name.' }).trim().min(1, 'Add your name.').max(60, 'Keep your name under 60 characters.'),
  email,
  password: newPassword,
});

export const signInBody = z.object({
  email,
  password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.'),
});

export const refreshBody = z.object({
  refreshToken: z.string({ error: 'refreshToken is required.' }).min(20),
});

export const signOutBody = z.object({
  refreshToken: z.string().min(20).optional(),
});
