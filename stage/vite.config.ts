import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Where the stage finds GAIA Core in dev: local `npm run dev` in ../core by
// default, or the demo host (GAIA_CORE_URL=https://your-gaia-core.example.com).
// In production vercel.json rewrites /api/gaia/v2/* to Core instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", "");
  const core = (env.GAIA_CORE_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");

  return {
    plugins: [react()],
    // three.js is one lazy chunk (the core); it is loaded after first paint.
    build: { chunkSizeWarningLimit: 800 },
    server: {
      port: 3110,
      proxy: { "/api/gaia/v2": { target: core, changeOrigin: false } },
    },
  };
});
