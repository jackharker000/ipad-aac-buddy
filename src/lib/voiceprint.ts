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
const RMS_GATE = 0.012; // skip near-silent frames

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

  stop() {
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
export function computeMfccMean(
  signal: Float32Array,
  sampleRate: number,
): number[] | null {
  if (signal.length < FRAME * 4) return null;
  (Meyda as any).sampleRate = sampleRate;
  const sum = new Array(MFCC_COEFFS).fill(0);
  let frames = 0;
  for (let i = 0; i + FRAME <= signal.length; i += FRAME) {
    const slice = signal.subarray(i, i + FRAME);
    let sumSq = 0;
    for (let j = 0; j < slice.length; j++) sumSq += slice[j] * slice[j];
    const rms = Math.sqrt(sumSq / slice.length);
    if (rms < RMS_GATE) continue;
    let mfcc: number[] | null = null;
    try {
      mfcc = (Meyda as any).extract("mfcc", slice) as number[] | null;
    } catch {
      return null;
    }
    if (!mfcc || mfcc.length !== MFCC_COEFFS) continue;
    for (let k = 0; k < MFCC_COEFFS; k++) sum[k] += mfcc[k];
    frames++;
  }
  if (frames < 4) return null;
  return sum.map((v) => v / frames);
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
  const merged = mergeIntoCentroid(
    existing?.centroid,
    existing?.sample_count ?? 0,
    vector,
  );
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

/** Find best matching person from a candidate set, or null.
 *
 *  When a Voiceprint has `sub_centroids` (multi-modal voice — e.g. calm vs
 *  animated, in-person vs phone), the effective similarity to that person is
 *  the maximum across its centroid and every sub-centroid. */
export function bestMatch(
  vector: number[],
  prints: Voiceprint[],
  threshold = 0.86,
): { print: Voiceprint; sim: number } | null {
  let best: { print: Voiceprint; sim: number } | null = null;
  for (const p of prints) {
    if (p.centroid.length !== vector.length) continue;
    let sim = cosineSim(vector, p.centroid);
    if (p.sub_centroids?.length) {
      for (const sub of p.sub_centroids) {
        if (sub.centroid.length !== vector.length) continue;
        const subSim = cosineSim(vector, sub.centroid);
        if (subSim > sim) sim = subSim;
      }
    }
    if (!best || sim > best.sim) best = { print: p, sim };
  }
  if (best && best.sim >= threshold) return best;
  return null;
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

const MIN_CONTRIBUTIONS_TO_REBUILD = 5;
const MIN_CONTRIBUTIONS_TO_SPLIT = 8;
const SAFETY_GUARD_THRESHOLD = 0.7;
const SUB_CENTROID_SPLIT_GAIN = 0.05;

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

  // Compute new centroid as mean of all MFCCs.
  const dim = MFCC_COEFFS;
  const sum = new Array(dim).fill(0);
  for (const c of valid) {
    for (let i = 0; i < dim; i++) sum[i] += c.mfcc[i];
  }
  const newCentroid = sum.map((v) => v / valid.length);

  // Intra-cluster mean cosine sim → confidence (floor 0.5, ceiling 1.0).
  let totalSim = 0;
  for (const c of valid) totalSim += cosineSim(c.mfcc, newCentroid);
  const rawConfidence = totalSim / valid.length;
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
  if (valid.length >= MIN_CONTRIBUTIONS_TO_SPLIT) {
    // Farthest-pair init: take the first sample and the one most distant from it.
    const a = valid[0].mfcc.slice();
    let bIdx = 0;
    let worstSim = 1;
    for (let i = 1; i < valid.length; i++) {
      const s = cosineSim(a, valid[i].mfcc);
      if (s < worstSim) {
        worstSim = s;
        bIdx = i;
      }
    }
    let c0 = a;
    let c1 = valid[bIdx].mfcc.slice();
    const assign = new Array<number>(valid.length).fill(0);
    for (let iter = 0; iter < 5; iter++) {
      for (let i = 0; i < valid.length; i++) {
        const s0 = cosineSim(valid[i].mfcc, c0);
        const s1 = cosineSim(valid[i].mfcc, c1);
        assign[i] = s0 >= s1 ? 0 : 1;
      }
      const sum0 = new Array(dim).fill(0);
      const sum1 = new Array(dim).fill(0);
      let n0 = 0;
      let n1 = 0;
      for (let i = 0; i < valid.length; i++) {
        if (assign[i] === 0) {
          for (let j = 0; j < dim; j++) sum0[j] += valid[i].mfcc[j];
          n0++;
        } else {
          for (let j = 0; j < dim; j++) sum1[j] += valid[i].mfcc[j];
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
    for (let i = 0; i < valid.length; i++) {
      if (assign[i] === 0) {
        intra0 += cosineSim(valid[i].mfcc, c0);
        n0++;
      } else {
        intra1 += cosineSim(valid[i].mfcc, c1);
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

export class Diarizer {
  private clustersMap = new Map<string, { centroid: number[]; count: number }>();
  private counter = 0;
  constructor(public mergeThreshold = 0.82) {}

  reset() {
    this.clustersMap.clear();
    this.counter = 0;
  }

  /** Assign an MFCC mean to a cluster (existing or new). Returns the label. */
  assign(mfcc: number[]): { label: string; sim: number; isNew: boolean } {
    let bestLabel: string | null = null;
    let bestSim = -1;
    for (const [label, cluster] of this.clustersMap.entries()) {
      const sim = cosineSim(mfcc, cluster.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = label;
      }
    }
    let label: string;
    let isNew = false;
    if (bestLabel && bestSim >= this.mergeThreshold) {
      label = bestLabel;
    } else {
      this.counter += 1;
      label = `Speaker ${this.counter}`;
      isNew = true;
    }
    const prev = this.clustersMap.get(label);
    const merged = mergeIntoCentroid(prev?.centroid, prev?.count ?? 0, mfcc);
    this.clustersMap.set(label, merged);
    return { label, sim: bestSim, isNew };
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
