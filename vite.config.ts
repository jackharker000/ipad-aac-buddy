import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [tsConfigPaths(), tanstackStart(), nitro(), viteReact(), tailwindcss()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web", "@ricky0123/vad-web", "@huggingface/transformers"],
  },
});

// Vercel auto-detects the Nitro output and routes /api/* + SSR through serverless
// functions. Enable Cross-Origin Isolation later (COOP/COEP headers) once we want
// SharedArrayBuffer for multi-threaded ONNX WASM. Single-threaded WASM and WebGPU
// both work without it.
