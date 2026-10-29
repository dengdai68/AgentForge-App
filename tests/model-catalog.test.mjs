import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeModelCatalog, CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from "../server/runtime/model-catalog.mjs";

const codexFixture = {
  models: [
    { slug: "gpt-real", display_name: "GPT Real", description: "真实目录模型", visibility: "list", supported_in_api: true, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low", description: "快" }, { effort: "medium", description: "均衡" }, { effort: "high", description: "深" }], model_messages: { persistent_instructions: "INTERNAL_MODEL_MESSAGE_MUST_NOT_LEAK" } },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_in_api: true, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt no spaces!", display_name: "Invalid slug", visibility: "list", supported_reasoning_levels: [] },
    { slug: "gpt-no-levels", display_name: "No Levels", visibility: "list", supported_in_api: true, default_reasoning_level: "low" }
  ]
};

test("codex catalog projects the real CLI catalog without inventing or leaking model internals", async () => {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: JSON.stringify(codexFixture) }; };
  const catalog = await runtimeModelCatalog({ provider: "codex", executable: "/custom/codex" }, { run });
  assert.deepEqual(calls[0].args, ["debug", "models"]);
  assert.equal(calls[0].command, "/custom/codex");
  assert.ok(calls[0].options.env.PATH, "catalog query uses the same CLI environment resolution as real spawns");
  assert.equal(catalog.source, "codex debug models（本机 CLI 目录）");
  assert.deepEqual(catalog.models.map(model => model.id), ["gpt-real", "gpt-no-levels"], "hidden and malformed entries are excluded");
  assert.deepEqual(catalog.models[0].levels, [{ id: "low", description: "快", default: false }, { id: "medium", description: "均衡", default: true }, { id: "high", description: "深", default: false }]);
  assert.equal(catalog.models[0].supportedInApi, true);
  assert.deepEqual(catalog.models[1].levels, []);
  assert.ok(!JSON.stringify(catalog).includes("INTERNAL_MODEL_MESSAGE_MUST_NOT_LEAK"), "model_messages and other catalog internals are not projected");
  assert.ok(catalog.notes.some(note => note.includes("隐藏")));
});

test("codex catalog reports failure and unparsable output honestly instead of fabricating a list", async () => {
  await assert.rejects(runtimeModelCatalog({ provider: "codex" }, { run: async () => { throw new Error("spawn codex ENOENT"); } }), /模型目录查询失败/);
  await assert.rejects(runtimeModelCatalog({ provider: "codex" }, { run: async () => ({ stdout: "not json" }) }), /无法解析/);
  await assert.rejects(runtimeModelCatalog({ provider: "codex" }, { run: async () => ({ stdout: '{"models":"nope"}' }) }), /无法解析/);
  const empty = await runtimeModelCatalog({ provider: "codex" }, { run: async () => ({ stdout: '{"models":[]}' }) });
  assert.deepEqual(empty.models, [], "empty catalog stays empty");
  await assert.rejects(runtimeModelCatalog({ provider: "other" }), /provider/);
});

async function claudeHome(settings) {
  const home = await mkdtemp(join(tmpdir(), "af-claude-catalog-"));
  await mkdir(join(home, ".claude"));
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  return home;
}

test("claude catalog reads aliases, pins and current model from local configuration with environment precedence", async () => {
  const home = await claudeHome({
    model: "settings-model",
    env: {
      ANTHROPIC_AUTH_TOKEN: "CREDENTIAL_SENTINEL",
      ANTHROPIC_API_KEY: "KEY_SENTINEL",
      ANTHROPIC_MODEL: "pinned-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-actual",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet 显示名",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-actual",
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: "thinking"
    }
  });
  const catalog = await runtimeModelCatalog({ provider: "claude-code" }, { environment: {}, homeDirectory: home });
  const sonnet = catalog.models.find(model => model.id === "sonnet");
  assert.equal(sonnet.resolvedTo, "sonnet-actual");
  assert.equal(sonnet.label, "Sonnet 显示名");
  assert.deepEqual(sonnet.levels, CLAUDE_EFFORT_LEVELS, "undeclared capabilities keep the documented CLI levels with an honest note");
  assert.match(sonnet.note, /未声明模型能力/);
  const opus = catalog.models.find(model => model.id === "opus");
  assert.deepEqual(opus.levels, [], "declared capabilities without effort offer no levels");
  assert.match(opus.note, /不支持思考档位/);
  const pinned = catalog.models.find(model => model.id === "sonnet-actual");
  assert.equal(pinned.current, false);
  const current = catalog.models.find(model => model.id === "pinned-model");
  assert.equal(current.current, true);
  assert.match(current.source, /ANTHROPIC_MODEL/);
  assert.ok(!catalog.models.some(model => model.id === "settings-model"), "settings.json model is shadowed by ANTHROPIC_MODEL");
  assert.ok(catalog.models.some(model => model.id === "opusplan"), "documented built-in aliases are always listed");
  const output = JSON.stringify(catalog);
  assert.ok(!output.includes("CREDENTIAL_SENTINEL") && !output.includes("KEY_SENTINEL"), "credential values are never read into the catalog");
});

test("claude catalog environment overrides settings.json and works without any settings file", async () => {
  const home = await claudeHome({ model: "settings-model", env: { ANTHROPIC_MODEL: "settings-env-model" } });
  const overridden = await runtimeModelCatalog({ provider: "claude-code" }, { environment: { ANTHROPIC_MODEL: "process-env-model" }, homeDirectory: home });
  assert.equal(overridden.models.find(model => model.current)?.id, "process-env-model");
  const settingsEnv = await runtimeModelCatalog({ provider: "claude-code" }, { environment: {}, homeDirectory: home });
  assert.equal(settingsEnv.models.find(model => model.current)?.id, "settings-env-model");
  const emptyHome = await mkdtemp(join(tmpdir(), "af-claude-catalog-empty-"));
  const bare = await runtimeModelCatalog({ provider: "claude-code" }, { environment: {}, homeDirectory: emptyHome });
  assert.equal(bare.models.length, 9, "built-in aliases are listed even without settings.json");
  assert.ok(!bare.models.some(model => model.current));
  const brokenHome = await mkdtemp(join(tmpdir(), "af-claude-catalog-broken-"));
  await mkdir(join(brokenHome, ".claude"));
  await writeFile(join(brokenHome, ".claude", "settings.json"), "{broken");
  await assert.rejects(runtimeModelCatalog({ provider: "claude-code" }, { environment: {}, homeDirectory: brokenHome }), /不是有效 JSON/);
});

test("effort vocabularies come from observed CLI behavior only", () => {
  assert.deepEqual(CLAUDE_EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(CODEX_EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max", "ultra"]);
});

test("claude catalog pins and capability declarations are honored by the market spawn environment (QA-RT-03)", async () => {
  const { claudeMarketEnvironment } = await import("../server/runtime/extensions.mjs");
  const home = await mkdtemp(join(tmpdir(), "af-claude-consistency-"));
  await mkdir(join(home, ".claude"));
  const settingsPath = join(home, ".claude", "settings.json");
  await writeFile(settingsPath, JSON.stringify({ env: {
    ANTHROPIC_DEFAULT_FABLE_MODEL: "qa-fable-model",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "qa-sonnet-model",
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: "thinking"
  } }));
  // Both production paths resolve process env first, then settings.json env.
  // Strip only the location override so the fixture home is authoritative;
  // inherited operator ANTHROPIC_* pins then shadow the fixture identically on
  // both sides, which is exactly the precedence the contract documents.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CLAUDE_CONFIG_DIR"));
  const catalog = await runtimeModelCatalog({ provider: "claude-code" }, { environment, homeDirectory: home });
  const spawnEnv = await claudeMarketEnvironment(settingsPath);
  const effective = (key) => environment[key] ?? spawnEnv[key];
  // Assert by real alias, never by a pinned model ID (QA-RT-04: an actual model
  // ID is not an alias and has no ANTHROPIC_DEFAULT_<id>_* key).
  for (const alias of ["haiku", "sonnet", "opus", "fable"]) {
    const upper = alias.toUpperCase();
    const entry = catalog.models.find(model => model.id === alias);
    assert.ok(entry, `alias ${alias} is listed`);
    if (entry.resolvedTo) assert.equal(effective(`ANTHROPIC_DEFAULT_${upper}_MODEL`), entry.resolvedTo, `catalog pin for ${alias} must match the market spawn environment`);
    if (Array.isArray(entry.capabilities)) assert.equal(effective(`ANTHROPIC_DEFAULT_${upper}_MODEL_SUPPORTED_CAPABILITIES`), entry.capabilities.join(","), `capability declaration for ${alias} must match the market spawn environment`);
  }
  // Direct pass-through for keys the process env does not shadow (QA-RT-03).
  if (process.env.ANTHROPIC_DEFAULT_FABLE_MODEL === undefined) {
    assert.equal(spawnEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, "qa-fable-model");
    assert.equal(catalog.models.find(model => model.id === "fable").resolvedTo, "qa-fable-model");
  }
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES === undefined)
    assert.equal(spawnEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES, "thinking");
});

test("assertModelEffort constrains only catalog-listed models and never invents rejections", async () => {
  const { assertModelEffort } = await import("../server/runtime/model-catalog.mjs");
  const codex = { models: [
    { id: "known", levels: [{ id: "low" }, { id: "high" }] },
    { id: "no-levels", levels: [] }
  ] };
  assert.doesNotThrow(() => assertModelEffort(codex, "known", "high"));
  assert.throws(() => assertModelEffort(codex, "known", "max"), /模型 known 不支持思考等级 max/);
  assert.throws(() => assertModelEffort(codex, "no-levels", "low"), /不支持思考等级/);
  assert.doesNotThrow(() => assertModelEffort(codex, "manual-model", "max"), "manual models are unknown capability: no rejection");
  assert.doesNotThrow(() => assertModelEffort(null, "known", "max"), "catalog outage: no rejection");
  const claude = { models: [{ id: "sonnet", levels: CLAUDE_EFFORT_LEVELS }] };
  assert.doesNotThrow(() => assertModelEffort(claude, "sonnet", "xhigh"), "claude entries carry string levels");
  assert.throws(() => assertModelEffort(claude, "sonnet", "ultra"), /不支持/);
});
