import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { auth, migrateAuth } from "../server/auth";
import { db, createRoom } from "../server/db";
import { config, id, now, root } from "../server/config";
import { DEFAULT_AGENTS } from "../shared/types";
import { listProviders } from "../server/providers";
await migrateAuth();
if (db.prepare("SELECT 1 FROM memberships LIMIT 1").get())
  throw new Error("已有账户，不会重新初始化。请使用网页登录。");
const email = process.argv[2] || "owner@agent.family",
  password = crypto.randomBytes(24).toString("base64url");
const account = await auth.api.signUpEmail({
  body: { name: "空间管理员", email, password },
});
const workspaceId = id();
db.transaction(() => {
  db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
    workspaceId,
    "我的 Agent Family",
    now(),
  );
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
    workspaceId,
    account.user.id,
    "owner",
  );
})();
listProviders(workspaceId);
createRoom(workspaceId, account.user.id, "灵感客厅", DEFAULT_AGENTS);
fs.mkdirSync(path.join(root, ".local"), { recursive: true });
const output = path.join(root, ".local", "ACCESS.md");
fs.writeFileSync(
  output,
  `# Agent Family 登录信息\n\n地址：${config.origin}\n\n登录邮箱：${email}\n\n初始密码：${password}\n\n请首次登录后在设置中修改密码。此文件包含凭据，不要上传或转发。\n`,
  { mode: 0o600 },
);
db.close();
console.log(`管理员账户已创建。登录信息保存在：${output}`);
