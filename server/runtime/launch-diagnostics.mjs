import { access, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

async function inspect(path, directory = false) {
  const result = { path };
  try {
    const info = await stat(path);
    result.exists = true; result.kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    result.realPath = await realpath(path);
    try { await access(path, constants.X_OK); result.executable = true; }
    catch (error) { result.executable = false; result.accessError = error.code; }
    result.usable = directory ? info.isDirectory() && result.executable : info.isFile() && result.executable;
  } catch (error) { result.exists = error.code === "ENOENT" ? false : null; result.errorCode = error.code; }
  return result;
}

function searchPaths(command, cwd, searchPath) {
  if (isAbsolute(command) || command.includes("/")) return [resolve(cwd, command)];
  return [...new Set(searchPath.split(delimiter).map(path => resolve(cwd, path, command)))];
}

async function interpreterCheck(executable, cwd, searchPath) {
  let file;
  try {
    file = await open(executable, "r");
    const bytes = Buffer.alloc(512), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const firstLine = bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    if (!firstLine.startsWith("#!")) return null;
    const parts = firstLine.slice(2).trim().split(/\s+/), launcher = parts[0];
    const check = await inspect(resolve(cwd, launcher));
    if (launcher !== "/usr/bin/env") return { launcher: check, usable: check.usable === true };
    const name = parts[1] === "-S" ? parts[2] : parts[1];
    // Do not log interpreter arguments, assignments or arbitrary script text.
    if (!name || !/^[A-Za-z0-9_.+-]+$/.test(name)) return { launcher: check, usable: check.usable === true, lookup: "not inspected: unsupported env shebang" };
    const candidates = await Promise.all(searchPaths(name, cwd, searchPath).map(path => inspect(path)));
    return { launcher: check, command: name, candidates, usable: check.usable === true && candidates.some(item => item.usable) };
  } catch (error) { return { errorCode: error.code, usable: null }; }
  finally { await file?.close(); }
}

// Read-only launch evidence, not executable discovery or a PATH modification.
export async function diagnoseLaunch({ command, cwd, searchPath = "/usr/bin:/bin", provider }) {
  const workingDirectory = await inspect(cwd, true);
  const candidates = await Promise.all(searchPaths(command, cwd, searchPath).map(path => inspect(path)));
  const selected = candidates.find(item => item.usable);
  const interpreter = selected ? await interpreterCheck(selected.path, cwd, searchPath) : null;
  const commonLocations = command.includes("/") ? [] : await Promise.all([
    join(homedir(), ".local", "bin", command), join(homedir(), ".npm-global", "bin", command),
    join("/opt/homebrew/bin", command), join("/usr/local/bin", command)
  ].filter(path => !candidates.some(item => item.path === path)).map(path => inspect(path)));
  const problems = [], nextSteps = [];
  if (!workingDirectory.usable) {
    problems.push("工作目录不存在、不是目录或没有进入权限；spawn ENOENT 不一定是 CLI 缺失。");
    nextSteps.push("检查本条 workingDirectory 的路径和 errorCode；在设置中修正新任务默认目录。已有任务目录不会自动迁移。");
  }
  if (!selected) {
    problems.push(candidates.some(item => item.exists) ? "CLI 候选存在但不是可执行文件，或当前用户无执行权限。" : "在本次服务实际使用的路径中未找到 CLI；尚不能断言此电脑未安装 CLI。");
    nextSteps.push(`在这台 Mac 的终端运行 command -v ${provider === "Codex" ? "codex" : "claude"}，将结果的绝对路径填入「设置 → Runtime → CLI 路径」，保存后测试连接。不要填写目录、别名或带参数的整条命令。`);
    if (commonLocations.some(item => item.usable)) nextSteps.push("commonLocations 中发现未包含在服务 PATH 的可执行文件。Finder 启动的 App 不会自动加载终端的 shell 配置；可显式配置该绝对路径。");
  }
  if (interpreter?.usable === false) {
    problems.push("CLI 脚本存在，但其 shebang 解释器不可用；常见情况是 /usr/bin/env node 无法在 App 的 PATH 中找到 Node。");
    nextSteps.push("检查 interpreter 的 launcher/candidates；在当前用户环境修复 CLI 安装及解释器可用性，再测试连接。AgentForge 内置控制面 Node 不等于外部 CLI 的 Node。");
  }
  if (!problems.length) nextSteps.push("CLI 和工作目录检查未发现缺失；查看同次调用的 provider.spawn_error 原始错误或 provider.stderr、provider.exit，不要只依据摘要判断原因。");
  return { command, cwd, searchPath, platform: process.platform, architecture: process.arch, workingDirectory, candidates, interpreter, commonLocations, problems, nextSteps };
}
