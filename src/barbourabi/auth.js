import axios from 'axios';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

// Barbour ABI v4 auth flow:
//   GET /v4/login
//   Headers: Authorization: Basic base64(username:sha256_hex(password)), x-api-key: <key>
//   Response: 200, token returned in the `token` RESPONSE HEADER (body has user_id only).
//   Subsequent calls: Authorization: Bearer <token>, x-api-key: <key>
//   Token TTL: invalidated after 30 days of inactivity, or sooner on platform release.

let cachedToken = null;

const sha256Hex = (input) => createHash('sha256').update(input, 'utf8').digest('hex');

const buildBasicAuth = () => {
  const { username, password } = config.barbourabi;
  if (!username || !password) {
    throw new Error('BARBOURABI_USERNAME and BARBOURABI_PASSWORD must be set');
  }
  const hashed = sha256Hex(password);
  return 'Basic ' + Buffer.from(`${username}:${hashed}`).toString('base64');
};

async function login() {
  const { apiKey, baseUrl } = config.barbourabi;
  if (!apiKey) throw new Error('BARBOURABI_API_KEY must be set');

  logger.info('[barbourabi-auth] logging in');
  const res = await withRetry(
    () =>
      axios.get(`${baseUrl}/login`, {
        headers: {
          Authorization: buildBasicAuth(),
          'x-api-key': apiKey,
        },
      }),
    { label: 'barbourabi-login' },
  );

  const token = res?.headers?.token;
  if (!token || typeof token !== 'string') {
    throw new Error('barbourabi login: missing "token" response header');
  }
  cachedToken = token.trim();
  logger.info(`[barbourabi-auth] logged in (user_id=${res.data?.user_id})`);
  return cachedToken;
}

export async function getToken() {
  if (cachedToken) return cachedToken;
  return login();
}

export function invalidateToken() {
  cachedToken = null;
}
