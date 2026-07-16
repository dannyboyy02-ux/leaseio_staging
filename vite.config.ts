/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  build: {
    sourcemap: mode === 'development',
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // #97: Node ≥22's built-in localStorage throws without --localstorage-file
    // and shadows the storage component tests expect — the shim swaps a broken
    // built-in for an in-memory one (no-op where storage already works).
    setupFiles: ["./src/test/setupStorage.ts"],
  },
}));
