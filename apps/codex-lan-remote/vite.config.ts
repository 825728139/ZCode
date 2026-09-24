import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:3040",
      "/ws": { target: "ws://127.0.0.1:3040", ws: true },
    },
  },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
});
