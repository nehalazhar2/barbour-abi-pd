import { logger } from './logger.js';

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const defaultShouldRetry = (err) => {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status <= 599 && status !== 501) return true;
  if (!status) {
    // no HTTP response — treat as network error
    if (err?.code && NETWORK_CODES.has(err.code)) return true;
    if (err?.message?.toLowerCase().includes('network')) return true;
  }
  return false;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseMs = 1000,
    shouldRetry = defaultShouldRetry,
    label = 'request',
  } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < retries && shouldRetry(err);
      if (!canRetry) throw err;
      const delay = baseMs * 2 ** attempt;
      const status = err?.response?.status ?? err?.code ?? 'err';
      logger.warn(
        `[retry] ${label} failed (${status}); attempt ${attempt + 1}/${retries} — waiting ${delay}ms`,
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}
