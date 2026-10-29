import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredFiles = [
  "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "docs/00-ai-map.md", "docs/01-product-requirements.md",
  "docs/02-system-architecture.md", "docs/03-domain-model.md",
  "docs/06-design-system.md", "docs/README.md", "CHANGELOG.md",
  "ai/README.md", "ai/module-registry.json", "server/index.mjs", "server/store.mjs",
  "server/orchestrator.mjs", "web/index.html", "web/app.js", "web/styles.css",
  "server/README.md", "web/README.md", "tests/README.md", "scripts/README.md",
  "scripts/check-module-impact.mjs"
];

export function validateInstructions(agents, claude) {
  if (claude.trim() !== "[@AGENTS.md](AGENTS.md)") throw new Error("CLAUDE.md must only reference the local AGENTS.md");
  for (const section of ["## 开始前", "## 分层与底线", "## 修改要求", "## 验证与交付"]) {
    if (!agents.includes(section)) throw new Error(`AI contract is missing required section: ${section}`);
  }
  if (!/^- \*\*CLI 同步\*\*：/m.test(agents)) throw new Error("AI contract is missing the CLI synchronization rule");
}

async function verifyContract() {
  for (const relativePath of requiredFiles) await access(join(root, relativePath), constants.F_OK);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
  validateInstructions(agents, claude);
  const map = await readFile(join(root, "docs/00-ai-map.md"), "utf8");
  for (const path of ["ai/module-registry.json", "server/store.mjs", "server/orchestrator.mjs", "server/index.mjs", "web/app.js"]) {
    if (!map.includes(path)) throw new Error(`AI map is missing module path: ${path}`);
  }
  const registry = JSON.parse(await readFile(join(root, "ai/module-registry.json"), "utf8"));
  if (registry.schemaVersion !== 1 || registry.project !== "agentforge" || registry.instructions?.length !== 2 || registry.modules?.length < 8) {
    throw new Error("AI module registry is incomplete");
  }
  for (const moduleRoot of registry.moduleRoots || []) {
    if (!moduleRoot.path || !moduleRoot.localReadme) throw new Error("AI module root is missing path or localReadme");
  }
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes("## [Unreleased]")) throw new Error("CHANGELOG.md must contain an Unreleased section");
  console.log("AI contract OK: canonical instructions, local Claude reference, CLI synchronization rule, module map and changelog are valid.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyContract();
