import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { createAuth } from "../server/auth.mjs";
import { legacyDataRequiresMigration, migrationGuidance, standaloneStoragePaths } from "../server/data-home.mjs";

if (!process.stdin.isTTY) throw new Error("请在本机交互终端运行；不接受命令行密码或管道输入");
try { loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const storage = standaloneStoragePaths();
// Same protection as the service: never initialize a fresh admin into the new
// default location while an unmigrated legacy instance still exists.
if (!process.env.AGENTFORGE_AUTH_DB_PATH && await legacyDataRequiresMigration({ legacyRoot: fileURLToPath(new URL("../.data", import.meta.url)), currentDatabasePath: storage.authDatabasePath }))
  throw new Error(migrationGuidance({ legacyRoot: fileURLToPath(new URL("../.data", import.meta.url)), targetRoot: storage.dataRoot, command: "node scripts/migrate-data-home.mjs --yes" }));
let hidden = false;
const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });
const auth = createAuth({ databasePath: storage.authDatabasePath });
try {
  if (auth.configured() && (await rl.question("重置管理员会撤销全部登录会话。输入 RESET 确认：")) !== "RESET") throw new Error("已取消");
  const username = (await rl.question("用户名 [admin]：")).trim() || "admin";
  process.stdout.write("密码（10–128 字符，不回显）："); hidden = true;
  const password = await rl.question("");
  process.stdout.write("\n再次输入密码：");
  const confirmation = await rl.question(""); hidden = false; process.stdout.write("\n");
  if (password !== confirmation) throw new Error("两次密码不一致，未保存");
  await auth.setAdministrator(username, password);
  console.log("管理员已设置，所有旧会话已撤销。请访问 http://127.0.0.1:4310/login");
} finally { hidden = false; rl.close(); auth.close(); }
