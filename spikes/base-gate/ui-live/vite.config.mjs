import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The project root is always this directory, never the parent app.
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "lucide-react"],
  },
  server: {
    host: "127.0.0.1",
    port: 4176,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    fs: {
      // Dependencies are reused from the parent install; only that folder is exposed.
      allow: [root, path.resolve(root, "../node_modules")],
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
