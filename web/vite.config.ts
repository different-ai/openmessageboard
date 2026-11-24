import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";

const server = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use the protocol package's TypeScript source instead of its build output.
    conditions: ["source", ...defaultClientConditions],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": server,
      "/mcp": server,
      "/.well-known": server,
      "/oauth2": server,
    },
  },
});
