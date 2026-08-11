const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const DEFAULT_SCRYPT_PARAMS = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 256 * 1024 * 1024
});
const DEFAULT_TEMPORARY_PASSWORD = '123456';

class AsyncSemaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(action) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

const passwordWork = new AsyncSemaphore(2);

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) ? username : null;
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    return false;
  }
  const characterCount = Array.from(password).length;
  return characterCount >= 12 && characterCount <= 128 && Buffer.byteLength(password, 'utf8') <= 512;
}

function normalizeScryptParams(params = {}) {
  return { ...DEFAULT_SCRYPT_PARAMS, ...params };
}

async function deriveScrypt(password, salt, params) {
  const normalized = normalizeScryptParams(params);
  return passwordWork.run(() => scryptAsync(password, salt, normalized.keyLength, {
    N: normalized.N,
    r: normalized.r,
    p: normalized.p,
    maxmem: normalized.maxmem
  }));
}

async function encodePasswordHash(password, params = {}) {
  const normalized = normalizeScryptParams(params);
  const salt = crypto.randomBytes(normalized.saltLength);
  const derived = await deriveScrypt(password, salt, normalized);
  return [
    'scrypt',
    normalized.N,
    normalized.r,
    normalized.p,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url')
  ].join('$');
}

async function hashPassword(password, params = {}) {
  if (!validatePassword(password)) {
    throw new Error('Password must contain 12 to 128 characters');
  }
  return encodePasswordHash(password, params);
}

async function hashTemporaryPassword(params = {}) {
  return encodePasswordHash(DEFAULT_TEMPORARY_PASSWORD, params);
}

function parsePasswordHash(encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return null;
  }
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !salt.length || !expected.length) {
    return null;
  }
  return { N, r, p, salt, expected, keyLength: expected.length, maxmem: Math.max(256 * 1024 * 1024, 128 * N * r + 1024 * 1024) };
}

async function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 512) {
    return false;
  }
  const actual = Buffer.from(await deriveScrypt(password, parsed.salt, parsed));
  return actual.length === parsed.expected.length && crypto.timingSafeEqual(actual, parsed.expected);
}

async function performDummyPasswordCheck(password, params = {}) {
  const normalized = normalizeScryptParams(params);
  const boundedPassword = Buffer.from(String(password || ''), 'utf8').subarray(0, 512);
  await deriveScrypt(boundedPassword, Buffer.alloc(normalized.saltLength, 0x5a), normalized);
  return false;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest();
}

function deriveCsrfToken(sessionToken) {
  return crypto.createHmac('sha256', String(sessionToken || '')).update('card-storyboard-csrf-v1').digest('base64url');
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      return;
    }
    const name = part.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  });
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

class LoginRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, accountLimit = 5, ipLimit = 30 } = {}) {
    this.windowMs = windowMs;
    this.accountLimit = accountLimit;
    this.ipLimit = ipLimit;
    this.entries = new Map();
  }

  getEntry(key, now) {
    let entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      entry = { startedAt: now, failures: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  check(ip, username, now = Date.now()) {
    const accountEntry = this.getEntry(`account:${ip}:${username}`, now);
    const ipEntry = this.getEntry(`ip:${ip}`, now);
    const blocked = accountEntry.failures >= this.accountLimit || ipEntry.failures >= this.ipLimit;
    if (!blocked) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const retryAt = Math.min(accountEntry.startedAt, ipEntry.startedAt) + this.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
  }

  recordFailure(ip, username, now = Date.now()) {
    this.getEntry(`account:${ip}:${username}`, now).failures += 1;
    this.getEntry(`ip:${ip}`, now).failures += 1;
    if (this.entries.size > 5000) {
      for (const [key, entry] of this.entries) {
        if (now - entry.startedAt >= this.windowMs) {
          this.entries.delete(key);
        }
      }
    }
  }

  clear(ip, username) {
    this.entries.delete(`account:${ip}:${username}`);
  }
}

module.exports = {
  DEFAULT_SCRYPT_PARAMS,
  DEFAULT_TEMPORARY_PASSWORD,
  LoginRateLimiter,
  deriveCsrfToken,
  hashPassword,
  hashTemporaryPassword,
  normalizeScryptParams,
  normalizeUsername,
  parseCookies,
  performDummyPasswordCheck,
  randomToken,
  serializeCookie,
  stableHash,
  tokenHash,
  validatePassword,
  verifyPassword
};
