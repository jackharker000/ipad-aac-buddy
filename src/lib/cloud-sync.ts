import { db } from "./db";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db as firestore, isFirebaseConfigured } from "@/integrations/firebase/client";
import {
  encryptSnapshot,
  decryptSnapshot,
  isEncryptedEnvelope,
  getDevicePassphrase,
  setDevicePassphrase,
  WrongPassphraseError,
  type BackupEnvelope,
} from "./crypto/backup-crypto";

/**
 * Cloud backup strategy: snapshot-based, end-to-end encrypted.
 *
 * On sign-in we pull the user's `user_backups.data` JSON blob and hydrate every
 * Dexie table from it. After that, any local Dexie write triggers a debounced
 * push of a fresh full snapshot back to the cloud. Dexie remains the in-session
 * source of truth so the UI stays fast and works offline.
 *
 * E2E encryption (Tier 5): when the current user has a device passphrase set,
 * the snapshot is encrypted client-side (AES-GCM, see `crypto/backup-crypto.ts`)
 * before it leaves the browser, so the server only ever stores ciphertext. If
 * no passphrase is set we fall back to the legacy plaintext behaviour (with a
 * one-time warning) so mid-rollout users aren't broken. Setting a passphrase and
 * pushing once transparently migrates a plaintext cloud copy to ciphertext.
 *
 * Tier 3.1 note: `memories` and `transcript_segments` rows now carry an
 * optional `embedding` array (1536 floats ≈ 6 KB per row). At ~500 memories
 * this adds ~3 MB to the snapshot. Acceptable for now; if a future user
 * hits the JSONB size limit, strip embeddings from the snapshot here and
 * re-derive them on the next mount via `backfillMemoryEmbeddings()`.
 */

const TABLES = [
  "people",
  "places",
  "conversations",
  "transcript_segments",
  "suggestions_log",
  "manual_replies",
  "memories",
  "follow_ups",
  "settings",
  "style_profile",
  "james_profile",
  "james_documents",
  "events",
  "event_documents",
  "voiceprints",
  "person_documents",
  "voiceprint_contributions",
  // === Tier 1: feedback loop ===
  "style_evidence_cache",
  "style_distill_runs",
  // === Tier 2: post-conversation analysis ===
  "profile_proposals",
  "segment_mfccs",
  // === Preference learning ===
  "suggestion_choices",
] as const;

type TableName = (typeof TABLES)[number];
type Snapshot = Partial<Record<TableName, unknown[]>> & { _v?: number };

let currentUserId: string | null = null;
// The last user whose data was pulled/applied into local Dexie. Used to detect
// a user SWITCH so we can wipe the previous user's data before touching the
// cloud on behalf of the new user — otherwise, on a shared device, a new user
// with no cloud backup would push the previous user's transcripts into their
// own backup slot (RLS can't catch it — the write is under the new user's own
// token). Security review HIGH-2.
let lastAppliedUserId: string | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let hooksWired = false;
let suppressPush = false;
let warnedNoEncryption = false;

// ── Sync / encryption status signaling ───────────────────────────────────────
//
// The pull path may find an encrypted cloud copy it can't open (no passphrase
// stored on this device, or the stored passphrase is wrong). In that case we
// MUST NOT wipe local Dexie — instead we surface a signal the UI can react to
// (prompt the user for their passphrase). The UI subscribes via
// `onNeedsPassphrase` / reads `getSyncState()`.

export type SyncStatus =
  | "idle" // nothing pulled yet / local-first
  | "synced" // last pull applied successfully
  | "encrypted-plaintext" // cloud copy is legacy plaintext (E2E not active)
  | "needs-passphrase" // cloud copy is encrypted, no passphrase available here
  | "wrong-passphrase" // cloud copy is encrypted, stored passphrase failed
  | "error"; // pull/push failed for another reason

export interface SyncState {
  status: SyncStatus;
  /** True when the cloud copy is encrypted (regardless of whether we could open it). */
  cloudEncrypted: boolean;
  /** True when this device has a passphrase stored for the current user. */
  hasPassphrase: boolean;
  /** Populated on wrong-passphrase / error. */
  message?: string;
}

let syncState: SyncState = {
  status: "idle",
  cloudEncrypted: false,
  hasPassphrase: false,
};

type NeedsPassphraseCb = (state: SyncState) => void;
const needsPassphraseListeners = new Set<NeedsPassphraseCb>();

function setSyncState(patch: Partial<SyncState>) {
  syncState = { ...syncState, ...patch };
  if (syncState.status === "needs-passphrase" || syncState.status === "wrong-passphrase") {
    for (const cb of needsPassphraseListeners) {
      try {
        cb(syncState);
      } catch (e) {
        console.error("[cloud-sync] needs-passphrase listener threw", e);
      }
    }
  }
}

/** Current sync/encryption status. Safe to read anytime. */
export function getSyncState(): SyncState {
  return syncState;
}

/**
 * Subscribe to "the cloud copy is encrypted but we can't open it here" events
 * (missing or wrong passphrase). Fires immediately if already in that state.
 * Returns an unsubscribe function.
 */
export function onNeedsPassphrase(cb: NeedsPassphraseCb): () => void {
  needsPassphraseListeners.add(cb);
  if (syncState.status === "needs-passphrase" || syncState.status === "wrong-passphrase") {
    try {
      cb(syncState);
    } catch (e) {
      console.error("[cloud-sync] needs-passphrase listener threw", e);
    }
  }
  return () => needsPassphraseListeners.delete(cb);
}

async function takeSnapshot(): Promise<Snapshot> {
  const snap: Snapshot = { _v: 1 };
  for (const t of TABLES) {
    snap[t] = await (db as any)[t].toArray();
  }
  return snap;
}

async function applySnapshot(snap: Snapshot) {
  suppressPush = true;
  try {
    for (const t of TABLES) {
      const rows = snap[t];
      if (!Array.isArray(rows)) continue;
      await (db as any)[t].clear();
      if (rows.length) await (db as any)[t].bulkPut(rows);
    }
  } finally {
    suppressPush = false;
  }
}

/** Rough serialized-byte estimate for the Firestore ~1 MiB document limit. */
function estimatePayloadBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return 0;
  }
}

async function pushNow() {
  // Capture the target user up-front. If the signed-in user changes while this
  // async push is in flight, we must NOT write the snapshot under the wrong
  // user's row. Security review HIGH-2.
  const uid = currentUserId;
  if (!uid) return;
  if (!isFirebaseConfigured()) return;
  try {
    const snap = await takeSnapshot();
    const passphrase = getDevicePassphrase(uid);

    // If a device passphrase is set, encrypt client-side so the server only
    // ever stores ciphertext. Otherwise fall back to legacy plaintext, warning
    // once so we don't break mid-rollout users who haven't opted in yet.
    let payload: unknown;
    if (passphrase) {
      payload = await encryptSnapshot(snap, passphrase);
      setSyncState({ cloudEncrypted: true, hasPassphrase: true, status: "synced" });
    } else {
      if (!warnedNoEncryption) {
        warnedNoEncryption = true;
        console.warn(
          "[cloud-sync] E2E encryption is NOT active — backup is stored as plaintext. " +
            "Set a device passphrase via enableEncryption(userId, passphrase) to encrypt the cloud copy.",
        );
      }
      payload = snap;
      setSyncState({ cloudEncrypted: false, hasPassphrase: false, status: "encrypted-plaintext" });
    }

    // The user switched (sign-out / different account) while we were taking the
    // snapshot or encrypting — abort rather than write it under the wrong row.
    if (uid !== currentUserId) return;

    // Firestore caps a single document at ~1 MiB. A snapshot that large can't
    // be stored as one doc; surface a clear error instead of an opaque
    // Firestore rejection. (Future: spill large backups to Firebase Storage.)
    const approxBytes = estimatePayloadBytes(payload);
    if (approxBytes > 1_000_000) {
      const msg = `Backup is ~${Math.round(approxBytes / 1024)} KB, over Firestore's ~1 MB per-document limit.`;
      console.error("[cloud-sync] push skipped —", msg);
      setSyncState({ status: "error", message: msg });
      return;
    }

    // The owner-only Firestore rule (`request.auth.uid == uid`) enforces that a
    // user can only ever write their own backup document.
    await setDoc(doc(firestore, "user_backups", uid), {
      userId: uid,
      data: payload,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error("[cloud-sync] push exception", e);
    setSyncState({ status: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

function schedulePush() {
  if (suppressPush || !currentUserId) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}

function wireDexieHooks() {
  if (hooksWired) return;
  hooksWired = true;
  for (const t of TABLES) {
    const tbl = (db as any)[t];
    tbl.hook("creating", () => {
      schedulePush();
    });
    tbl.hook("updating", () => {
      schedulePush();
    });
    tbl.hook("deleting", () => {
      schedulePush();
    });
  }
}

/**
 * Pull cloud data for this user into Dexie, replacing local content.
 *
 * Safety invariant: the local Dexie is the source of truth. If the cloud copy
 * is encrypted and we can't decrypt it here (no passphrase / wrong passphrase),
 * we DO NOT touch local data — we surface a `needs-passphrase` / `wrong-passphrase`
 * signal (see `onNeedsPassphrase` / `getSyncState`) and skip applying.
 */
export async function pullForUser(userId: string) {
  // Local-first / anonymous mode: when Firebase isn't configured, do
  // nothing — the user is using the app standalone and the local Dexie
  // is the only source of truth.
  if (!isFirebaseConfigured()) return;

  // User SWITCH on a shared device: wipe the previous user's local data before
  // we do anything on behalf of the new user. Without this, the "first sign-in,
  // no cloud backup → push local as initial backup" branch below would upload
  // the previous user's transcripts into the new user's slot. Security HIGH-2.
  if (lastAppliedUserId && lastAppliedUserId !== userId) {
    await clearTables();
  }
  currentUserId = userId;
  lastAppliedUserId = userId;
  setSyncState({ hasPassphrase: !!getDevicePassphrase(userId) });

  let cloud: unknown;
  try {
    const snap = await getDoc(doc(firestore, "user_backups", userId));
    cloud = snap.exists() ? (snap.data() as { data?: unknown }).data : undefined;
  } catch (e) {
    console.error("[cloud-sync] pull failed", e);
    setSyncState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    // Never wipe local on a fetch failure — just skip applying.
    wireDexieHooks();
    return;
  }

  if (isEncryptedEnvelope(cloud)) {
    // Encrypted cloud copy — need a passphrase to open it.
    const passphrase = getDevicePassphrase(userId);
    if (!passphrase) {
      // No passphrase on this device. Keep local Dexie intact and ask the UI
      // to prompt for the passphrase. Wire hooks so once one is set + a local
      // write happens (or enableEncryption is called) we can push/re-sync.
      setSyncState({
        status: "needs-passphrase",
        cloudEncrypted: true,
        hasPassphrase: false,
      });
      wireDexieHooks();
      return;
    }
    try {
      const snap = await decryptSnapshot<Snapshot>(cloud as BackupEnvelope, passphrase);
      await applySnapshot(snap);
      setSyncState({ status: "synced", cloudEncrypted: true, hasPassphrase: true });
    } catch (e) {
      // Wrong passphrase or tampered data. Do NOT wipe local; surface the error.
      const wrong = e instanceof WrongPassphraseError;
      console.error("[cloud-sync] decrypt failed", e);
      setSyncState({
        status: wrong ? "wrong-passphrase" : "error",
        cloudEncrypted: true,
        hasPassphrase: true,
        message: e instanceof Error ? e.message : String(e),
      });
      wireDexieHooks();
      return;
    }
  } else if (cloud && typeof cloud === "object") {
    // Legacy plaintext cloud copy.
    await applySnapshot(cloud as Snapshot);
    setSyncState({
      status: "encrypted-plaintext",
      cloudEncrypted: false,
      hasPassphrase: !!getDevicePassphrase(userId),
    });
  } else {
    // First sign-in: push whatever's already in local Dexie as the initial backup.
    // (pushNow encrypts if a passphrase is set, else plaintext + warns.)
    await pushNow();
  }
  wireDexieHooks();
}

/** Clear all local Dexie tables. Suppresses the push hooks while wiping. */
async function clearTables() {
  suppressPush = true;
  try {
    for (const t of TABLES) {
      await (db as any)[t].clear();
    }
  } finally {
    suppressPush = false;
  }
}

/** Wipe local Dexie tables (e.g. on sign-out so the next user starts clean). */
export async function clearLocal() {
  currentUserId = null;
  lastAppliedUserId = null;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  setSyncState({ status: "idle", cloudEncrypted: false, hasPassphrase: false, message: undefined });
  await clearTables();
}

/** Force an immediate push (useful before sign-out). */
export async function flushPush() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  await pushNow();
}

/**
 * Turn on E2E encryption for a user on this device.
 *
 * Stores the passphrase for this device+user, then forces an immediate
 * encrypted push. This is also the migration path: if the cloud copy was
 * still legacy plaintext, this push overwrites it with ciphertext.
 *
 * Call this:
 *   • on first opt-in (user chooses/creates a passphrase), OR
 *   • on another device after prompting the user for their existing passphrase
 *     (then call `pullForUser` again to hydrate from the now-openable cloud copy).
 *
 * NOTE: this does not validate the passphrase against an existing encrypted
 * cloud copy — it assumes you're setting the canonical passphrase for this
 * device. To adopt an EXISTING encrypted backup on a new device, prefer the
 * flow: `setDevicePassphrase(userId, pass)` → `pullForUser(userId)` (which will
 * report `wrong-passphrase` if it doesn't match), rather than `enableEncryption`
 * (which would overwrite the cloud copy with a re-encryption of local data).
 */
export async function enableEncryption(userId: string, passphrase: string) {
  setDevicePassphrase(userId, passphrase);
  currentUserId = userId;
  warnedNoEncryption = false; // reset so a later regression re-warns
  setSyncState({ hasPassphrase: true });
  await flushPush();
}
