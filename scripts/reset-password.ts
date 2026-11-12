import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { db, audit } from "../server/db";
import { root, now } from "../server/config";
const email = process.argv[2];
if (!email) throw new Error("用法：npm run reset-password -- 登录邮箱");
const user = db
  .prepare("SELECT id,email FROM user WHERE email=?")
  .get(email) as any;
if (!user) throw new Error("没有找到这个账户。");
const password = crypto.randomBytes(24).toString("base64url"),
  hash = await hashPassword(password);
db.transaction(() => {
  const updated = db
    .prepare(
      "UPDATE account SET password=?,updatedAt=? WHERE userId=? AND providerId='credential'",
    )
    .run(hash, Date.now(), user.id);
  if (!updated.changes) throw new Error("这个账户没有密码登录记录。");
  db.prepare("DELETE FROM session WHERE userId=?").run(user.id);
  for (const row of db
    .prepare("SELECT workspace_id FROM memberships WHERE user_id=?")
    .all(user.id) as any[])
    audit(row.workspace_id, "local-admin", "account.password-reset", user.id);
})();
const output = path.join(root, ".local", "PASSWORD-RESET.md");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `# 账户恢复\n\n邮箱：${email}\n\n新密码：${password}\n\n重置时间：${now()}\n\n所有旧登录已失效。请登录后修改密码。\n`,
  { mode: 0o600 },
);
db.close();
console.log(`密码已重置，旧登录已失效。新密码保存在：${output}`);
