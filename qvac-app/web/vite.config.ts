import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /v1 to the OpenAI-compatible endpoint (LM Studio today, QVAC CLI server later)
// so the browser avoids CORS. Override target with VITE_LLM_URL at dev time.
const LLM_URL = process.env.VITE_LLM_URL || "http://localhost:1234";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": { target: LLM_URL, changeOrigin: true },
    },
  },
});
