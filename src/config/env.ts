import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once at boot so a missing secret fails loudly
 * instead of producing tokens signed with `undefined`.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine(v => !v.includes('<db_password>'), 'replace <db_password> in .env with your Atlas database user password'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Google sign-in (enable together with src/modules/auth/google.ts)
  GOOGLE_CLIENT_IDS: z.string().optional(),
  // Cloudinary (photo uploads). Leave empty to run without uploads — upload endpoints then return 503.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('bookly'),
  // Public website URL, used in password-reset emails (…/reset?token=…).
  APP_URL: z.string().default('http://localhost:5173'),
  // Email (password reset). Without RESEND_API_KEY, emails are printed to the log instead.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Bookly <onboarding@resend.dev>'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
