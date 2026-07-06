import { request } from './client.js';

// Barbour ABI v4 users:
//   GET /users/{user_id} → { user: { user_id, first_name, last_name, email, username, ... } }
// Docs recommend caching results — names rarely change and we hit this per tag-sync project.

const cache = new Map();

export async function getUserById(userId) {
  if (userId == null) return null;
  const key = String(userId);
  if (cache.has(key)) return cache.get(key);
  const res = await request(
    { method: 'GET', url: `/users/${userId}` },
    { label: 'barbourabi-getUser' },
  );
  const user = res.data?.user ?? null;
  cache.set(key, user);
  return user;
}

export function describeUser(user) {
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.username || user.email || `user_id=${user.user_id}`;
}
