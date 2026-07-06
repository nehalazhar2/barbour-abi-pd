import axios from 'axios';
import { config } from '../config.js';
import { getToken, invalidateToken } from './auth.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

const instance = axios.create({
  baseURL: config.barbourabi.baseUrl,
  headers: {
    'x-api-key': config.barbourabi.apiKey,
    Accept: 'application/json',
  },
  timeout: 30_000,
});

instance.interceptors.request.use(async (cfg) => {
  const token = await getToken();
  cfg.headers = cfg.headers || {};
  cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

instance.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status = error?.response?.status;
    const original = error?.config;
    if (status === 401 && original && !original._retriedAuth) {
      logger.warn('[barbourabi-client] 401 received — invalidating token and retrying once');
      original._retriedAuth = true;
      invalidateToken();
      try {
        const token = await getToken();
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${token}`;
        return instance.request(original);
      } catch (reauthErr) {
        return Promise.reject(reauthErr);
      }
    }
    return Promise.reject(error);
  },
);

export function request(opts, retryOpts = {}) {
  const label = retryOpts.label || `barbourabi ${opts.method || 'GET'} ${opts.url}`;
  return withRetry(() => instance.request(opts), { ...retryOpts, label });
}
