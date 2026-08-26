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
