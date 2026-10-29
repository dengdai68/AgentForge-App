import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const registryPath = "ai/module-registry.json";
const sourceRoots = new Set(["server/", "client/", "web/", "apps/", "tests/", "scripts/"]);
const sourceExtensions = /\.(mjs|js|ts|tsx|jsx|css|html|json|swift)$/;

async function fileExists(relativePath) {
  try {
    await access(join(root, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function gitChanges(range = null, stagedOnly = false) {
  try {
    if (range) {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${range[0]}...${range[1]}`], { cwd: root });
      return stdout.split("\n").map((path) => path.trim()).filter(Boolean);
    }
    const commands = stagedOnly
      ? [["diff", "--cached", "--name-only", "--diff-filter=ACMR"]]
      : [
          ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
          ["diff", "HEAD", "--name-only", "--diff-filter=ACMR"],
          ["ls-files", "--others", "--exclude-standard"]
        ];
    const outputs = [];
    for (const args of commands) {
      try {
        const { stdout } = await execFileAsync("git", args, { cwd: root });
        outputs.push(...stdout.split("\n").map((path) => path.trim()).filter(Boolean));
      } catch {
        // An unborn repository or missing range is still allowed to run structural checks.
      }
    }
    return [...new Set(outputs)];
  } catch {
    return [];
  }
}

const commandArgs = process.argv.slice(2).filter(Boolean);
const rangeIndex = commandArgs.indexOf("--range");
const range = rangeIndex >= 0 ? commandArgs.slice(rangeIndex + 1, rangeIndex + 3) : null;
const stagedOnly = commandArgs.includes("--staged");
const explicitChanges = rangeIndex >= 0
  ? commandArgs.slice(0, rangeIndex).filter((arg) => arg !== "--staged")
  : commandArgs.filter((arg) => arg !== "--staged");
const changedFiles = new Set(explicitChanges.length ? explicitChanges : await gitChanges(range?.length === 2 ? range : null, stagedOnly));
const registry = JSON.parse(await readFile(join(root, registryPath), "utf8"));
const errors = [];

for (const moduleRoot of registry.moduleRoots || []) {
  if (!moduleRoot.path || !moduleRoot.localReadme) errors.push("Every module root needs path and localReadme");
  else if (!(await fileExists(moduleRoot.localReadme))) errors.push(`Module root README is missing: ${moduleRoot.localReadme}`);
}

for (const module of registry.modules || []) {
  if (!module.id || !module.path || !module.owner || !module.purpose || !module.whenChanged?.mustUpdate?.length) {
    errors.push(`Module entry is incomplete: ${module.id || "<unknown>"}`);
    continue;
  }
  if (!(await fileExists(module.path))) errors.push(`Registered module path is missing: ${module.path}`);
  for (const requiredFile of [...(module.sourceOfTruth || []), ...(module.tests || []).filter((path) => !path.includes("*")), ...(module.whenChanged.mustUpdate || [])]) {
    if (!(await fileExists(requiredFile))) errors.push(`${module.id} references missing file: ${requiredFile}`);
  }
}

function findModule(relativePath) {
  return (registry.modules || [])
    .filter((module) => relativePath === module.path || relativePath.startsWith(module.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

for (const file of changedFiles) {
  if (!sourceExtensions.test(file) || ![...sourceRoots].some((rootPath) => file.startsWith(rootPath))) continue;
  const moduleRoot = [...(registry.moduleRoots || [])].find((candidate) => file.startsWith(candidate.path));
  if (moduleRoot) {
    const nestedPath = file.slice(moduleRoot.path.length).split("/");
    if (nestedPath.length > 1 && ![...registry.modules].some((candidate) => candidate.path === `${moduleRoot.path}${nestedPath[0]}/`)) {
      errors.push(`New nested module needs its own registry entry before implementation: ${file}`);
      continue;
    }
  }
  const module = findModule(file);
  if (!module) {
    errors.push(`Changed source is not registered in ai/module-registry.json: ${file}`);
    continue;
  }
  for (const requiredUpdate of module.whenChanged.mustUpdate) {
    if (!changedFiles.has(requiredUpdate)) errors.push(`${file} changed, so update ${requiredUpdate} in the same change`);
  }
}

if (errors.length) {
  console.error("Module impact check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(changedFiles.size ? `Module impact OK: reviewed ${changedFiles.size} changed file(s).` : "Module registry OK: no staged module source changes to assess.");
