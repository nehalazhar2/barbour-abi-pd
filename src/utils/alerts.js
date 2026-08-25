import { Resend } from 'resend';
import { config } from '../config.js';
import { logger } from './logger.js';

let client = null;
function getClient() {
  if (client) return client;
  const { resendApiKey } = config.alerts;
  if (!resendApiKey) return null;
  client = new Resend(resendApiKey);
  return client;
}

export async function sendFailureAlert(error, context = {}) {
  const { email, from } = config.alerts;
  if (!email) {
    logger.warn('[alerts] ALERT_EMAIL not configured — skipping email');
    return;
  }
  if (!from) {
    logger.warn('[alerts] ALERT_EMAIL_FROM not configured — skipping email');
    return;
  }
  const c = getClient();
  if (!c) {
    logger.warn('[alerts] RESEND_API_KEY not configured — skipping email');
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const subject = `Barbour ABI Sync Failed — ${date}`;
  const text = [
    `Sync run failed at ${new Date().toISOString()}`,
    '',
    `Context: ${JSON.stringify(context, null, 2)}`,
    '',
    `Error: ${error?.message || error}`,
    '',
    'Stack:',
    error?.stack || '(no stack)',
  ].join('\n');

  try {
    const { data, error: sendErr } = await c.emails.send({ from, to: email, subject, text });
    if (sendErr) {
      logger.error(`[alerts] resend rejected: ${sendErr.message || JSON.stringify(sendErr)}`);
      return;
    }
    logger.info(`[alerts] failure alert sent to ${email} (id=${data?.id})`);
  } catch (mailErr) {
    logger.error(`[alerts] failed to send alert email: ${mailErr.message}`);
  }
}

// Multi-recipient plain-email helper used by the one-off saved-search backfill
// for hourly progress reports. Deliberately separate from sendFailureAlert so
// backfill emails don't get lost in a fleet of daily failure notifications.
export async function sendBackfillEmail({ to, subject, text }) {
  const { from } = config.alerts;
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) {
    logger.warn('[alerts] sendBackfillEmail called with no recipients — skipping');
    return;
  }
  // Never actually send during dry runs — dry-run backfills iterate through
  // real projects and would otherwise spam the configured recipients.
  if (config.dryRun) {
    logger.info(`[DRY RUN] sendBackfillEmail to ${recipients.join(', ')} — subject: "${subject}"`);
    return;
  }
  if (!from) {
    logger.warn('[alerts] ALERT_EMAIL_FROM not configured — skipping backfill email');
    return;
  }
  const c = getClient();
  if (!c) {
    logger.warn('[alerts] RESEND_API_KEY not configured — skipping backfill email');
    return;
  }
  try {
    const { data, error: sendErr } = await c.emails.send({ from, to: recipients, subject, text });
    if (sendErr) {
      logger.error(`[alerts] resend rejected backfill email: ${sendErr.message || JSON.stringify(sendErr)}`);
      return;
    }
    logger.info(`[alerts] backfill email sent to ${recipients.join(', ')} (id=${data?.id})`);
  } catch (mailErr) {
    logger.error(`[alerts] failed to send backfill email: ${mailErr.message}`);
  }
}
