import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

// In development the browser talks to Vite (same origin as APP_ORIGIN); `/api`, including
// the WebSocket, is forwarded unchanged to the service. `changeOrigin: false` keeps the
// Host and Origin headers as the browser sent them (http://127.0.0.1:5273).
export default defineConfig({
  root,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The maths fonts (KaTeX's, in the Markdown chunk) are files served from the same origin, never inlined as data:
    // URLs: the page's Content-Security-Policy allows fonts from 'self' only.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    // The largest chunk is the Markdown renderer (~530 kB, most of it KaTeX): already split off, loaded only with the
    // first Agent message. The warning stays for anything larger.
    chunkSizeWarningLimit: 600,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "lucide-react"],
  },
  server: {
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        ws: true,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,jsx}"],
    setupFiles: ["tests/setup.js"],
  },
  plugins: [react()],
});
