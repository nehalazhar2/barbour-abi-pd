import axios from 'axios';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

// Client-side rate limiter — Pipedrive's per-token cap is roughly 10 req/s
// sustained, and the first production run hit sustained 429s that only recovered
// via exp-backoff (adding ~7s of dead time per hit). 150ms between request starts
// keeps us at ~6.6 req/s, comfortably under the limit, and eliminates 429s at
// source. `lastCallAt` is "reserved" before the sleep so concurrent callers
// serialise correctly instead of all racing on the same timestamp.
const MIN_INTERVAL_MS = 150;
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttle() {
  const now = Date.now();
  const waitMs = Math.max(0, MIN_INTERVAL_MS - (now - lastCallAt));
  lastCallAt = now + waitMs;
  if (waitMs > 0) await sleep(waitMs);
}

const authParams = () => ({ api_token: config.pipedrive.apiToken });

const v1 = axios.create({
  baseURL: config.pipedrive.baseUrlV1,
  timeout: 30_000,
  headers: { Accept: 'application/json' },
});

const v2 = axios.create({
  baseURL: config.pipedrive.baseUrlV2,
  timeout: 30_000,
  headers: { Accept: 'application/json' },
});

for (const inst of [v1, v2]) {
  inst.interceptors.request.use((cfg) => {
    cfg.params = { ...authParams(), ...(cfg.params || {}) };
    return cfg;
  });
}

// In DRY_RUN mode, intercept writes (POST/PATCH/PUT/DELETE) before they hit Pipedrive.
// GETs (including itemSearch dedup lookups) still run live so the simulation is realistic.
let dryRunCounter = 0;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function maybeDryRun(opts, apiLabel) {
  if (!config.dryRun) return null;
  const method = (opts.method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(method)) return null;
  dryRunCounter += 1;
  const fakeId = `dry-run-${dryRunCounter}`;
  logger.info(`[DRY RUN] ${apiLabel} ${method} ${opts.url} → skipped (fake id ${fakeId})`);
  // Mimic Pipedrive's typical { data: { id, ... } } envelope so callers reading res.data?.data?.id work.
  return { data: { data: { id: fakeId } } };
}

export function requestV1(opts, retryOpts = {}) {
  const label = retryOpts.label || `pd-v1 ${opts.method || 'GET'} ${opts.url}`;
  const stub = maybeDryRun(opts, 'pd-v1');
  if (stub) return Promise.resolve(stub);
  return withRetry(
    async () => {
      await throttle();
      return v1.request(opts);
    },
    { ...retryOpts, label },
  );
}

export function requestV2(opts, retryOpts = {}) {
  const label = retryOpts.label || `pd-v2 ${opts.method || 'GET'} ${opts.url}`;
  const stub = maybeDryRun(opts, 'pd-v2');
  if (stub) return Promise.resolve(stub);
  return withRetry(
    async () => {
      await throttle();
      return v2.request(opts);
    },
    { ...retryOpts, label },
  );
}
