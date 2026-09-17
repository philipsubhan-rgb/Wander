/**
 * Lightweight email utility.
 *
 * Reads SMTP configuration from environment variables.  When the variables are
 * not set the function logs the email to stdout (useful in development) and
 * returns `{ sent: false }` — the invite route treats this as a non-fatal
 * condition and still returns the temporary password in the response body so
 * the admin can relay it manually.
 *
 * Required env vars to enable real sending:
 *   SMTP_HOST   — e.g. smtp.mailgun.org
 *   SMTP_PORT   — e.g. 587 (defaults to 587)
 *   SMTP_USER   — SMTP auth username
 *   SMTP_PASS   — SMTP auth password
 *   SMTP_FROM   — "From" address, e.g. noreply@wanderapp.example
 */

import nodemailer from "nodemailer";
import { logger } from "./logger.js";

export interface SendResult {
  sent: boolean;
}

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT ?? "587"),
    secure: (process.env.SMTP_PORT ?? "587") === "465",
    auth: { user, pass },
  });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  name: string;
  resetUrl: string;
}): Promise<SendResult> {
  const { to, name, resetUrl } = opts;

  const subject = "Reset your Wander password";

  const html = `
<p>Hi ${name},</p>
<p>We received a request to reset your Wander password. Click the link below to set a new password. This link expires in 1 hour.</p>
<p><a href="${resetUrl}">Reset my password</a></p>
<p>If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
<p>— The Wander team</p>
`.trim();

  const text = `Hi ${name},\n\nWe received a request to reset your Wander password. Visit the link below to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.\n\n— The Wander team`;

  const transport = buildTransport();

  if (!transport) {
    // Do NOT log the reset URL — it contains a credential (the raw token).
    // In development, configure SMTP or retrieve the token from the DB directly.
    logger.info(
      { to },
      "SMTP not configured — password reset email not sent; configure SMTP vars to enable sending"
    );
    return { sent: false };
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    logger.error({ err, to }, "Failed to send password reset email");
    return { sent: false };
  }
}

export async function sendWelcomeEmail(opts: {
  to: string;
  name: string;
  username: string;
  temporaryPassword: string;
  tripTitle?: string;
}): Promise<SendResult> {
  const { to, name, username, temporaryPassword, tripTitle } = opts;

  const tripLine = tripTitle
    ? `You have been added to the trip <strong>${tripTitle}</strong>.`
    : "You have been added to a trip.";

  const subject = tripTitle
    ? `You're invited to "${tripTitle}" on Wander`
    : "Your Wander account is ready";

  const html = `
<p>Hi ${name},</p>
<p>${tripLine} Your account has been created so you can view the itinerary, expenses, and more.</p>
<p><strong>Your login details:</strong></p>
<ul>
  <li><strong>Email / username:</strong> ${username}</li>
  <li><strong>Temporary password:</strong> ${temporaryPassword}</li>
</ul>
<p>Please log in and change your password as soon as possible.</p>
<p>— The Wander team</p>
`.trim();

  const text = `Hi ${name},\n\n${tripTitle ? `You have been added to the trip "${tripTitle}".` : "You have been added to a trip."} Your account has been created.\n\nEmail / username: ${username}\nTemporary password: ${temporaryPassword}\n\nPlease log in and change your password as soon as possible.\n\n— The Wander team`;

  const transport = buildTransport();

  if (!transport) {
    // SMTP not configured — log only non-sensitive metadata (never log credentials)
    logger.info(
      { to },
      "SMTP not configured — welcome email not sent; admin must relay credentials manually"
    );
    return { sent: false };
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    logger.error({ err, to }, "Failed to send welcome email — invite continues without email");
    return { sent: false };
  }
}

/**
 * Send the daily one-page trip briefing email with the PDF attached.
 *
 * `to` may hold multiple recipients. When SMTP is not configured the email
 * is skipped (not queued) and `{ sent: false }` is returned. Never throws.
 */
export async function sendDailyBriefingEmail(opts: {
  to: string[];
  tripTitle: string;
  dateLabel: string;
  pdfBuffer: Buffer;
  filename: string;
}): Promise<SendResult> {
  const { to, tripTitle, dateLabel, pdfBuffer, filename } = opts;

  const subject = `Wander one-pager: ${tripTitle} — ${dateLabel}`;
  const text = `Your one-page briefing for ${dateLabel} is attached.\n\n— The Wander team`;

  const transport = buildTransport();

  if (!transport) {
    // Log only the recipient count — never individual addresses here.
    logger.info(
      { recipientCount: to.length },
      "SMTP not configured — daily briefing email not sent"
    );
    return { sent: false };
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });
    return { sent: true };
  } catch (err) {
    logger.error({ err, recipientCount: to.length }, "Failed to send daily briefing email");
    return { sent: false };
  }
}
