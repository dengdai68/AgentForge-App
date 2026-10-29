import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliEnvironment } from "./cli-environment.mjs";
import { diagnostic } from "../diagnostics.mjs";

const exec = promisify(execFile);

// Effort vocabularies are observed from the real CLIs, never invented:
// claude --help documents low|medium|high|xhigh|max (2.1.216); codex debug
// models reports supported_reasoning_levels per model (codex-cli 0.160.0).
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Claude Code has no offline model-list command (verified against the official
// docs). The locally resolvable candidates are the documented built-in aliases
// plus alias pins and the current model declared in settings.json/environment.
const CLAUDE_ALIASES = ["default", "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]", "opusplan"];
const CLAUDE_PIN_ALIASES = ["HAIKU", "SONNET", "OPUS", "FABLE"];

function claudeEfforts(capabilities) {
  if (Array.isArray(capabilities)) {
    if (!capabilities.includes("effort")) return { levels: [], note: "配置声明该模型不支持思考档位" };
    return { levels: CLAUDE_EFFORT_LEVELS, note: "配置声明该模型支持 effort 能力" };
  }
  return { levels: CLAUDE_EFFORT_LEVELS, note: "未声明模型能力；档位由 CLI 按模型实际支持解析，不支持时回退" };
}

async function readClaudeSettings(path) {
  let content;
  try { content = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return {}; throw new Error("Claude 本机配置不可读取"); }
  try {
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error();
    const settings = JSON.parse(content);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
    return settings;
  } catch { throw new Error("Claude 本机配置不是有效 JSON"); }
}

// Only model/address/capability keys are read. Credential keys
// (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ...) are never read, copied,
// logged or returned; the same boundary as claudeMarketEnvironment.
async function claudeCatalog({ environment, homeDirectory }) {
  const settingsPath = join(environment.CLAUDE_CONFIG_DIR || join(homeDirectory, ".claude"), "settings.json");
  const settings = await readClaudeSettings(settingsPath);
  const pick = (key) => typeof environment[key] === "string" && environment[key] ? environment[key]
    : typeof settings.env?.[key] === "string" && settings.env[key] ? settings.env[key] : undefined;
  const pins = {};
  for (const alias of CLAUDE_PIN_ALIASES) {
    pins[alias] = {
      model: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL`),
      name: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL_NAME`),
      description: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL_DESCRIPTION`),
      capabilities: pick(`ANTHROPIC_DEFAULT_${alias}_MODEL_SUPPORTED_CAPABILITIES`)?.split(",").map(item => item.trim()).filter(Boolean)
    };
  }
  const current = pick("ANTHROPIC_MODEL") || (typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : undefined);
  const currentFromSettingsOnly = !pick("ANTHROPIC_MODEL") && current;
  const models = [];
  const seen = new Set();
  const pushModel = (model) => {
    const key = `${model.id}${model.resolvedTo || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };
  for (const alias of CLAUDE_ALIASES) {
    const pin = pins[alias.toUpperCase()];
    const resolved = pin?.model || undefined;
    pushModel({
      id: alias,
      label: pin?.name || alias,
      description: pin?.description || "",
      resolvedTo: resolved,
      capabilities: pin?.capabilities,
      current: current === alias,
      source: resolved ? "本机别名钉住（settings.json env / 环境变量）" : "Claude Code 内置别名",
      ...claudeEfforts(pin?.capabilities)
    });
  }
  const pinnedIds = new Set(Object.values(pins).map(pin => pin.model).filter(Boolean));
  for (const pinned of [...pinnedIds]) {
    const pin = CLAUDE_PIN_ALIASES.map(alias => ({ alias, ...pins[alias] })).find(item => item.model === pinned);
    const aliases = CLAUDE_PIN_ALIASES.filter(alias => pins[alias].model === pinned).map(alias => alias.toLowerCase()).join("/");
    pushModel({
      id: pinned, label: pinned, description: pin.description || "", resolvedTo: undefined,
      capabilities: pin.capabilities, current: current === pinned,
      source: `别名 ${aliases} 钉住的实际模型 ID`,
      ...claudeEfforts(pin.capabilities)
    });
  }
  if (current && !pinnedIds.has(current) && !CLAUDE_ALIASES.includes(current)) {
    pushModel({
      id: current, label: current, description: "", resolvedTo: undefined, capabilities: undefined, current: true,
      source: currentFromSettingsOnly ? "settings.json model 字段（市场扩展执行使用 --setting-sources '' 时不生效）" : "ANTHROPIC_MODEL 环境变量",
      ...claudeEfforts(undefined)
    });
  }
  return {
    provider: "claude-code",
    source: "Claude Code 内置别名与本机配置（settings.json model/env 与环境变量）",
    notes: [
      "Claude Code 没有离线列出全部模型的命令；此处列出内置别名、本机别名钉住与当前生效模型，可钉任意全量模型 ID。",
      "仅读取模型/名称/说明/能力类键；凭据键（如 ANTHROPIC_AUTH_TOKEN）绝不读取或展示。",
      "选择市场扩展的执行带 --setting-sources ''：settings.json 的 model 字段不生效，ANTHROPIC_* 环境变量按同一优先级生效。",
      "思考档位可用性因模型而异；未声明能力的模型由 CLI 解析，不支持时回退到不超过所选的最高可用档。"
    ],
    models
  };
}

function codexCatalogModels(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) throw new Error("Codex 模型目录结构无法识别");
  return parsed.models
    .filter(item => item && typeof item.slug === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(item.slug))
    .map(item => ({
      slug: item.slug,
      hidden: item.visibility !== "list",
      model: {
        id: item.slug,
        label: typeof item.display_name === "string" ? item.display_name : item.slug,
        description: typeof item.description === "string" ? item.description.slice(0, 500) : "",
        supportedInApi: item.supported_in_api === true,
        source: "codex debug models",
        levels: (Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [])
          .filter(level => level && typeof level.effort === "string" && /^[a-z]{1,20}$/.test(level.effort))
          .map(level => ({ id: level.effort, description: typeof level.description === "string" ? level.description.slice(0, 200) : "", default: level.effort === item.default_reasoning_level }))
      }
    }));
}

async function codexCatalog(executable, { run }) {
  const command = executable || "codex";
  let result;
  try {
    result = await run(command, ["debug", "models"], { env: cliEnvironment(command), timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    diagnostic("provider.model_catalog_failed", { provider: "codex", error });
    throw new Error("Codex 模型目录查询失败：需要支持 debug models 的 codex CLI（0.160.0 起），请检查 CLI 路径与版本");
  }
  let entries;
  try { entries = codexCatalogModels(JSON.parse(result.stdout)); }
  catch (error) {
    diagnostic("provider.model_catalog_invalid", { provider: "codex", error });
    throw new Error("Codex 模型目录输出无法解析；请检查 codex CLI 版本");
  }
  const models = entries.filter(entry => !entry.hidden).map(entry => entry.model);
  return {
    provider: "codex",
    source: "codex debug models（本机 CLI 目录）",
    notes: [
      "目录来自本机 codex CLI；账号实际可用模型以调用为准，目录中可见的模型仍可能被账号权益拒绝。",
      entries.some(entry => entry.hidden) ? "CLI 标记为隐藏的模型不列出。" : "目录不含隐藏模型。",
      "目录为全局目录：codex debug models 不接受 --profile（CLI 实测明确拒绝），命名 profile 仅影响调用时配置，不改变目录。",
      "逐模型思考档位来自目录的 supported_reasoning_levels；模型不在目录（含手工输入）时按 Codex 全局档位集合展示，实际支持以调用为准。"
    ],
    models
  };
}

// Read-only catalog for the Runtime settings surfaces. Profile field changes do
// not reach frozen Task/Run snapshots; this query never mutates CLI state.
export async function runtimeModelCatalog({ provider, executable = null }, { environment = process.env, homeDirectory = homedir(), run = exec } = {}) {
  if (provider === "claude-code") return claudeCatalog({ environment, homeDirectory });
  if (provider === "codex") return codexCatalog(executable, { run });
  throw new Error("provider 必须是 claude-code 或 codex");
}

// Server-side per-model effort check for profile saves. Only models actually
// present in the real catalog are constrained; manual models and catalog
// outages leave capability unknown and must not invent rejections.
export function assertModelEffort(catalog, model, effort) {
  const entry = catalog?.models?.find(item => item.id === model);
  if (!entry) return;
  const levels = (entry.levels || []).map(level => typeof level === "string" ? level : level.id);
  if (!levels.includes(effort)) throw new Error(`模型 ${model} 不支持思考等级 ${effort}（该模型支持：${levels.join(" / ") || "无，请留空使用 CLI 默认"}）`);
}
