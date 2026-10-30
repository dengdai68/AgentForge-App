import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { withHistoryTools } from "./history/bridge.mjs";
import { diagnostic, withDiagnosticContext } from "./diagnostics.mjs";
import { communicationPrompt } from "./prompts.mjs";
import { runClaudeCodeCli, runCodexCli, RuntimeSessionMissingError, redactExternalText, separateRuntimeSession, promptSnapshot } from "./runtime/local-cli.mjs";

// Strict Providers (Codex response_format) require every property in
// `required`; the nullable handoff key satisfies that while null still means
// no handoff. The Store keeps accepting an omitted key for robustness.
const schema = { type: "object", additionalProperties: false, properties: { reply: { type: "string" }, handoffToAgentId: { type: ["string", "null"] } }, required: ["reply", "handoffToAgentId"] };

export function createCommunicationService(store, { root, invoke, files } = {}) {
  const active = new Map();
  async function execute(key, item) {
      try {
        if (!item.available) throw new Error("被 @ 的成员已离开团队或停用，请恢复成员后重试");
        const agent = item.agentSnapshot, cwd = resolve(root, key, agent.id);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const canonicalRoot = await realpath(root), actual = await realpath(cwd);
        if (!actual.startsWith(canonicalRoot + sep)) throw new Error("沟通目录越界");
        const directory = join(cwd, item.id, String(item.attempts));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await realpath(directory)).startsWith(actual + sep)) throw new Error("沟通记录目录越界");
        const schemaPath = join(directory, "response-schema.json"), finalPath = join(directory, "response.json");
        await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
        const session = store.prepareCommunicationSession(key, item.id, cwd);
        store.appendCommunicationEvent(key, item.id, { providerEventType: session.resume ? 'session.resumed' : 'session.created', message: session.resume ? '继续该成员的独立会话。' : '为该成员建立独立会话。' });
        const context = store.communicationContext(key, item.id);
        const message = ({ id, sender, content, attachments = [], replyToMessageId, createdAt }) => ({ id, sender, content, replyToMessageId, createdAt, attachments: attachments.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256, path: resolve(root, key, file.path) })) });
        const input = communicationPrompt({ agent, context: { ...context, message: message(context.message) }, root: resolve(root, key), cwd, messages: context.messages.map(message) });
        const onPrompt = async value => {
          if (!files?.writeCommunicationContent) return;
          try {
            const contentRef = await files.writeCommunicationContent(key, item.id, item.attempts, promptSnapshot(value));
            store.appendCommunicationEvent(key, item.id, { providerEventType: 'prompt.snapshot', data: { contentRef } });
          } catch (error) { diagnostic('communication.prompt_snapshot_failed', { error }); }
        };
        const provider = invoke || (agent.runtime.provider === "codex" ? runCodexCli : runClaudeCodeCli);
        const result = await withHistoryTools(store, agent, {
          runtime: agent.runtime, workspacePath: cwd, traceDirectory: directory, schemaPath, finalPath, outputSchema: schema,
          ...input, onPrompt, runId: key, executionKey: `communication:${key}:${agent.id}`, session,
          onEvent: async (event) => {
            const { sessionId, auditEvent, content } = separateRuntimeSession(event);
            if (content && files) auditEvent.data.contentRef = await files.writeCommunicationContent(key, item.id, item.attempts, content);
            if ((auditEvent.providerEventType === "system" || auditEvent.providerEventType === "thread.started") && sessionId) store.confirmCommunicationSession(key, item.id, sessionId);
            store.appendCommunicationEvent(key, item.id, auditEvent);
          }
        }, provider, files);
        let parsed;
        try { parsed = JSON.parse(result.finalText); } catch (error) { diagnostic("communication.result_parse_error", { error }); throw new Error("Agent 未返回有效的沟通回复 JSON"); }
        if (!parsed || typeof parsed.reply !== "string" || !parsed.reply.trim()) throw new Error("Agent 沟通回复为空");
        if (Array.isArray(parsed) || Object.keys(parsed).some((key) => !["reply", "handoffToAgentId"].includes(key))
          || (parsed.handoffToAgentId !== undefined && parsed.handoffToAgentId !== null && (typeof parsed.handoffToAgentId !== "string" || !parsed.handoffToAgentId.trim()))) throw new Error("Agent 沟通回复结构无效");
        const reply = redactExternalText(parsed.reply);
        store.completeCommunication(key, item.id, reply, parsed.handoffToAgentId ?? null);
        diagnostic("communication.completed");
      } catch (error) {
        diagnostic("communication.failed", { error });
        store.failCommunication(key, item.id, redactExternalText(error.message || "回复失败"), error instanceof RuntimeSessionMissingError);
      }
  }
  function pump(key) {
    let workers = active.get(key);
    if (!workers) { workers = new Set(); active.set(key, workers); }
    for (;;) {
      const item = store.claimCommunication(key);
      if (!item) break;
      const worker = withDiagnosticContext({ source: "communication", conversationId: key, deliveryId: item.id, agentId: item.agentSnapshot?.id, attempt: item.attempts }, async () => {
        diagnostic("communication.started");
        return execute(key, item);
      }).finally(() => workers.delete(worker));
      workers.add(worker);
    }
    return workers;
  }
  return {
    isActive() { return active.size > 0; },
    async kick(key) {
      // Claim is synchronous: concurrent wakeups cannot claim a member twice.
      let workers = pump(key);
      while (workers.size) {
        await Promise.race(workers);
        workers = pump(key);
      }
      if (active.get(key) === workers) active.delete(key);
    },
    recover() { store.recoverCommunications(); },
    async poll() { await Promise.all(store.pendingCommunications().map((key) => this.kick(key))); }
  };
}
