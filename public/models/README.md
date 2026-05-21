# Speaker-ID models

Parley's speaker-ID engine runs entirely on-device. Two pieces live here.

## 1. Silero VAD assets — auto-copied

`@ricky0123/vad-web` ships its own AudioWorklet + Silero ONNX. The
`postinstall` script (`scripts/copy-vad-assets.mjs`) copies them from
`node_modules/@ricky0123/vad-web/dist` into `public/` so the library can
fetch them at runtime from the site origin:

- `public/vad.worklet.bundle.min.js`
- `public/silero_vad_v5.onnx`
- `public/silero_vad_legacy.onnx`

Re-run manually with `bun run copy-vad-assets` if the source changes.

## 2. `ecapa-tdnn.onnx` (or compatible speaker embedder)

Loaded by `OnnxEcapaEmbedder` in `src/lib/audio/embedder.ts`.

Expected ONNX signature:

- **Input:** `float32[1, num_samples]` — mono waveform at 16 kHz
- **Output:** `float32[1, D]` — speaker embedding (D = 192 for stock ECAPA;
  the matcher works with whatever dimension comes back)

The default path is `/models/ecapa-tdnn.onnx`.

### Where to get one

A good starting point is the SpeechBrain `spkrec-ecapa-voxceleb` ECAPA-TDNN
exported to ONNX with feature extraction baked in (so the runtime input is
raw 16 kHz audio). WeSpeaker / Pyannote ONNX exports are equivalent.

Until the file is in place, the spike route falls back to a deterministic
mock embedder so the rest of the pipeline (VAD → match → UI) is still
debuggable. The mock is **not** suitable for shipping — flip the embedder
switch to ONNX once the real model is here.
