#!/usr/bin/env node
/**
 * Copy the Silero VAD AudioWorklet bundle + ONNX model from
 * node_modules/@ricky0123/vad-web/dist into public/ so the library can
 * fetch them at runtime from the site origin.
 *
 * Runs as a postinstall step; safe to re-run.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const src = path.join(repoRoot, "node_modules", "@ricky0123", "vad-web", "dist");
const dst = path.join(repoRoot, "public");

// Files the library actually fetches at runtime. The "*.bundle.min.js" name
// can drift across versions — pick anything matching the prefix.
const wanted = [
  { match: /^vad\.worklet\.bundle\.min\.js$/i, dst: null },
  { match: /^silero_vad.*\.onnx$/i, dst: null },
];

async function main() {
  let entries;
  try {
    entries = await readdir(src);
  } catch (err) {
    console.warn(
      `[copy-vad-assets] @ricky0123/vad-web not installed yet (${err.code ?? err}); skipping.`,
    );
    return;
  }

  await mkdir(dst, { recursive: true });

  let copied = 0;
  for (const entry of entries) {
    for (const w of wanted) {
      if (!w.match.test(entry)) continue;
      const from = path.join(src, entry);
      const to = path.join(dst, w.dst ?? entry);
      const info = await stat(from);
      if (!info.isFile()) continue;
      await copyFile(from, to);
      console.log(`[copy-vad-assets] ${entry} → public/${path.basename(to)}`);
      copied++;
    }
  }

  if (copied === 0) {
    console.warn(
      "[copy-vad-assets] No matching VAD asset filenames found. Inspect node_modules/@ricky0123/vad-web/dist and update scripts/copy-vad-assets.mjs.",
    );
  }
}

main().catch((err) => {
  console.error("[copy-vad-assets] failed:", err);
  process.exitCode = 1;
});
