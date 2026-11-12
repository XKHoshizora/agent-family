import { restoreData } from "./backup-lib";
const [archive, target] = process.argv.slice(2);
if (!archive || !target)
  throw new Error("用法：npm run restore -- 备份.zip 新的空数据目录");
const result = restoreData(archive, target);
console.log(
  `恢复与完整性校验完成：${result.path}\n请将 DATA_DIR 指向此目录后启动。备份时间：${result.createdAt}`,
);
