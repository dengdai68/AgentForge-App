import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consoleContentTokens, editDiff, isShellTool, shellCommandText, shellTokens, toolCommandSummary, toolEditInput, toolFileInput, workingDirectoryIcon } from "../client/console-projections.mjs";

test("tool command summaries restate redacted input and never invent fragments", () => {
  assert.equal(toolCommandSummary("Bash", '{"command":"ls \\"/Users/a b/Library\\""}'), 'ls "/Users/a b/Library"');
  assert.equal(toolCommandSummary("Bash", '{"command":"npm test","description":"run"}'), "npm test");
  assert.equal(toolCommandSummary("bash", '{"command":"cat a\\ncat b"}'), "cat a ⏎ cat b");
  // Codex command_execution input is the raw command string, not JSON.
  assert.equal(toolCommandSummary("command_execution", "git status --short"), "git status --short");
  // Truncated JSON cannot be parsed: fall back to no summary, never a half command.
  assert.equal(toolCommandSummary("Bash", '{"command":"git commit -m \\"unclosed'), null);
  assert.equal(toolCommandSummary("Bash", '{"file_path":"src/a.js"}'), null);
  assert.equal(toolCommandSummary("Edit", '{"command":"echo no"}'), null);
  assert.equal(toolCommandSummary("Bash", ""), null);
  assert.equal(toolCommandSummary("Bash", null), null);
});

test("file tool summaries and Write content use only complete recorded input", () => {
  assert.equal(toolCommandSummary("Read", '{"file_path":"docs/a b.md","offset":3}'), "docs/a b.md");
  assert.equal(toolCommandSummary("write", '{"path":"src/例子.js","content":""}'), "src/例子.js");
  assert.deepEqual(toolFileInput("Write", '{"file_path":"a.js","content":"<script>\\nconst x = 1;"}'), { filePath: "a.js", content: "<script>\nconst x = 1;" });
  assert.equal(toolFileInput("Write", '{"file_path":"empty.txt","content":""}').content, "");
  assert.equal(toolFileInput("Write", '{"file_path":"a","content":42}').content, null);
  for (const input of ['{"file_path":"a","content":"unclosed', '{"file_path":1}', 'null', '[]', '{}']) {
    assert.equal(toolFileInput("Read", input), null);
    assert.equal(toolCommandSummary("Write", input), null);
  }
  assert.equal(toolFileInput("Bash", '{"file_path":"a"}'), null);
});

test("edit inputs and diffs are truthful for real, empty and broken records", () => {
  const input = toolEditInput("Edit", '{"file_path":"src/a b.js","old_string":"line1\\nline2\\nline3","new_string":"line1\\nchanged\\nline3"}');
  assert.deepEqual(input, { filePath: "src/a b.js", oldText: "line1\nline2\nline3", newText: "line1\nchanged\nline3" });
  const diff = editDiff(input.oldText, input.newText);
  assert.deepEqual(diff.lines, [
    { type: "context", text: "line1" },
    { type: "del", text: "line2" },
    { type: "add", text: "changed" },
    { type: "context", text: "line3" },
  ]);
  assert.equal(diff.aligned, true);
  const insertion = editDiff("", "added line");
  assert.deepEqual(insertion.lines, [{ type: "del", text: "" }, { type: "add", text: "added line" }]);
  // Broken or empty records refuse a diff instead of fabricating one.
  assert.equal(toolEditInput("Edit", '{"file_path":"x","old_string":"a","new_string":"b"'.slice(0, 30)), null);
  assert.equal(toolEditInput("Edit", '{"old_string":"","new_string":""}'), null);
  assert.equal(toolEditInput("Edit", '{"old_string":1,"new_string":"b"}'), null);
  assert.equal(toolEditInput("Bash", '{"old_string":"a","new_string":"b"}'), null);
  assert.equal(editDiff("a", 42), null);
  const huge = editDiff("x\n".repeat(2000), "y\n".repeat(2000), { maxCells: 100 });
  assert.equal(huge.aligned, false);
  assert.ok(huge.lines.some((line) => line.type === "del") && huge.lines.some((line) => line.type === "add"));
});

test("console JSON formatting preserves exact tokens and degrades without invention", () => {
  const original = '{"large":9007199254740993,"s":"<img src=x>\\n","a":[true,null,{},[]],"n":1e+09}';
  const result = consoleContentTokens(original);
  assert.equal(result.json, true);
  assert.match(result.tokens.map(t => t.text).join(""), /\n  "large": 9007199254740993,/);
  assert.ok(result.tokens.some(t => t.kind === "number" && t.text === "1e+09"));
  for (const kind of ["attr", "string", "literal"]) assert.ok(result.tokens.some(t => t.kind === kind));
  assert.deepEqual(JSON.parse(result.tokens.map(t => t.text).join("")), JSON.parse(original));
  for (const value of ['{"broken":', 'plain <script>', '['.repeat(41) + '0' + ']'.repeat(41)]) assert.equal(consoleContentTokens(value).json, false);
  assert.equal(consoleContentTokens(original, { truncated: true }).json, false);
  assert.equal(consoleContentTokens(original, { json: false }).json, false);
});

test("shell projections expose raw commands and honest fallbacks", () => {
  assert.equal(isShellTool("Bash"), true);
  assert.equal(isShellTool("command_execution"), true);
  assert.equal(isShellTool("Edit"), false);
  assert.equal(isShellTool(""), false);
  // The raw multi-line command is preserved verbatim, never summary-joined.
  assert.equal(shellCommandText("Bash", '{"command":"cd /tmp && ls\\n  cat a.txt","description":"x"}'), "cd /tmp && ls\n  cat a.txt");
  assert.equal(shellCommandText("command_execution", "git status --short"), "git status --short");
  assert.equal(shellCommandText("Bash", '{"command":"git commit -m \\"unclosed'), null, "truncated JSON never yields a half command");
  assert.equal(shellCommandText("Bash", '{"file_path":"a.js"}'), null);
  assert.equal(shellCommandText("Bash", ""), null);
  assert.equal(shellCommandText("Edit", '{"command":"echo no"}'), null);
});

test("shell tokens re-segment the original text without loss or invention", () => {
  const samples = [
    "npm test -- --grep 'a b' # run it\n  echo \"hi $HOME\" && git log -p",
    "cat <<'EOF'\nline\nEOF",
    "printf '%s' \"$x\" | grep -e foo > out.txt; echo $?",
    "unicode 命令 && echo 完成",
    "",
  ];
  for (const sample of samples) assert.equal(shellTokens(sample).map((token) => token.text).join(""), sample, "token text must rejoin exactly");
  const tokens = shellTokens("npm test # note\nls -la \"a b\" && pwd");
  assert.deepEqual(tokens.find((token) => token.kind === "command")?.text, "npm");
  assert.ok(tokens.some((token) => token.kind === "comment" && token.text === "# note"));
  assert.ok(tokens.some((token) => token.kind === "option" && token.text === "-la"));
  assert.ok(tokens.some((token) => token.kind === "string" && token.text === '"a b"'));
  assert.ok(tokens.some((token) => token.kind === "operator"));
  assert.equal(shellTokens("echo $HOME")[2]?.kind, "variable");
});

test("working directory icons map common types and fall back honestly", () => {
  assert.deepEqual(workingDirectoryIcon("docs", "directory"), { closed: "default_folder", open: "default_folder_opened" });
  assert.equal(workingDirectoryIcon("README.md", "file").closed, "file_type_markdown");
  assert.equal(workingDirectoryIcon("app.JS", "file").closed, "file_type_js");
  assert.equal(workingDirectoryIcon("module.mjs", "file").closed, "file_type_js");
  assert.equal(workingDirectoryIcon("app.ts", "file").closed, "file_type_typescript");
  assert.equal(workingDirectoryIcon("package.json", "file").closed, "file_type_json");
  assert.equal(workingDirectoryIcon("styles.css", "file").closed, "file_type_css");
  assert.equal(workingDirectoryIcon("run.sh", "file").closed, "file_type_shell");
  assert.equal(workingDirectoryIcon("config.yaml", "file").closed, "file_type_yaml");
  assert.equal(workingDirectoryIcon(".gitignore", "file").closed, "file_type_git");
  assert.equal(workingDirectoryIcon("photo.png", "file").closed, "file_type_image");
  assert.equal(workingDirectoryIcon("unknown.xyzq", "file").closed, "default_file", "unknown extensions use the default glyph");
  assert.equal(workingDirectoryIcon("LICENSE", "file").closed, "file_type_text");
  assert.equal(workingDirectoryIcon("", "file").closed, "default_file");
});

test("StructuredOutput remains directly readable rather than grouped", () => {
  const events = [1, 2].map(id => ({ id, type: "runtime.event", data: { presentation: "tool", toolName: "StructuredOutput", toolUseId: String(id) } }));
  assert.deepEqual(buildConsoleEntries(events).map(e => e.type), ["tool", "tool"]);
});
import { TASK_FILTERS, buildConsoleEntries, collaborationRecords, displayText, isRoutineConsoleEvent, isTransportFrame, mentionables, roleExecutionStatus, taskActionLabel, taskMatchesFilter, taskNeedsAttention, workspaceAgents, workflowFocus } from "../client/console-projections.mjs";

test("console hides empty lifecycle/provider notifications, not content or abnormal events", () => {
  const runtime = (type, message, extra = {}) => ({ type: "runtime.event", message, data: { auditVersion: 2, providerEventType: type, presentation: "output", ...extra } });
  const noise = [
    ...["session.created", "session.resumed", "communication.started", "communication.completed", "trace.started", "trace.completed", "trace.accepted"].map(type => ({ type })),
    runtime("system", "Provider 会话已初始化", { presentation: "system", subtype: "init" }),
    runtime("thread.started", "成员会话已连接", { presentation: "system" }),
    runtime("stderr", "Provider 诊断输出已隐藏", { presentation: "system" }),
    runtime("item.completed", "Provider 已返回结构化结果"),
    runtime("result", "Provider 已返回结构化结果"),
    runtime("turn.started", "模型已更新执行进展"),
    runtime("turn.completed", "模型已更新执行进展"),
    runtime("assistant", "模型正在整理执行方案", { presentation: "thinking" }),
    runtime("tool_progress", "模型已更新执行进展"),
  ];
  const visible = [
    runtime("item.completed", "Provider 已返回结构化结果", { contentRef: { storagePath: "private" } }),
    runtime("assistant", "模型正在整理执行方案", { presentation: "thinking", contentRef: {} }),
    runtime("item.completed", "Provider 已返回结构化结果", { presentation: "tool_result", status: "failed" }),
    runtime("item.started", "已请求本机工具", { presentation: "tool" }),
    runtime("system", "Provider 正在重试请求", { presentation: "system", subtype: "api_retry" }),
    runtime("stdout", "Provider 输出无法作为审计事件解析", { presentation: "system" }),
    runtime("error", "Provider 返回了失败事件", { presentation: "error" }),
    runtime("item.completed", "尚未识别的新消息"),
    { type: "runtime.event", message: "Provider 已返回结构化结果", data: { providerEventType: "result" } },
    ...["session.reset", "communication.failed", "communication.session_reset", "communication.recovered", "communication.handoff_queued", "trace.failed", "trace.cancelled", "dispatch.retry_scheduled", "run.awaiting_acceptance", "node.completed"].map(type => ({ type })),
  ];
  for (const event of noise) assert.equal(isRoutineConsoleEvent(event), true, JSON.stringify(event));
  for (const event of noise.filter(e => e.type === "runtime.event")) {
    const prefixed = { ...event, message: `${event.data.providerEventType}: ${event.message}` };
    assert.equal(isRoutineConsoleEvent(prefixed), true, "task Provider prefix: " + prefixed.message);
    if (event.data.providerEventType !== "stderr") assert.equal(isRoutineConsoleEvent({ ...prefixed, data: { ...prefixed.data, contentRef: {} } }), false, "a stored body is never hidden");
  }
  for (const event of visible) assert.equal(isRoutineConsoleEvent(event), false, JSON.stringify(event));
  const events = structuredClone([...noise, ...visible]);
  const before = structuredClone(events);
  const entries = buildConsoleEntries(events);
  assert.equal(entries.length, visible.length);
  assert.deepEqual(events, before, "display filtering never mutates persisted audit facts");
});

test("empty notifications do not break tool pairing/grouping across a raw page", () => {
  const use = id => ({ type: "runtime.event", data: { presentation: "tool", toolName: "Bash", traceId: "t", toolUseId: id } });
  const result = id => ({ type: "runtime.event", data: { presentation: "tool_result", toolName: "Bash", traceId: "t", toolResultId: id } });
  const noise = { type: "runtime.event", message: "模型已更新执行进展", data: { auditVersion: 2, providerEventType: "turn.started" } };
  const entries = buildConsoleEntries([use("1"), noise, result("1"), noise, use("2"), result("2")]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "tool-group");
  assert.ok(entries[0].tools.every(tool => tool.result));
});

test('tool phases with one native ID appear once while distinct calls remain distinct', () => {
  const start = id => ({ id: 'start-' + id, type: 'runtime.event', data: { auditVersion: 2, traceId: 'trace', presentation: 'tool', toolUseId: id, toolName: 'web_search' } });
  const end = id => ({ id: 'end-' + id, type: 'runtime.event', data: { auditVersion: 2, traceId: 'trace', presentation: 'tool_result', toolResultId: id, toolName: 'web_search' } });
  const one = buildConsoleEntries([start('one'), start('one'), end('one'), end('one')]);
  assert.equal(one.length, 1); assert.equal(one[0].type, 'tool'); assert.equal(one[0].result.id, 'end-one');
  const two = buildConsoleEntries([start('one'), end('one'), start('two'), end('two')]);
  assert.equal(two[0].type, 'tool-group'); assert.equal(two[0].tools.length, 2);
  const reversed = buildConsoleEntries([end('one'), start('one')]); assert.equal(reversed.length, 1); assert.equal(reversed[0].result.id, 'end-one');
  const completedOnly = buildConsoleEntries([end('one'), end('one')]); assert.equal(completedOnly.length, 1); assert.equal(completedOnly[0].result, null, 'an orphan completion repeated by Provider never renders two bodies');
});

test("tool result IDs are scoped to Trace rather than reused across invocations", () => {
  const use = { id: 'a', type: 'runtime.event', data: { traceId: 'old', presentation: 'tool', toolUseId: 'item_0', toolName: 'Bash' } };
  const result = { id: 'b', type: 'runtime.event', data: { traceId: 'new', presentation: 'tool_result', toolResultId: 'item_0', toolName: 'Bash' } };
  const entries = buildConsoleEntries([use, result]);
  assert.equal(entries.length, 2, "different Traces never merge into one visual group");
  assert.equal(entries[0].result, null, "a tool result from another Trace is never paired");
});

test('identical arguments never collapse independently identified or unidentified tool calls', () => {
  const call = id => ({ id: 'use-' + id, type: 'runtime.event', data: { traceId: 't', presentation: 'tool', toolName: 'maps_weather', toolUseId: id, input: '{"city":"北京"}' } });
  const result = id => ({ id: 'result-' + id, type: 'runtime.event', data: { traceId: 't', presentation: 'tool_result', toolName: 'maps_weather', toolResultId: id, output: 'sunny' } });
  const events = [call('a'), call('a'), result('a'), result('a'), call('b'), result('b')];
  const before = structuredClone(events);
  const entries = buildConsoleEntries(events);
  assert.equal(entries[0].tools.length, 2, 'duplicate phases collapse only within one native ID');
  assert.deepEqual(entries[0].tools.map(tool => [tool.event.id, tool.result.id]), [['use-a', 'result-a'], ['use-b', 'result-b']]);
  const unidentified = buildConsoleEntries([call(undefined), call(undefined)]);
  assert.equal(unidentified[0].tools.length, 2, 'without a native ID there is no evidence that calls are duplicates');
  assert.deepEqual(events, before, 'immutable audit facts remain unchanged');
});

test("tool groups never span invocation boundaries", () => {
  const first = { id: "a1", type: "runtime.event", timestamp: "2026-01-01T00:00:00Z", data: { traceId: "trace-1", presentation: "tool", toolName: "Bash", toolUseId: "u1" } };
  const second = { id: "b1", type: "runtime.event", timestamp: "2026-01-01T00:01:00Z", data: { traceId: "trace-2", presentation: "tool", toolName: "Bash", toolUseId: "u2" } };
  const split = buildConsoleEntries([first, second]);
  assert.deepEqual(split.map((entry) => entry.type), ["tool", "tool"], "same-name tools from different invocations stay separate");
  // Consecutive same-name tools within one invocation still group.
  const third = { id: "c1", type: "runtime.event", timestamp: "2026-01-01T00:02:00Z", data: { traceId: "trace-1", presentation: "tool", toolName: "Bash", toolUseId: "u3" } };
  const merged = buildConsoleEntries([first, third]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, "tool-group");
  assert.equal(merged[0].tools.length, 2);
});

test("shared client task projections keep human action and failure separate from completion", () => {
  assert.deepEqual(TASK_FILTERS.map((filter) => filter.id), ["all", "attention", "active", "backlog", "done", "cancelled"]);
  for (const status of ["awaiting_human", "awaiting_acceptance", "paused", "blocked", "failed"]) assert.equal(taskNeedsAttention(status), true);
  assert.equal(taskNeedsAttention("done"), false);
  assert.equal(taskMatchesFilter("awaiting_acceptance", "attention"), true);
  assert.equal(taskMatchesFilter("running", "active"), true);
  assert.equal(taskMatchesFilter("failed", "done"), false);
  assert.equal(taskMatchesFilter("done", "done"), true);
  assert.equal(taskMatchesFilter("cancelled", "cancelled"), true);
  assert.equal(taskActionLabel("awaiting_acceptance"), "去验收");
  assert.equal(taskActionLabel("failed"), "查看恢复选项");
});

test("shared client projections pair tool records without changing authoritative events", () => {
  const toolUse = { id: "event-use", type: "runtime.event", timestamp: "2026-09-19T00:00:00.000Z", data: { presentation: "tool", toolUseId: "use-1", toolName: "Read" } };
  const toolResult = { id: "event-result", type: "runtime.event", timestamp: "2026-09-19T00:00:01.000Z", data: { presentation: "tool_result", toolResultId: "use-1", toolName: "Read" } };
  const secondTool = { id: "event-use-2", type: "runtime.event", timestamp: "2026-09-19T00:00:02.000Z", data: { presentation: "tool", toolUseId: "use-2", toolName: "Read" } };
  const entries = buildConsoleEntries([toolUse, toolResult, secondTool]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "tool-group");
  assert.equal(entries[0].tools[0].event, toolUse);
  assert.equal(entries[0].tools[0].result, toolResult);
  assert.equal(entries[0].tools[1].event, secondTool);
  assert.equal(toolUse.data.toolUseId, "use-1");
  assert.equal(isTransportFrame({ type: "runtime.event", data: { providerEventType: "stream_event" } }), true);
  assert.equal(displayText({ actor: { name: "分析师" }, message: "分析师 · assistant: 保留正文" }), "保留正文");
});

test("shared client projections tolerate incomplete workspace read models", () => {
  const manager = { id: "manager", name: "经理", type: "agent" };
  const analyst = { id: "analyst", name: "分析师", role: "分析" };
  const workspace = {
    run: {
      manager,
      task: { nodeAssignments: { requirements: "analyst" }, workflowSnapshot: { nodes: [{ id: "requirements", title: "需求" }] } },
      currentFocus: { nodeId: "requirements" }
    },
    traces: [{ workflowNodeId: "requirements", agentId: "analyst", status: "running", agent: analyst }],
    defects: [{ status: "open", affectedNodeIds: ["requirements"] }],
    messages: [], dispatches: [], events: []
  };
  assert.deepEqual(workspaceAgents(workspace, [analyst]).map((agent) => agent.id), ["manager", "analyst"]);
  assert.deepEqual(workflowFocus(workspace.run, workspace.traces, workspace.defects), { requirements: "attention" });
  assert.deepEqual(mentionables([analyst, analyst]), [{ id: "analyst", name: "分析师", color: undefined }]);
  assert.deepEqual(collaborationRecords({}), []);
});

test("shared client role status lets a terminal Run override a stale active Trace", () => {
  const trace = { id: "trace-1", agentId: "analyst", workflowNodeId: "requirements", status: "running" };
  const active = roleExecutionStatus({ status: "running" }, [trace], "analyst");
  assert.equal(active.active, true);
  assert.equal(active.activeTrace, trace);
  assert.equal(active.label, "● 执行中 · requirements");

  const cancelled = roleExecutionStatus({ status: "cancelled" }, [trace], "analyst");
  assert.deepEqual(cancelled, { active: false, activeTrace: null, traceCount: 1, label: "○ 已终止 · 1 条 Trace" });
  assert.equal(roleExecutionStatus({ status: "failed" }, [trace], "analyst").label, "○ 失败 · 1 条 Trace");
  assert.equal(roleExecutionStatus({ status: "completed" }, [trace], "analyst").label, "○ 已完成 · 1 条 Trace");
});

test("collaboration shows messages without retry audit events", () => {
  const records = collaborationRecords({ events: [{ id: "retry-now", type: "dispatch.retry_requested", timestamp: "2026-09-21T00:00:00.000Z", actor: { name: "本机用户" }, message: "人类请求立即重试 1 个等待退避的调用；失败 Trace 与原投递已保留。", data: { dispatchIds: ["dispatch-1"] } }] });
  assert.deepEqual(records, []);
});

test("collaboration excludes Run termination audit events", () => {
  const records = collaborationRecords({ events: [{ id: "run-cancelled", type: "run.cancelled", timestamp: "2026-10-04T00:00:00.000Z", actor: { type: "human", name: "本机用户" }, message: "人类已终止 Run；未完成协作投递已取消，既有 Trace 与交付记录保留。", data: { reason: "用户终止", cancelledDispatchIds: ["dispatch-1"] } }] });
  assert.deepEqual(records, []);
});

test("shared Console projections remain behind authenticated HTTP", async () => {
  const [server, web] = await Promise.all([
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8")
  ]);
  assert.match(web, /taskMatchesSearch\(task, state\.taskSearch\)/);
  assert.match(web, /taskActionLabel\(current\.status\)/);
  assert.match(web, /roleExecutionStatus\(run, traces, agent\.id\)/);
  assert.match(server, /const clientRoot = join\(root, "client"\)/);
  assert.match(server, /const clientModule = pathname\.startsWith\("\/client\/"\)/);
  assert.match(server, /if \(clientModule\) \{\n\s+sendJson\(response, 404, \{ error: "not_found" \}\)/);
  assert.ok(server.indexOf("auth.guard") < server.indexOf("await serveStatic"));

});

test("collaboration excludes platform escalation audit and system notes", () => {
  const records = collaborationRecords({ events: [{ id: "escalated", type: "dispatch.escalated", timestamp: "2026-10-24T00:00:00.000Z", actor: { type: "system", name: "AgentForge" }, message: "相同协议/结果校验错误连续 2 次，自动重试停止并升级项目经理处置。", data: { dispatchId: "dispatch-1", failureKind: "protocol", attempts: 2, errorStreak: 2 } }] });
  assert.deepEqual(records, []);
  const note = collaborationRecords({ messages: [{ id: "message-1", kind: "escalation", createdAt: "2026-10-24T00:00:01.000Z", sender: { type: "system", id: "agentforge", name: "AgentForge" }, recipient: { type: "agent", id: "manager-1", name: "项目经理" }, content: "自动升级：投递 dispatch-1 连续失败" }] });
  assert.deepEqual(note, []);
});

test("collaboration keeps manager messages shared with members but excludes human broadcasts", () => {
  const records = collaborationRecords({ messages: [
    { id: "manager", kind: "manager_decision", createdAt: "2026-10-24T00:00:00Z", sender: { type: "agent", name: "经理" }, recipient: { type: "team", name: "团队" }, content: "请研发修复" },
    { id: "human", kind: "instruction", createdAt: "2026-10-24T00:00:01Z", sender: { type: "human", name: "你" }, recipient: { type: "team", name: "团队" }, content: "旧全员消息" },
  ] });
  assert.deepEqual(records.map((item) => item.id), ["manager"]);
  assert.equal(records[0].tone, "violet");
  assert.equal(records[0].statusCode, "recorded");
});

test("collaboration colors reflect recorded pending/answered status, not business approval", () => {
  const question = { id: "q", kind: "clarification_question", createdAt: "2026-01-01", sender: { type: "agent", name: "A" }, recipient: { type: "human", name: "你" }, content: "需确认" };
  const dispatches = [{ waitingMessageId: "q", status: "waiting" }];
  const [waiting] = collaborationRecords({ messages: [question], dispatches });
  assert.equal(waiting.tone, "warning"); assert.equal(waiting.statusCode, "waiting"); assert.equal(waiting.canReply, true);
  const answer = { id: "a", kind: "clarification_answer", createdAt: "2026-01-02", replyToMessageId: "q", sender: { type: "human", name: "你" }, recipient: { type: "agent", name: "A" }, content: "已确认范围" };
  const records = collaborationRecords({ messages: [question, answer], dispatches });
  assert.equal(records[0].statusCode, "answered"); assert.equal(records[1].tone, "info");
});
