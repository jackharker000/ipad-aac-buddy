/**
 * backup-crypto — client-side end-to-end encryption for cloud backups.
 *
 * Parley stores a full snapshot of the user's on-device Dexie data in Firestore
 * (`user_backups/{uid}.data`). That data is sensitive and medical-adjacent (AAC
 * speech transcripts, personal context). This module encrypts the snapshot in
 * the browser so the SERVER — and any admin with DB access — only ever sees
 * ciphertext.
 *
 * ── Scheme ─────────────────────────────────────────────────────────────────
 *   Cipher:   AES-GCM, 256-bit key
 *   KDF:      PBKDF2 over the passphrase, SHA-256, >=100k iterations
 *   Salt:     16 random bytes, fresh per encryption
 *   IV/nonce: 12 random bytes, fresh per encryption (never reused with a key)
 *   AEAD:     GCM's built-in auth tag detects tampering AND a wrong passphrase
 *             (decrypt throws → we map it to a typed WrongPassphraseError).
 *
 * The output is a plain JSON-serialisable "envelope" safe to drop into a jsonb
 * column. All binary fields are base64. See `BackupEnvelope`.
 *
 * ── Threat model (READ THIS) ─────────────────────────────────────────────────
 *   This protects the CLOUD COPY, not the local device.
 *   The per-device passphrase is stored in localStorage (see the passphrase
 *   helpers below) so a returning session on the same device can decrypt
 *   without re-prompting. That means:
 *     • Someone who can read the Firestore document sees only ciphertext.  ✅
 *     • Someone with physical/JS access to THIS device can read the passphrase
 *       out of localStorage and decrypt.  ⚠️  (This is accepted — the device
 *       itself is trusted; the server is not.)
 *   If you ever need protection against local access, the passphrase must come
 *   from the user each session (memory-only) instead of localStorage.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Encrypted backup envelope — safe to store as jsonb. */
export interface BackupEnvelope {
  /** Envelope format version. */
  v: 1;
  /** Key-derivation function identifier. */
  kdf: "PBKDF2";
  /** PBKDF2 iteration count actually used. */
  iterations: number;
  /** PBKDF2 salt, base64. */
  salt: string;
  /** AES-GCM IV (12 bytes), base64. */
  iv: string;
  /** AES-GCM ciphertext (includes the GCM auth tag), base64. */
  ciphertext: string;
}

/** Thrown when decryption fails because the passphrase is wrong (or data tampered). */
export class WrongPassphraseError extends Error {
  constructor(message = "Unable to decrypt backup: wrong passphrase or corrupted data.") {
    super(message);
    this.name = "WrongPassphraseError";
  }
}

/** Thrown when an envelope is malformed / not a recognised encrypted backup. */
export class InvalidEnvelopeError extends Error {
  constructor(message = "Value is not a valid encrypted backup envelope.") {
    super(message);
    this.name = "InvalidEnvelopeError";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 150_000; // > 100k, comfortable on modern iPad Safari
const SALT_BYTES = 16;
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BITS = 256;

// ── Base64 helpers (browser-safe, no Buffer) ─────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // avoid call-stack limits on large arrays
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("Web Crypto (crypto.subtle) is unavailable in this environment.");
  }
  return c;
}

// ── Core crypto ──────────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES-GCM key from a passphrase + salt via PBKDF2/SHA-256.
 * The returned CryptoKey is non-extractable.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an arbitrary JSON-serialisable snapshot into a storable envelope.
 * Generates a fresh random salt and IV every call.
 */
export async function encryptSnapshot(
  snapshot: unknown,
  passphrase: string,
): Promise<BackupEnvelope> {
  const c = getCrypto();
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);

  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const cipherBuf = await c.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );

  return {
    v: 1,
    kdf: "PBKDF2",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
  };
}

/**
 * Decrypt an envelope back into the original snapshot object.
 * @throws {InvalidEnvelopeError} if the value isn't a recognised envelope.
 * @throws {WrongPassphraseError} if the passphrase is wrong or data was tampered.
 */
export async function decryptSnapshot<T = unknown>(
  envelope: BackupEnvelope,
  passphrase: string,
): Promise<T> {
  if (!isEncryptedEnvelope(envelope)) {
    throw new InvalidEnvelopeError();
  }
  const c = getCrypto();
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const iterations = envelope.iterations || PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);

  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await c.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // AES-GCM auth-tag failure surfaces as a DOMException with no useful detail.
    // The only realistic causes are a wrong passphrase or tampered ciphertext.
    throw new WrongPassphraseError();
  }

  const text = new TextDecoder().decode(plainBuf);
  return JSON.parse(text) as T;
}

/**
 * Structural type-guard: does this value look like an encrypted envelope
 * (vs. legacy plaintext snapshot)? Used by the pull path to branch.
 */
export function isEncryptedEnvelope(value: unknown): value is BackupEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    e.kdf === "PBKDF2" &&
    typeof e.iterations === "number" &&
    typeof e.salt === "string" &&
    typeof e.iv === "string" &&
    typeof e.ciphertext === "string"
  );
}

// ── Per-device passphrase management ─────────────────────────────────────────
//
// The passphrase is stored in localStorage, keyed per user id, so a returning
// session on the SAME device can decrypt without re-prompting. See the
// threat-model note at the top of this file — localStorage protects the cloud
// copy, not against someone with physical/JS access to this device.

const PASSPHRASE_KEY_PREFIX = "parley.e2e.passphrase.";

function passphraseStorageKey(userId: string): string {
  return `${PASSPHRASE_KEY_PREFIX}${userId}`;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Access can throw in some privacy modes / SSR.
    return null;
  }
}

/** Get the stored device passphrase for this user, or null if none. */
export function getDevicePassphrase(userId: string): string | null {
  const ls = safeLocalStorage();
  if (!ls || !userId) return null;
  return ls.getItem(passphraseStorageKey(userId));
}

/** Store the device passphrase for this user on this device. */
export function setDevicePassphrase(userId: string, passphrase: string): void {
  const ls = safeLocalStorage();
  if (!ls || !userId) return;
  ls.setItem(passphraseStorageKey(userId), passphrase);
}

/** Whether a device passphrase is stored for this user on this device. */
export function hasDevicePassphrase(userId: string): boolean {
  return getDevicePassphrase(userId) !== null;
}

/** Remove the stored device passphrase for this user (e.g. on sign-out). */
export function clearDevicePassphrase(userId: string): void {
  const ls = safeLocalStorage();
  if (!ls || !userId) return;
  ls.removeItem(passphraseStorageKey(userId));
}
