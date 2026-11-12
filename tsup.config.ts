import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "server/index.ts",
    setup: "scripts/setup.ts",
    backup: "scripts/backup.ts",
    restore: "scripts/restore.ts",
    "reset-password": "scripts/reset-password.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist-server",
  clean: true,
  external: ["better-sqlite3"],
});
