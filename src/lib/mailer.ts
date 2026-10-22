import { env } from '../config/env.js';

/**
 * Sends transactional email through Resend (https://resend.com) when
 * RESEND_API_KEY is set. Without it the message is logged instead, so the
 * password-reset flow can still be tried in development.
 */
export async function sendMail(to: string, subject: string, text: string) {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail] (no RESEND_API_KEY — not sent)\n  to: ${to}\n  subject: ${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error('[mail] send failed:', res.status, (await res.text()).slice(0, 300));
  }
}
