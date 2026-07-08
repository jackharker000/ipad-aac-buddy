/**
 * On-device voice fingerprinting using MFCC features (via Meyda).
 *
 * Captures microphone audio in parallel with ElevenLabs Scribe, slices PCM
 * around each committed transcript segment, computes a mean MFCC vector,
 * and stores per-person centroids in IndexedDB so that familiar voices
 * (Mum, carers, friends) can be auto-recognised across sessions.
 *
 * Free, private, runs entirely in the browser. Best for distinguishing a
 * small set of known speakers in reasonably quiet conditions.
 */
import Meyda from "meyda";
import { db, MFCC_COEFFS, type Voiceprint } from "./db";
export type { Voiceprint };

const FRAME = 512;

/** Only update a cluster's running centroid when the utterance MFCC is at
 *  least this similar to the existing centroid. Keeps outlier utterances from
 *  drifting the centroid away from a confirmed speaker's true voice. */
export const CENTROID_UPDATE_THRESHOLD = 0.76;
const RMS_GATE = 0.012; // skip near-silent frames

/** Margin-based matching: the best candidate must beat the runner-up by at
 *  least this much (discriminativeSim scale) before an unknown cluster is
 *  auto-attributed to a known person, or before a sample is allowed to update
 *  a centroid.
 *
 *  Rationale (Matt vs Jack): two adult male housemates produce MFCC means
 *  whose similarities to BOTH stored voiceprints often land within a few
 *  hundredths of each other (e.g. 0.84 vs 0.82). An absolute threshold alone
 *  happily picks the 0.84 — and is wrong roughly half the time. Requiring a
 *  clear winner (≥ 0.05 ahead) means we only auto-assign when the voice is
 *  unambiguous, and otherwise leave the cluster as Ask/Unknown for the user
 *  to resolve. Same-speaker vs different-speaker sims are separated by
 *  ~0.05–0.15 in this codebase's discriminativeSim scale, so 0.05 rejects
 *  the coin-flips without rejecting genuinely clear matches. */
export const MATCH_MARGIN = 0.05;

/** When a person has NO stored voiceprint yet, a new "auto" contribution for
 *  them is still rejected if it matches some OTHER person's print at or above
 *  this similarity — a sample that strongly resembles an existing person is
 *  exactly how Matt/Jack cross-contamination starts. Matches the ghost-merge
 *  scale used by the cockpit (0.88 = unambiguously the same voice). */
export const FOREIGN_PRINT_REJECT_THRESHOLD = 0.88;

/* ----------------------- Frame-level non-speech gating -------------------- */
/* TV audio, music and broadband noise pass a pure RMS gate easily and then
 * pollute MFCC means, spawning phantom speaker clusters. Meyda computes the
 * FFT once per extract() call, so adding spectralFlatness + zcr alongside
 * mfcc is essentially free (~15 frames per 0.5 s window on iPad Safari). */

/** Frames with spectral flatness above this are noise-like (hiss, static,
 *  applause, dense music) rather than voiced speech. Voiced speech frames sit
 *  around 0.01–0.25; unvoiced fricatives 0.3–0.6; broadband noise 0.5+.
 *  0.45 rejects the clearly non-speech frames while keeping normal speech
 *  (dropping the occasional fricative frame actually sharpens speaker
 *  discrimination — voiced frames carry the speaker identity). */
export const SPECTRAL_FLATNESS_MAX = 0.45;

/** Frames with more zero-crossings than this (per 512-sample frame @16 kHz)
 *  are hiss/static-like. Voiced speech ≈ 10–60 crossings; fricatives can
 *  reach ~150–250; broadband noise/music transients higher still. */
export const ZCR_MAX = 180;

/** Minimum number of gated (voiced, speech-like) frames an utterance must
 *  contain before it yields an MFCC mean at all — i.e. minimum voiced
 *  evidence before a segment can create a cluster OR claim a known-person
 *  label. 6 frames × 512 samples @16 kHz ≈ 190 ms of actual voiced speech.
 *  Short TV blips, coughs and door slams fail this and stay label-less
 *  (the cockpit then attributes the text to the previous speaker instead of
 *  spawning a phantom cluster). Was 4 (~128 ms) before the spectral gate. */
export const MIN_VOICED_FRAMES = 6;

/** Cluster-creation hysteresis: creating a NEW cluster requires a cleaner
 *  audio window than merging into an existing one. When the caller provides
 *  `voicedRatio` (from `computeMfccMeanWithStats`) and it's below this, a
 *  would-be new cluster is instead provisionally attached to the nearest
 *  existing cluster WITHOUT updating its centroid — noisy windows may
 *  continue a speaker, but may not mint a new one.
 *  UI wiring (cockpit owner, index.tsx): compute stats via
 *  `computeMfccMeanWithStats` and pass `{ voicedRatio }` as the second
 *  argument to `Diarizer.assign`. Without it, behaviour is unchanged. */
export const MIN_VOICED_RATIO_FOR_NEW_CLUSTER = 0.5;

/** FIFO cap for stored voiceprint contributions per person. Raised from 3 to
 *  8 so that (a) the trimmed-mean robust centroid (needs ≥4) and (b) the
 *  2-means multi-modal split (needs ≥8, `MIN_CONTRIBUTIONS_TO_SPLIT`) can
 *  actually engage — with the old cap of 3 both were dead code. The
 *  "generic averaged voice" drift the low cap guarded against is now handled
 *  by the margin-gated acceptance in `addContributionWithCap` plus the
 *  trimmed mean in `rebuildVoiceprintFromContributions`. */
export const DEFAULT_CONTRIBUTION_CAP = 8;

// Meyda is configured globally; set defaults once.
(Meyda as any).bufferSize = FRAME;
(Meyda as any).numberOfMFCCCoefficients = MFCC_COEFFS;

export class VoiceCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  /** Mono PCM samples captured since start(). */
  private buffer: Float32Array[] = [];
  private bufferLen = 0;
  startTimeMs = 0;
  sampleRate = 16000;
  private maxSamples = 0;
  private shiftTimer: ReturnType<typeof setInterval> | null = null;
  private shiftPrevMfcc: number[] | null = null;

  /** Periodically computes MFCC on the last ~500ms of audio. When the
   *  cosine similarity to the previous window drops below `threshold`,
   *  fires `onShift(Date.now())` — a likely speaker change point. Used
   *  to split Scribe commits that span multiple speakers without a pause. */
  startShiftMonitor(
    onShift: (timestampMs: number) => void,
    options: { intervalMs?: number; windowSec?: number; threshold?: number } = {},
  ) {
    const intervalMs = options.intervalMs ?? 200;
    const windowSec = options.windowSec ?? 0.5;
    const threshold = options.threshold ?? 0.68;
    this.stopShiftMonitor();
    this.shiftPrevMfcc = null;
    this.shiftTimer = setInterval(() => {
      if (!this.ctx || this.bufferLen < this.sampleRate * windowSec) return;
      try {
        const pcm = this.recentSlice(windowSec, 0);
        const mfcc = computeMfccMean(pcm, this.sampleRate);
        if (!mfcc) return;
        if (this.shiftPrevMfcc) {
          const sim = cosineSim(mfcc, this.shiftPrevMfcc);
          if (sim < threshold) {
            try {
              onShift(Date.now());
            } catch {}
          }
        }
        this.shiftPrevMfcc = mfcc;
      } catch {}
    }, intervalMs);
  }

  stopShiftMonitor() {
    if (this.shiftTimer) {
      clearInterval(this.shiftTimer);
      this.shiftTimer = null;
    }
    this.shiftPrevMfcc = null;
  }

  async start() {
    if (this.ctx) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    this.stream = stream;
    // Try 16 kHz; iOS Safari may ignore and use device default — that's fine.
    const Ctor: typeof AudioContext =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: 16000 } as any);
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.maxSamples = this.sampleRate * 60 * 5; // keep last 5 minutes
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but works on iOS Safari & is reliable.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.startTimeMs = Date.now();
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // copy — input buffer is reused
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.buffer.push(copy);
      this.bufferLen += copy.length;
      // Trim oldest chunks if over cap
      while (this.bufferLen > this.maxSamples && this.buffer.length > 1) {
        const dropped = this.buffer.shift()!;
        this.bufferLen -= dropped.length;
        this.startTimeMs += (dropped.length / this.sampleRate) * 1000;
      }
    };
    this.source.connect(this.processor);
    // Required for ScriptProcessor to fire; route through gain at zero so we don't echo.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(ctx.destination);
    // iOS Safari (and Chrome under autoplay policies) starts the AudioContext
    // in "suspended" state. Without resuming, ScriptProcessor.onaudioprocess
    // never fires, the buffer stays empty, and no voiceprints are ever
    // captured. This is the #1 reason fingerprints don't appear.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (e) {
        console.warn("[voiceprint] AudioContext.resume failed", e);
      }
    }
    console.debug("[voiceprint] capture ready", {
      sampleRate: this.sampleRate,
      ctxState: ctx.state,
    });
  }

  /** True if the capture has accumulated any audio samples. */
  get hasAudio(): boolean {
    return this.bufferLen > 0;
  }

  /** Concatenated mono PCM of everything currently buffered. */
  private concat(): Float32Array {
    const out = new Float32Array(this.bufferLen);
    let offset = 0;
    for (const chunk of this.buffer) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Slice the most recent `durationSec` seconds (with small leading pad). */
  recentSlice(durationSec: number, padSec = 0.25): Float32Array {
    const total = this.concat();
    const want = Math.floor((durationSec + padSec) * this.sampleRate);
    if (total.length <= want) return total;
    return total.subarray(total.length - want);
  }

  /**
   * Tier 3.3 — coarse prosody summary over the last `durationSec` of audio.
   * Returns mean RMS, RMS variance and mean spectral centroid across frames
   * loud enough to be voiced. Returns `null` when there isn't enough audio
   * yet. Used to give the mood predictor a hint about how the conversation
   * partner sounds (energetic, flat, agitated, ...).
   */
  recentProsody(
    durationSec: number,
  ): { meanRms: number; rmsVariance: number; spectralCentroid: number; frames: number } | null {
    if (this.bufferLen < this.sampleRate * 0.5) return null;
    const pcm = this.recentSlice(durationSec, 0);
    if (pcm.length < FRAME * 4) return null;
    (Meyda as any).sampleRate = this.sampleRate;

    const rmsValues: number[] = [];
    const centroidValues: number[] = [];
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
      const slice = pcm.subarray(i, i + FRAME);
      let sumSq = 0;
      for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
      const rms = Math.sqrt(sumSq / slice.length);
      if (rms < RMS_GATE) continue;
      rmsValues.push(rms);
      try {
        const feats = (Meyda as any).extract(["spectralCentroid"], slice) as {
          spectralCentroid?: number;
        } | null;
        if (feats && typeof feats.spectralCentroid === "number") {
          centroidValues.push(feats.spectralCentroid);
        }
      } catch {
        // Meyda can throw on edge buffers — skip and continue.
      }
    }
    if (rmsValues.length < 4) return null;
    const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
    const rmsVariance =
      rmsValues.reduce((sum, v) => sum + (v - meanRms) ** 2, 0) / rmsValues.length;
    const spectralCentroid = centroidValues.length
      ? centroidValues.reduce((a, b) => a + b, 0) / centroidValues.length
      : 0;
    return {
      meanRms,
      rmsVariance,
      spectralCentroid,
      frames: rmsValues.length,
    };
  }

  stop() {
    this.stopShiftMonitor();
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      this.ctx?.close();
    } catch {}
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.stream = null;
    this.buffer = [];
    this.bufferLen = 0;
  }
}

/** Compute mean MFCC vector across a PCM signal. Returns null if too quiet/short. */
export function computeMfccMean(signal: Float32Array, sampleRate: number): number[] | null {
  return computeMfccMeanWithStats(signal, sampleRate)?.mfcc ?? null;
}

export type MfccStats = {
  mfcc: number[];
  /** Frames that passed the RMS + spectral speech gate. */
  voicedFrames: number;
  /** All frames examined in the window. */
  totalFrames: number;
  /** voicedFrames / totalFrames — a cheap "how speech-like was this window"
   *  score for the cluster-creation hysteresis in `Diarizer.assign`. */
  voicedRatio: number;
};

/** Like `computeMfccMean` but also reports voiced-evidence stats.
 *
 *  Frame gating (runs every ~200 ms on-device, so kept cheap):
 *  1. RMS ≥ RMS_GATE               — not near-silent (pre-existing gate).
 *  2. spectralFlatness ≤ SPECTRAL_FLATNESS_MAX and zcr ≤ ZCR_MAX — rejects
 *     music/TV/noise-like frames before they enter the MFCC aggregate.
 *     Meyda shares one FFT across all three features, so this adds no
 *     meaningful cost over extracting mfcc alone.
 *  Requires ≥ MIN_VOICED_FRAMES surviving frames, else returns null. */
export function computeMfccMeanWithStats(
  signal: Float32Array,
  sampleRate: number,
): MfccStats | null {
  if (signal.length < FRAME * 4) return null;
  (Meyda as any).sampleRate = sampleRate;
  const sum = new Array(MFCC_COEFFS).fill(0);
  let frames = 0;
  let totalFrames = 0;
  for (let i = 0; i + FRAME <= signal.length; i += FRAME) {
    const slice = signal.subarray(i, i + FRAME);
    totalFrames++;
    let sumSq = 0;
    for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
    const rms = Math.sqrt(sumSq / slice.length);
    if (rms < RMS_GATE) continue;
    let feats: { mfcc?: number[]; spectralFlatness?: number; zcr?: number } | null = null;
    try {
      feats = (Meyda as any).extract(["mfcc", "spectralFlatness", "zcr"], slice) as {
        mfcc?: number[];
        spectralFlatness?: number;
        zcr?: number;
      } | null;
    } catch {
      return null;
    }
    const mfcc = feats?.mfcc;
    if (!mfcc || mfcc.length !== MFCC_COEFFS) continue;
    // Speech-likeness gate. Only gate on values Meyda actually produced —
    // if a feature comes back non-finite we fall back to the RMS-only gate
    // rather than silently discarding real speech.
    const flatness = feats?.spectralFlatness;
    if (
      typeof flatness === "number" &&
      Number.isFinite(flatness) &&
      flatness > SPECTRAL_FLATNESS_MAX
    ) {
      continue;
    }
    const zcr = feats?.zcr;
    if (typeof zcr === "number" && Number.isFinite(zcr) && zcr > ZCR_MAX) {
      continue;
    }
    for (let k = 0; k < MFCC_COEFFS; k++) sum[k] += mfcc[k];
    frames++;
  }
  if (frames < MIN_VOICED_FRAMES) return null;
  // Sanitize: replace any NaN/Infinity with 0 so downstream cosine similarity
  // never produces NaN from a divide-by-zero on a degenerate frame.
  const mean = sum.map((v) => {
    const val = v / frames;
    return Number.isFinite(val) ? val : 0;
  });
  return {
    mfcc: mean,
    voicedFrames: frames,
    totalFrames,
    voicedRatio: totalFrames > 0 ? frames / totalFrames : 0,
  };
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return NaN;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Speaker-discriminative cosine similarity — excludes MFCC coefficient 0.
 *
 *  Coefficient 0 reflects energy/loudness and is dominated by mic distance,
 *  room gain, and AGC — all shared when two speakers use the same iPad. On a
 *  shared device, including c0 pushes inter-speaker cosine similarity to
 *  0.88–0.96, well above any practical merge threshold and collapsing all
 *  speakers into one cluster. Dropping c0 reduces inter-speaker similarity to
 *  the expected 0.55–0.80 range while keeping intra-speaker similarity at
 *  0.85–0.97, restoring clean speaker separation. */
export function discriminativeSim(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return NaN;
  return cosineSim(a.slice(1), b.slice(1));
}

/** Merge a new MFCC observation into an existing centroid (running mean). */
export function mergeIntoCentroid(
  prev: number[] | undefined,
  prevCount: number,
  next: number[],
  nextWeight = 1,
): { centroid: number[]; count: number } {
  if (!prev || prevCount === 0) {
    return { centroid: next.slice(), count: nextWeight };
  }
  // Dimension mismatch — start fresh rather than producing a garbled centroid.
  if (prev.length !== next.length) {
    return { centroid: next.slice(), count: nextWeight };
  }
  const total = prevCount + nextWeight;
  const out = new Array(prev.length);
  for (let i = 0; i < prev.length; i++) {
    out[i] = (prev[i] * prevCount + next[i] * nextWeight) / total;
  }
  return { centroid: out, count: total };
}

/** Persist (or update) the voiceprint for a person. */
export async function recordVoiceprint(personId: string, vector: number[]) {
  const existing = await db.voiceprints.get(personId);
  const merged = mergeIntoCentroid(existing?.centroid, existing?.sample_count ?? 0, vector);
  const vp: Voiceprint = {
    id: personId,
    person_id: personId,
    centroid: merged.centroid,
    sample_count: merged.count,
    updated_at: Date.now(),
  };
  await db.voiceprints.put(vp);
  return vp;
}

export async function deleteVoiceprint(personId: string) {
  await db.voiceprints.delete(personId);
}

/** Add a voiceprint contribution, capping stored entries at `maxPerPerson`.
 *
 *  FIFO: when the cap is exceeded the oldest entries (by `ts`) are removed
 *  first. This prevents centroid drift from accumulating too many samples that
 *  average out to a generic voice profile and start matching everyone.
 *
 *  Margin-gated acceptance (auto contributions only): a sample that is nearly
 *  as close to some OTHER person's stored voiceprint as to this person's is
 *  exactly how similar voices (Matt vs Jack) cross-contaminate each other's
 *  prints. Such samples are silently dropped — the stored print is left
 *  untouched rather than poisoned. `source: "manual"` samples (deliberate
 *  enrollment in Settings) always bypass the gate. */
export async function addContributionWithCap(
  contribution: import("@/lib/db").VoiceprintContribution,
  maxPerPerson = DEFAULT_CONTRIBUTION_CAP,
): Promise<void> {
  if (contribution.source === "auto") {
    const accepted = await contributionPassesMarginGate(contribution);
    if (!accepted) return;
  }
  const existing = await db.voiceprint_contributions
    .where("person_id")
    .equals(contribution.person_id)
    .sortBy("ts");
  const toDelete =
    existing.length >= maxPerPerson
      ? existing.slice(0, existing.length - maxPerPerson + 1).map((c) => c.id)
      : [];
  if (toDelete.length > 0) {
    await db.voiceprint_contributions.bulkDelete(toDelete);
  }
  await db.voiceprint_contributions.add(contribution);
}

/** Similarity of a vector to a stored voiceprint: max of discriminativeSim
 *  across the main centroid and every sub-centroid (multi-modal voices). */
export function simToVoiceprint(vector: number[], print: Voiceprint): number {
  let sim =
    print.centroid.length === vector.length ? discriminativeSim(vector, print.centroid) : NaN;
  if (!Number.isFinite(sim)) sim = -Infinity;
  if (print.sub_centroids?.length) {
    for (const sub of print.sub_centroids) {
      if (sub.centroid.length !== vector.length) continue;
      const subSim = discriminativeSim(vector, sub.centroid);
      if (Number.isFinite(subSim) && subSim > sim) sim = subSim;
    }
  }
  return sim;
}

/** Margin gate for auto contributions — see `addContributionWithCap`.
 *  Accepts when the sample is clearly closest to its own person:
 *  - own print exists:   simOwn − max(simOther) ≥ MATCH_MARGIN
 *  - no own print yet:   max(simOther) < FOREIGN_PRINT_REJECT_THRESHOLD
 *  A missing/invalid MFCC is rejected outright. */
async function contributionPassesMarginGate(
  contribution: import("@/lib/db").VoiceprintContribution,
): Promise<boolean> {
  const vector = contribution.mfcc;
  if (!Array.isArray(vector) || vector.length !== MFCC_COEFFS) return false;
  let prints: Voiceprint[];
  try {
    prints = await db.voiceprints.toArray();
  } catch {
    // Can't evaluate the gate — fail open so a transient IDB error doesn't
    // stop legitimate learning.
    return true;
  }
  let simOwn = -Infinity;
  let simOther = -Infinity;
  let otherId: string | null = null;
  for (const p of prints) {
    const sim = simToVoiceprint(vector, p);
    if (!Number.isFinite(sim)) continue;
    if (p.person_id === contribution.person_id) {
      simOwn = Math.max(simOwn, sim);
    } else if (sim > simOther) {
      simOther = sim;
      otherId = p.person_id;
    }
  }
  // No other prints stored → nothing to confuse with.
  if (!Number.isFinite(simOther)) return true;
  const passes = Number.isFinite(simOwn)
    ? simOwn - simOther >= MATCH_MARGIN
    : simOther < FOREIGN_PRINT_REJECT_THRESHOLD;
  if (!passes) {
    console.debug("[voiceprint] auto contribution rejected by margin gate", {
      personId: contribution.person_id,
      simOwn: Number.isFinite(simOwn) ? simOwn.toFixed(3) : "no-print",
      simOther: simOther.toFixed(3),
      nearestOther: otherId,
    });
  }
  return passes;
}

/** Find best matching person from a candidate set, or null.
 *
 *  When a Voiceprint has `sub_centroids` (multi-modal voice — e.g. calm vs
 *  animated, in-person vs phone), the effective similarity to that person is
 *  the maximum across its centroid and every sub-centroid.
 *
 *  Margin test (Matt vs Jack): in addition to the absolute `threshold`, the
 *  best person must beat the runner-up person by ≥ MATCH_MARGIN. When two
 *  known voices are nearly equidistant we return null — the cluster stays
 *  Ask/Unknown instead of being coin-flipped to the wrong housemate.
 *  Excluded persons are never RETURNED, but still exert runner-up pressure:
 *  if the user rejected "Matt" for this cluster and the voice is still
 *  Matt-like, suggesting near-tied "Jack" would repeat the same confusion.
 *
 *  `opts.competitors` (optional, backward-compatible): extra prints counted
 *  ONLY as runner-up pressure, never returned. TODO (cockpit owner,
 *  index.tsx recognition pass): pass the ALREADY-CONFIRMED people's prints
 *  here — they're filtered out of `prints` today, so without this the margin
 *  test can't see that an unknown cluster is nearly as close to confirmed
 *  Matt as to candidate Jack. */
export function bestMatch(
  vector: number[],
  prints: Voiceprint[],
  threshold = 0.86,
  excludedPersonIds?: ReadonlySet<string>,
  opts: { margin?: number; competitors?: Voiceprint[] } = {},
): { print: Voiceprint; sim: number } | null {
  const margin = opts.margin ?? MATCH_MARGIN;
  let best: { print: Voiceprint; sim: number } | null = null;
  let runnerUpSim = -Infinity;
  for (const p of prints) {
    // Use discriminativeSim (drops c0) to match the same metric used for
    // in-session clustering — prevents stored voiceprints from over-matching
    // due to shared-mic energy characteristics.
    const sim = simToVoiceprint(vector, p);
    if (!Number.isFinite(sim)) continue;
    if (excludedPersonIds?.has(p.person_id)) {
      // Not a valid winner, but still a plausible owner of the voice.
      if (sim > runnerUpSim) runnerUpSim = sim;
      continue;
    }
    if (!best || sim > best.sim) {
      if (best) runnerUpSim = Math.max(runnerUpSim, best.sim);
      best = { print: p, sim };
    } else if (sim > runnerUpSim) {
      runnerUpSim = sim;
    }
  }
  for (const p of opts.competitors ?? []) {
    if (best && p.person_id === best.print.person_id) continue;
    const sim = simToVoiceprint(vector, p);
    if (Number.isFinite(sim) && sim > runnerUpSim) runnerUpSim = sim;
  }
  if (!best || best.sim < threshold) return null;
  // Margin test — only meaningful when a runner-up exists at all.
  if (Number.isFinite(runnerUpSim) && best.sim - runnerUpSim < margin) {
    console.debug("[voiceprint] bestMatch rejected by margin", {
      winner: best.print.person_id,
      sim: best.sim.toFixed(3),
      runnerUpSim: runnerUpSim.toFixed(3),
      margin,
    });
    return null;
  }
  return best;
}

/* --------------------- Offline (post-conversation) rebuild ---------------- */

export type RebuildOutcome = {
  personId: string;
  newCentroid: number[];
  newSampleCount: number;
  subCentroids: Array<{ label: string; centroid: number[]; count: number }>;
  confidence: number;
  /** True when the new centroid drifted significantly from the existing one;
   *  we ABORT the write to avoid corrupting the print. */
  changedSignificantly: boolean;
  /** True when no rewrite happened (skipped or aborted). */
  aborted: boolean;
};

const MIN_CONTRIBUTIONS_TO_REBUILD = 2;
const MIN_CONTRIBUTIONS_TO_SPLIT = 8;
const SAFETY_GUARD_THRESHOLD = 0.7;
const SUB_CENTROID_SPLIT_GAIN = 0.05;
/** With at least this many contributions, drop the single farthest one before
 *  computing the centroid (trimmed mean). One mislabelled contribution — the
 *  classic Matt-utterance-in-Jack's-log case — is exactly the sample that sits
 *  farthest from the true voice; trimming it keeps the rebuilt centroid on the
 *  right speaker instead of dragging it toward the housemate. */
const TRIM_MIN_CONTRIBUTIONS = 4;

/**
 * Recompute a person's stored voiceprint from the durable contribution log.
 * Optionally splits into a primary/secondary sub-centroid when 2-means
 * detects meaningfully tighter modes than a single mean.
 *
 * Safety guard: if the new mean centroid drifted below cosine sim 0.7 vs
 * the current stored centroid we abort — this typically means we've absorbed
 * mislabelled contributions and overwriting would make things worse.
 */
export async function rebuildVoiceprintFromContributions(
  personId: string,
): Promise<RebuildOutcome> {
  const contributions = await db.voiceprint_contributions
    .where("person_id")
    .equals(personId)
    .toArray();
  const valid = contributions.filter((c) => Array.isArray(c.mfcc) && c.mfcc.length === MFCC_COEFFS);
  const existing = await db.voiceprints.get(personId);

  const aborted = (): RebuildOutcome => ({
    personId,
    newCentroid: existing?.centroid ?? [],
    newSampleCount: existing?.sample_count ?? 0,
    subCentroids: existing?.sub_centroids ?? [],
    confidence: existing?.confidence ?? 0,
    changedSignificantly: false,
    aborted: true,
  });

  if (valid.length < MIN_CONTRIBUTIONS_TO_REBUILD) {
    return aborted();
  }

  // Robust centroid: with enough samples, drop the single farthest
  // contribution from a provisional mean before computing the final mean
  // (trimmed mean — see TRIM_MIN_CONTRIBUTIONS).
  const dim = MFCC_COEFFS;
  let kept = valid;
  if (valid.length >= TRIM_MIN_CONTRIBUTIONS) {
    const provisionalSum = new Array(dim).fill(0);
    for (const c of valid) {
      for (let i = 0; i < dim; i++) provisionalSum[i] += c.mfcc[i];
    }
    const provisionalMean = provisionalSum.map((v) => v / valid.length);
    let worstIdx = -1;
    let worstSim = Infinity;
    for (let i = 0; i < valid.length; i++) {
      const s = cosineSim(valid[i].mfcc, provisionalMean);
      if (Number.isFinite(s) && s < worstSim) {
        worstSim = s;
        worstIdx = i;
      }
    }
    if (worstIdx >= 0) {
      kept = valid.filter((_, i) => i !== worstIdx);
    }
  }

  // Compute new centroid as mean of the kept MFCCs.
  const sum = new Array(dim).fill(0);
  for (const c of kept) {
    for (let i = 0; i < dim; i++) sum[i] += c.mfcc[i];
  }
  const newCentroid = sum.map((v) => v / kept.length);

  // Intra-cluster mean cosine sim → confidence (floor 0.5, ceiling 1.0).
  let totalSim = 0;
  for (const c of kept) totalSim += cosineSim(c.mfcc, newCentroid);
  const rawConfidence = totalSim / kept.length;
  const confidence = Math.max(0.5, Math.min(1, rawConfidence));

  // Safety guard: if new centroid drifts too far from the existing one we
  // refuse to overwrite. Rebuilds should refine, not flip, a known print.
  if (existing && existing.centroid.length === dim) {
    const driftSim = cosineSim(existing.centroid, newCentroid);
    if (driftSim < SAFETY_GUARD_THRESHOLD) {
      console.warn(
        `[voiceprint] rebuild aborted for ${personId}: new centroid drifted to cosine ${driftSim.toFixed(
          3,
        )} (< ${SAFETY_GUARD_THRESHOLD}).`,
      );
      return {
        ...aborted(),
        newCentroid,
        confidence,
        changedSignificantly: true,
      };
    }
  }

  // 2-means split (cosine k-means, k=2, 5 iterations) — only when we have
  // enough contributions to draw a meaningful conclusion.
  const subCentroids: Array<{
    label: string;
    centroid: number[];
    count: number;
  }> = [];
  if (kept.length >= MIN_CONTRIBUTIONS_TO_SPLIT) {
    // Farthest-pair init: take the first sample and the one most distant from it.
    const a = kept[0].mfcc.slice();
    let bIdx = 0;
    let worstSim = 1;
    for (let i = 1; i < kept.length; i++) {
      const s = cosineSim(a, kept[i].mfcc);
      if (s < worstSim) {
        worstSim = s;
        bIdx = i;
      }
    }
    let c0 = a;
    let c1 = kept[bIdx].mfcc.slice();
    const assign = new Array<number>(kept.length).fill(0);
    for (let iter = 0; iter < 5; iter++) {
      for (let i = 0; i < kept.length; i++) {
        const s0 = cosineSim(kept[i].mfcc, c0);
        const s1 = cosineSim(kept[i].mfcc, c1);
        assign[i] = s0 >= s1 ? 0 : 1;
      }
      const sum0 = new Array(dim).fill(0);
      const sum1 = new Array(dim).fill(0);
      let n0 = 0;
      let n1 = 0;
      for (let i = 0; i < kept.length; i++) {
        if (assign[i] === 0) {
          for (let j = 0; j < dim; j++) sum0[j] += kept[i].mfcc[j];
          n0++;
        } else {
          for (let j = 0; j < dim; j++) sum1[j] += kept[i].mfcc[j];
          n1++;
        }
      }
      if (n0 > 0) c0 = sum0.map((v) => v / n0);
      if (n1 > 0) c1 = sum1.map((v) => v / n1);
    }
    let n0 = 0,
      n1 = 0;
    let intra0 = 0,
      intra1 = 0;
    for (let i = 0; i < kept.length; i++) {
      if (assign[i] === 0) {
        intra0 += cosineSim(kept[i].mfcc, c0);
        n0++;
      } else {
        intra1 += cosineSim(kept[i].mfcc, c1);
        n1++;
      }
    }
    const mean0 = n0 > 0 ? intra0 / n0 : 0;
    const mean1 = n1 > 0 ? intra1 / n1 : 0;
    const overall = rawConfidence;
    const primaryIsZero = n0 >= n1;
    const primaryMean = primaryIsZero ? mean0 : mean1;
    const primaryCentroid = primaryIsZero ? c0 : c1;
    const primaryCount = primaryIsZero ? n0 : n1;
    const secondaryMean = primaryIsZero ? mean1 : mean0;
    const secondaryCentroid = primaryIsZero ? c1 : c0;
    const secondaryCount = primaryIsZero ? n1 : n0;
    if (
      primaryMean - overall >= SUB_CENTROID_SPLIT_GAIN &&
      secondaryCount > 0 &&
      secondaryMean > 0
    ) {
      subCentroids.push({
        label: "primary",
        centroid: primaryCentroid,
        count: primaryCount,
      });
      subCentroids.push({
        label: "secondary",
        centroid: secondaryCentroid,
        count: secondaryCount,
      });
    } else {
      subCentroids.push({
        label: "primary",
        centroid: newCentroid,
        count: valid.length,
      });
    }
  } else {
    subCentroids.push({
      label: "primary",
      centroid: newCentroid,
      count: valid.length,
    });
  }

  const updated: Voiceprint = {
    id: personId,
    person_id: personId,
    centroid: newCentroid,
    sample_count: valid.length,
    updated_at: Date.now(),
    sub_centroids: subCentroids,
    confidence,
    last_rebuilt_at: Date.now(),
  };
  await db.voiceprints.put(updated);

  // Propagate the cohesion score to the Person record so it's queryable.
  try {
    const person = await db.people.get(personId);
    if (person) {
      await db.people.update(personId, { voiceprint_confidence: confidence });
    }
  } catch {
    // Person row may have been deleted concurrently; centroid update still useful.
  }

  return {
    personId,
    newCentroid,
    newSampleCount: valid.length,
    subCentroids,
    confidence,
    changedSignificantly: false,
    aborted: false,
  };
}

/**
 * Tiny on-device diarizer.
 *
 * Owns the live MFCC clusters for the current session. For each new utterance
 * the caller computes a mean MFCC vector and asks `assign(mfcc)`; the diarizer
 * either merges it into the nearest existing cluster (cosine sim ≥
 * `mergeThreshold`) or opens a fresh "Speaker N" cluster. There is exactly one
 * source of truth for "who's talking now" — no Scribe-vs-MFCC tie-breaking.
 */
export type Cluster = { label: string; centroid: number[]; count: number };

type ClusterEntry = { centroid: number[]; count: number; spread: number };

export class Diarizer {
  private clustersMap = new Map<string, ClusterEntry>();
  private counter = 0;
  private _forceNewOnNext = false;
  // Similarity is computed with discriminativeSim (MFCC[1..], no energy coeff).
  // With c0 removed, same-speaker sim is ~0.85–0.97, different-speaker is ~0.55–0.80.
  // 0.82 sits cleanly between those ranges — merges the same speaker across
  // mic distances/emotions while reliably splitting different speakers.
  constructor(public mergeThreshold = 0.82) {}

  reset() {
    this.clustersMap.clear();
    this.counter = 0;
  }

  /** Assign an MFCC mean to a cluster (existing or new). Returns the label. */
  assign(mfcc: number[]): { label: string; sim: number; isNew: boolean } {
    if (this._forceNewOnNext) {
      this._forceNewOnNext = false;
      return this.assignNew(mfcc);
    }
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = discriminativeSim(mfcc, cluster.centroid);
      if (!Number.isFinite(sim)) continue;
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = label;
      }
    }
    let label: string;
    let isNew = false;
    if (bestLabel) {
      const threshold = this.thresholdFor(bestLabel);
      if (bestSim >= threshold) {
        label = bestLabel;
      } else {
        this.counter += 1;
        label = `Speaker ${this.counter}`;
        isNew = true;
      }
    } else {
      this.counter += 1;
      label = `Speaker ${this.counter}`;
      isNew = true;
    }
    if (isNew) {
      this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
    } else {
      const cluster = this.clustersMap.get(label);
      if (cluster) {
        const preMergeSim = discriminativeSim(mfcc, cluster.centroid);
        if (Number.isFinite(preMergeSim) && preMergeSim >= CENTROID_UPDATE_THRESHOLD) {
          this.mergeUtterance(label, mfcc);
        }
      }
    }
    return { label, sim: bestSim, isNew };
  }

  /** Preview which cluster an MFCC would be assigned to, without mutating state. */
  peek(mfcc: number[]): { label: string | null; sim: number; wouldMerge: boolean } {
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = discriminativeSim(mfcc, cluster.centroid);
      if (!Number.isFinite(sim)) continue;
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = label;
      }
    }
    if (!bestLabel) return { label: null, sim: -1, wouldMerge: false };
    const threshold = this.thresholdFor(bestLabel);
    return { label: bestLabel, sim: bestSim, wouldMerge: bestSim >= threshold };
  }

  /** Force-create a new cluster seeded by this MFCC. Use when textual evidence
   *  (e.g. self-introduction) strongly suggests a different speaker even if
   *  the MFCC superficially resembles an existing cluster. */
  assignNew(mfcc: number[]): { label: string; sim: number; isNew: true } {
    this.counter += 1;
    const label = `Speaker ${this.counter}`;
    this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
    return { label, sim: 1, isNew: true };
  }

  /** Compute the adaptive merge threshold for a given cluster.
   *  - With <3 samples we use the conservative baseline (0.87 by default) —
   *    spread isn't meaningful yet, so don't relax.
   *  - With ≥3 samples we relax for tight clusters and tighten for broad ones,
   *    but always stay within [0.83, 0.93]. */
  private thresholdFor(label: string): number {
    const c = this.clustersMap.get(label);
    if (!c || c.count < 3) return this.mergeThreshold;
    const adjusted = this.mergeThreshold + (c.spread - 0.08) * 0.6;
    return Math.min(0.9, Math.max(0.78, adjusted));
  }

  /** Force-assign an MFCC to a specific cluster label. If the cluster doesn't
   *  exist, create it seeded with this MFCC. Otherwise update its centroid
   *  with the new sample (subject to the centroid update guard).
   *
   *  Use this when external evidence (e.g. a participant's stored voiceprint)
   *  determines the cluster identity more reliably than in-session MFCC
   *  similarity. Returns the resolved label and the cluster's prior similarity
   *  for caller bookkeeping. */
  forceAssign(label: string, mfcc: number[]): { label: string; sim: number; isNew: boolean } {
    const existing = this.clustersMap.get(label);
    if (!existing) {
      this.clustersMap.set(label, { centroid: mfcc.slice(), count: 1, spread: 0 });
      return { label, sim: 1, isNew: true };
    }
    const preMergeSim = discriminativeSim(mfcc, existing.centroid);
    if (Number.isFinite(preMergeSim) && preMergeSim >= CENTROID_UPDATE_THRESHOLD) {
      this.mergeUtterance(label, mfcc);
    }
    return { label, sim: preMergeSim, isNew: false };
  }

  private mergeUtterance(label: string, mfcc: number[]) {
    const prev = this.clustersMap.get(label);
    const merged = mergeIntoCentroid(prev?.centroid, prev?.count ?? 0, mfcc);
    const simToCentroid = prev ? discriminativeSim(mfcc, prev.centroid) : 1.0;
    const prevCount = prev?.count ?? 0;
    const rawSpread =
      prevCount > 0
        ? (prev!.spread * prevCount + (1 - (Number.isFinite(simToCentroid) ? simToCentroid : 0))) /
          (prevCount + 1)
        : 0;
    // Clamp spread to [0, 0.15] to prevent threshold blow-out when a single
    // noisy utterance produces an anomalously low similarity to the centroid.
    // Without the clamp, spread can reach 0.4+ which pushes thresholdFor() to
    // its 0.93 max, making subsequent utterances from the same speaker always
    // create new clusters.
    const newSpread = Math.min(0.15, Math.max(0, rawSpread));
    this.clustersMap.set(label, {
      centroid: merged.centroid,
      count: merged.count,
      spread: newSpread,
    });
  }

  /** Mark that the next `assign()` call should create a new cluster
   *  regardless of cosine similarity (e.g. James signals a new speaker
   *  is about to talk). */
  forceNextNew() {
    this._forceNewOnNext = true;
  }

  /** Merge cluster `fromLabel` into `toLabel` (weighted centroid blend).
   *  Returns false if either label doesn't exist. After merging, all
   *  utterances previously labelled `fromLabel` should be relabelled
   *  `toLabel` by the caller. */
  mergeClusters(fromLabel: string, toLabel: string): boolean {
    const from = this.clustersMap.get(fromLabel);
    const to = this.clustersMap.get(toLabel);
    if (!from || !to) return false;
    const totalCount = from.count + to.count;
    // Dimension mismatch: keep the 'to' centroid unchanged rather than
    // producing a garbled vector.
    const merged =
      from.centroid.length === to.centroid.length
        ? to.centroid.map((v, i) => (v * to.count + from.centroid[i] * from.count) / totalCount)
        : to.centroid.slice();
    const newSpread = (to.spread * to.count + from.spread * from.count) / totalCount;
    this.clustersMap.set(toLabel, {
      centroid: merged,
      count: totalCount,
      spread: newSpread,
    });
    this.clustersMap.delete(fromLabel);
    return true;
  }

  /** Snapshot of all live clusters. */
  clusters(): Cluster[] {
    return [...this.clustersMap.entries()].map(([label, c]) => ({
      label,
      centroid: c.centroid,
      count: c.count,
    }));
  }

  get(label: string): Cluster | undefined {
    const c = this.clustersMap.get(label);
    return c ? { label, centroid: c.centroid, count: c.count } : undefined;
  }
}
