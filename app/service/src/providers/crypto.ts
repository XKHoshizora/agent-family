import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Providers' API keys at rest. AES-256-GCM under a key derived from `PROVIDER_KEY_SECRET` with HKDF-SHA-256; a
 * random 12-byte nonce per seal. Layout: `version(1) | nonce(12) | tag(16) | ciphertext`. Besides this file, only
 * `loadProviderForCall` (store.ts) ever holds a key in plaintext, to hand it to the upstream call.
 */

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
/** HKDF `info`: binds the derived key to this one use of the secret. */
const INFO = "agent-family/provider-api-key/v1";

function derive(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
}

/** Seals a provider's API key for storage (`providers.key_cipher`). */
export function sealKey(plain: string, secret: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(secret), nonce, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]);
}

/** A stored key that cannot be opened: another `PROVIDER_KEY_SECRET`, or a damaged value. Says nothing of the key. */
export class KeyUnreadableError extends Error {
  constructor() {
    super("a stored provider key could not be opened: PROVIDER_KEY_SECRET differs from the one it was sealed with, or the value is damaged");
    this.name = "KeyUnreadableError";
  }
}

/** Opens what `sealKey` sealed; throws `KeyUnreadableError` for anything else. */
export function openKey(cipher: Buffer, secret: string): string {
  if (cipher.length < HEADER_BYTES || cipher[0] !== VERSION) throw new KeyUnreadableError();
  const decipher = createDecipheriv("aes-256-gcm", derive(secret), cipher.subarray(1, 1 + NONCE_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(cipher.subarray(1 + NONCE_BYTES, HEADER_BYTES));
  try {
    return Buffer.concat([decipher.update(cipher.subarray(HEADER_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new KeyUnreadableError();
  }
}
