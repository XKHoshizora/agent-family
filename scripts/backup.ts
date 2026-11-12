import path from "node:path";
import { config, dataDir } from "../server/config";
import { backupData } from "./backup-lib";
const output =
  process.argv[2] ||
  path.join(
    dataDir,
    "backups",
    `agent-family-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
  );
const result = await backupData(dataDir, output, {
  auth: config.authSecret,
  encryption: config.encryptionKey,
  setup: config.setupToken,
});
console.log(`备份完成：${result.path}\n包含数据库与恢复密钥，请妥善保管。`);
