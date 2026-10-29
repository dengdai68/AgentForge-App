import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runClaudeCodeCli, runCodexCli } from "./local-cli.mjs";
import { terminateExecution } from "./registry.mjs";
import { diagnostic, diagnostics, withDiagnosticContext } from "../diagnostics.mjs";

// Connection tests are invocations, not business Runs or delivery facts.
export async function probeRuntime(profile, { timeoutMs = 90000, invoke } = {}) {
  const testId = `runtime-test-${randomUUID()}`, started = Date.now();
  return withDiagnosticContext({ source: "runtime-test", testId, profileId: profile.id }, async () => {
    let directory, timer, expired = false;
    try {
      directory = await mkdtemp(join(tmpdir(), "agentforge-runtime-test-"));
      const traceDirectory = join(directory, "trace");
      await mkdir(join(traceDirectory, "output"), { recursive: true });
      const outputSchema = { type: "object", properties: { status: { type: "string", enum: ["ok"] } }, required: ["status"], additionalProperties: false };
      const schemaPath = join(traceDirectory, "schema.json");
      await writeFile(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 });
      timer = setTimeout(() => { expired = true; terminateExecution(testId, "连接测试超时"); }, timeoutMs);
      const runtime = { provider: profile.provider, executable: profile.executable, model: profile.model, effort: profile.effort || "", profile: profile.profile, skillPaths: [], pluginPaths: [], mcpConfigPaths: [], extensionSelection: { pluginIds: [], mcpIds: [] }, extensionManifest: [] };
      diagnostic("runtime_test.started", { provider: profile.provider, model: profile.model, effort: profile.effort || "" });
      const result = await (invoke || (profile.provider === "codex" ? runCodexCli : runClaudeCodeCli))({ runtime, workspacePath: directory, traceDirectory, schemaPath, finalPath: join(traceDirectory, "final.json"), outputSchema, prompt: 'Connection check only. Do not use tools or read or write files. Return exactly {"status":"ok"} using the required output schema.', runId: testId, executionKey: testId, canStart: () => !expired, idleTimeoutMs: timeoutMs, apiRetryTimeoutMs: timeoutMs, onEvent: async () => {} });
      if (expired) throw new Error("连接测试超时");
      const output = JSON.parse(result.finalText);
      if (output.status !== "ok" || Object.keys(output).length !== 1) throw new Error("模型未返回有效测试应答");
      diagnostic("runtime_test.completed");
      return { ok: true, testId, durationMs: Date.now() - started, logPath: diagnostics().status().filePath };
    } catch (error) {
      diagnostic("runtime_test.failed", { error, timedOut: expired });
      return { ok: false, timedOut: expired, testId, durationMs: Date.now() - started, logPath: diagnostics().status().filePath };
    } finally {
      clearTimeout(timer);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(error => diagnostic("runtime_test.cleanup_failed", { error }));
    }
  });
}
