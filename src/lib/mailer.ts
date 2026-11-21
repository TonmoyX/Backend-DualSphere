import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  if (!transport) {
    // Dev fallback: emails are printed so links can be clicked from the terminal
    logger.info({ to, subject }, `📧 [mail:dev] ${subject}\n${text}`);
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
  } catch (err) {
    logger.error({ err }, 'Failed to send email');
  }
}

export const mailTemplates = {
  verify: (link: string) => ({
    subject: 'Verify your DualSphere email',
    text: `Welcome to DualSphere!\n\nConfirm your email address by opening this link (valid 24h):\n${link}\n\nIf you didn't sign up, ignore this email.`,
  }),
  reset: (link: string) => ({
    subject: 'Reset your DualSphere password',
    text: `Someone requested a password reset for your DualSphere account.\n\nReset it here (valid 1h):\n${link}\n\nIf this wasn't you, you can ignore this email — your password won't change.`,
  }),
  newDevice: (when: string, ua: string) => ({
    subject: 'New sign-in to your DualSphere account',
    text: `We noticed a sign-in from a new device at ${when}.\nDevice: ${ua}\n\nIf this was you, no action is needed. Otherwise, reset your password and revoke sessions from Settings → Security.`,
  }),
};
