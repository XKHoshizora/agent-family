import fs from "node:fs";
import path from "node:path";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const notices = [
  "Agent Family — Third-party licenses",
  "Generated from the locked dependency tree (including optional build dependencies). Original upstream copyright notices follow.",
  "",
  fs.readFileSync("scripts/licenses/Apache-2.0.txt", "utf8"),
];
const missing = [];
const inventory = [];
for (const [folder, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  if (!folder || entry.dev || !folder.startsWith("node_modules/")) continue;
  const metaPath = path.join(folder, "package.json");
  if (!fs.existsSync(metaPath)) continue;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const name = meta.name || folder.replace(/^node_modules\//, "");
  const files = fs
    .readdirSync(folder)
    .filter(
      (f) =>
        /^(licen[cs]e|copying|notice)(?:[.-]|$)/i.test(f) &&
        fs.statSync(path.join(folder, f)).isFile(),
    );
  inventory.push({
    name,
    version: meta.version,
    license:
      typeof meta.license === "string"
        ? meta.license
        : entry.license || "See upstream",
    direct: !!pkg.dependencies[name],
    repository:
      typeof meta.repository === "string"
        ? meta.repository
        : meta.repository?.url,
  });
  notices.push(
    "=".repeat(78),
    `${name} ${meta.version}`,
    `License: ${typeof meta.license === "string" ? meta.license : entry.license || "See package metadata"}`,
  );
  if (!files.length) {
    const fallback =
      name === "@ai-sdk/provider-utils"
        ? "node_modules/ai/LICENSE"
        : name.startsWith("@esbuild/")
          ? "node_modules/esbuild/LICENSE.md"
          : name.startsWith("@rolldown/binding-")
            ? "node_modules/rolldown/LICENSE"
            : ["abstract-logging", "react-remove-scroll-bar"].includes(name)
              ? `scripts/licenses/${name}.txt`
              : null;
    if (fallback && fs.existsSync(fallback))
      notices.push(fs.readFileSync(fallback, "utf8"));
    else {
      missing.push(name);
      notices.push(
        `Upstream: ${meta.homepage || inventory.at(-1).repository || "https://www.npmjs.com/package/" + name}`,
      );
    }
  } else
    for (const file of files)
      notices.push(
        `--- ${file} ---`,
        fs.readFileSync(path.join(folder, file), "utf8"),
      );
  notices.push("");
}
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync(
  "public/THIRD-PARTY-LICENSES.txt",
  notices
    .join("\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd() + "\n",
);
const direct = inventory.filter((p) => p.direct);
fs.writeFileSync(
  "THIRD-PARTY-NOTICES.md",
  `# 开源复用与许可\n\nAgent Family 自有代码采用 MIT。没有复制 Cebus/LibreChat 等完整应用代码；开源调研后复用成熟 SDK 和组件，以满足独立群成员、LINE 绑定和项目审查的产品流程。\n\n完整依赖许可文本在 [THIRD-PARTY-LICENSES.txt](public/THIRD-PARTY-LICENSES.txt)，构建后同路径公开提供。以下版本来自 package-lock.json；依赖升级后运行 npm run notices 更新。此清单不授予模型服务、LINE 商标或第三方账号的权利。\n\n| 直接依赖 | 版本 | 许可 |\n| --- | --- | --- |\n${direct.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n")}\n\n构建时安装的生产与可选依赖共 ${inventory.length} 个包；完整锁定列表见 package-lock.json。开发测试复用 TypeScript、Vite、Vitest、Playwright、Prettier、tsup 等工具，它们不作为客户端产品功能重新实现。\n`,
);
console.log(
  JSON.stringify({
    productionPackages: inventory.length,
    direct: direct.length,
    licenseFilesMissing: missing,
  }),
);
