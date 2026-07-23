import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

function decodeKey(value, field) {
  const key = Buffer.from(String(value), 'base64');
  if (key.length !== 32) throw new Error(`${field} must decode to exactly 32 bytes`);
  return key;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64url(value) {
  return Buffer.from(String(value), 'base64url');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deriveBase64Key(secret, label) {
  if (!secret) throw new Error(`${label} requires a secret source`);
  return createHash('sha256').update(`${label}\0${secret}`).digest('base64');
}

export function internalContextSecret(environment = process.env) {
  return environment.OAUTH_INTERNAL_CONTEXT_SECRET || environment.SERVER_TOKEN || '';
}

export class SecretBox {
  #key;

  constructor(base64Key) {
    this.#key = decodeKey(base64Key, 'encryption key');
  }

  encryptJson(value, context) {
    if (!context || String(context).trim().length === 0) {
      throw new Error('encryption context is required');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return b64url(JSON.stringify({
      v: 1,
      alg: 'A256GCM',
      context,
      iv: b64url(iv),
      tag: b64url(cipher.getAuthTag()),
      ciphertext: b64url(ciphertext),
    }));
  }

  decryptJson(encoded, expectedContext) {
    let envelope;
    try {
      envelope = JSON.parse(fromB64url(encoded).toString('utf8'));
    } catch {
      throw new Error('encrypted envelope is malformed');
    }
    if (
      envelope?.v !== 1
      || envelope?.alg !== 'A256GCM'
      || envelope?.context !== expectedContext
    ) {
      throw new Error('encrypted envelope metadata does not match');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, fromB64url(envelope.iv));
      decipher.setAAD(Buffer.from(expectedContext, 'utf8'));
      decipher.setAuthTag(fromB64url(envelope.tag));
      const plaintext = Buffer.concat([
        decipher.update(fromB64url(envelope.ciphertext)),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error('encrypted envelope authentication failed');
    }
  }
}

export class SessionCookieCodec {
  #key;

  constructor(base64Key) {
    this.#key = decodeKey(base64Key, 'cookie signing key');
  }

  encode(value) {
    const payload = b64url(JSON.stringify(value));
    const signature = createHmac('sha256', this.#key).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  decode(encoded, now = new Date(), options = {}) {
    const parts = String(encoded).split('.');
    if (parts.length !== 2) throw new Error('session cookie is malformed');
    const [payload, suppliedSignature] = parts;
    const expected = createHmac('sha256', this.#key).update(payload).digest('base64url');
    if (!secureEqual(suppliedSignature, expected)) {
      throw new Error('session cookie signature is invalid');
    }
    let value;
    try {
      value = JSON.parse(fromB64url(payload).toString('utf8'));
    } catch {
      throw new Error('session cookie payload is malformed');
    }
    const expiry = new Date(value?.expiresAt);
    if (Number.isNaN(expiry.valueOf()) || expiry.toISOString() !== value.expiresAt) {
      throw new Error('session cookie expiry is invalid');
    }
    if (!options.allowExpired && now.valueOf() >= expiry.valueOf()) {
      throw new Error('session cookie has expired');
    }
    if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
      throw new Error('session cookie request ID is invalid');
    }
    return value;
  }
}

export function encodeInternalContext(value, secret) {
  if (!secret) throw new Error('internal OAuth context secret is missing');
  const payload = b64url(JSON.stringify(value));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeInternalContext(encoded, secret, now = new Date()) {
  if (!secret) throw new Error('internal OAuth context secret is missing');
  const parts = String(encoded).split('.');
  if (parts.length !== 2) throw new Error('internal OAuth context is malformed');
  const [payload, suppliedSignature] = parts;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!secureEqual(suppliedSignature, expected)) {
    throw new Error('internal OAuth context signature is invalid');
  }
  let value;
  try {
    value = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch {
    throw new Error('internal OAuth context payload is malformed');
  }
  const expiry = new Date(value?.expiresAt);
  if (Number.isNaN(expiry.valueOf()) || now.valueOf() >= expiry.valueOf()) {
    throw new Error('internal OAuth context expired');
  }
  if (!Array.isArray(value?.scopes) || value.scopes.some((scope) => typeof scope !== 'string')) {
    throw new Error('internal OAuth context scopes are invalid');
  }
  return value;
}
