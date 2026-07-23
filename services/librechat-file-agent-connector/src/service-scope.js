import { createHmac, timingSafeEqual } from 'node:crypto';

import { sha256 } from './stable.js';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signature(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function normalizeBody(body) {
  if (body == null) {
    return '';
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function idempotencyKeyDigest(headers) {
  const normalized = new Headers(headers);
  return sha256(normalized.get('idempotency-key') ?? '');
}

export class ServiceScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServiceScopeError';
    this.statusCode = 401;
  }
}

export class ServiceScopeSigner {
  constructor({ secret, issuer = 'librechat', audience = 'file-agent-runtime', ttlSeconds = 60 }) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new TypeError('Service scope secret must contain at least 32 characters');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
      throw new TypeError('Service scope ttlSeconds must be between 1 and 300');
    }
    this.secret = secret;
    this.issuer = issuer;
    this.audience = audience;
    this.ttlSeconds = ttlSeconds;
  }

  sign({ method, pathname, body = '', headers = {}, now = Date.now() }) {
    const header = { alg: 'HS256', typ: 'FAS' };
    const issuedAt = Math.floor(now / 1000);
    const payload = {
      iss: this.issuer,
      aud: this.audience,
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
      method: method.toUpperCase(),
      pathname,
      bodyDigest: sha256(normalizeBody(body)),
      idempotencyKeyDigest: idempotencyKeyDigest(headers),
    };
    const encoded = `${encode(header)}.${encode(payload)}`;
    return `${encoded}.${signature(this.secret, encoded)}`;
  }

  verify(token, { method, pathname, body = '', headers = {}, now = Date.now() }) {
    if (typeof token !== 'string' || token === '') {
      throw new ServiceScopeError('Missing service scope token');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new ServiceScopeError('Malformed service scope token');
    }
    const encoded = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(signature(this.secret, encoded));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ServiceScopeError('Invalid service scope signature');
    }
    let header;
    let payload;
    try {
      header = decode(parts[0]);
      payload = decode(parts[1]);
    } catch {
      throw new ServiceScopeError('Malformed service scope payload');
    }
    const nowSeconds = Math.floor(now / 1000);
    if (
      header.alg !== 'HS256' ||
      header.typ !== 'FAS' ||
      payload.iss !== this.issuer ||
      payload.aud !== this.audience
    ) {
      throw new ServiceScopeError('Service scope issuer or audience mismatch');
    }
    if (
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= nowSeconds ||
      payload.iat > nowSeconds + 5 ||
      payload.exp - payload.iat > this.ttlSeconds
    ) {
      throw new ServiceScopeError('Service scope token expired or not active');
    }
    if (payload.method !== method.toUpperCase() || payload.pathname !== pathname) {
      throw new ServiceScopeError('Service scope request target mismatch');
    }
    if (payload.bodyDigest !== sha256(normalizeBody(body))) {
      throw new ServiceScopeError('Service scope body digest mismatch');
    }
    if (payload.idempotencyKeyDigest !== idempotencyKeyDigest(headers)) {
      throw new ServiceScopeError('Service scope idempotency key mismatch');
    }
    return payload;
  }
}

export function createRuntimeAuthorizer(signer) {
  return async (request) => {
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const url = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
    signer.verify(token, {
      method: request.method,
      pathname: `${url.pathname}${url.search}`,
      body,
      headers: request.headers,
    });
    return true;
  };
}
