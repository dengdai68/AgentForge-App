import test from "node:test";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { createFixtureStore as createStore, fixtureTaskInput } from "./fixture-store.mjs";
import { createRunFiles } from "../server/run-files.mjs";
import { createSqlitePersistence } from "../server/persistence.mjs";
import { executeRun, readNodeResult, parseEmployeeResponse, terminateRun } from "../server/orchestrator.mjs";
import { runClaudeCodeCli, RuntimeSessionMissingError } from "../server/runtime/local-cli.mjs";
import { collaborationRecords, mentionables } from "../client/console-projections.mjs";

async function directory(prefix) { const path = await mkdtemp(join(tmpdir(), prefix)); await mkdir(join(path, "repos", "app", ".git"), { recursive: true }); return path; }

test('workflow delivery locations are arbitrary workspace-relative paths, survive restart and have no docs default',async()=>{
  const root=await mkdtemp(join(tmpdir(),'af-workflow-paths-')),databasePath=join(root,'state.sqlite');
  try{
    let store=createStore({databasePath});
    const base={name:'媒体与根文件',nodes:[{id:'media',title:'制作',staffingGuidance:'媒体制作',artifactPaths:['artifacts/preparation/','reports/质检/','summary.md']},{id:'free',title:'自由组织',staffingGuidance:'根据交付要求组织文件'}]};
    const flow=store.createWorkflowTemplate(base);assert.deepEqual(flow.nodes[0].artifactPaths,base.nodes[0].artifactPaths);assert.deepEqual(flow.nodes[1].artifactPaths,[]);
    for(const path of ['../escape','/absolute','a/../b','a//b','.','./a','.git/config','.agentforge/private','a\\b'])assert.throws(()=>store.createWorkflowTemplate({...base,name:'invalid-'+path,nodes:[{...base.nodes[0],artifactPaths:[path]}]}));
    store.close();store=createStore({databasePath});assert.deepEqual(store.snapshot().workflowTemplates.find(item=>item.id===flow.id).nodes.map(node=>node.artifactPaths),[base.nodes[0].artifactPaths,[]]);store.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test("incremental SQLite migrates legacy events and preserves rollback, deletion and restart", async () => {
  const root = await directory("af-incremental-"), path = join(root, "state.sqlite");
  let persistence, database;
  try {
    database = new DatabaseSync(path);
    database.exec("CREATE TABLE workspace_snapshots(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL,updated_at TEXT NOT NULL)");
    const state = { tasks: [{ id: "t", title: "old" }], events: [{ id: "e1", content: "history" }], communicationEvents: [] };
    database.prepare("INSERT INTO workspace_snapshots VALUES(1,?,?)").run(JSON.stringify(state), "old");
    persistence = createSqlitePersistence(path);
    assert.deepEqual(persistence.load(), state); persistence.save(state);
    assert.equal(JSON.parse(database.prepare("SELECT state_json FROM workspace_snapshots").get().state_json).events, undefined);
    database.exec("CREATE TABLE event_writes(count INTEGER); INSERT INTO event_writes VALUES(0); CREATE TRIGGER count_event_update AFTER UPDATE ON workspace_event_rows BEGIN UPDATE event_writes SET count=count+1; END;");
    state.tasks[0].title = "new"; persistence.save(state);
    assert.equal(database.prepare("SELECT count FROM event_writes").get().count, 0);
    state.events.push({ id: "e2", content: "new event" });
    database.exec("CREATE TRIGGER fail_snapshot BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => persistence.save(state), /test rollback/);
    assert.equal(persistence.load().events.length, 1);
    database.exec("DROP TRIGGER fail_snapshot"); persistence.save(state);
    state.events = [state.events[1]]; state.communicationEvents.push({ id: "c1", content: "chat" });
    persistence.save(state); persistence.close(); persistence = createSqlitePersistence(path);
    assert.deepEqual(persistence.load(), state); persistence.save(state); assert.deepEqual(persistence.load(), state);
  } finally { persistence?.close(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite restart skips unchanged event writes and persists startup migration atomically", async () => {
  const root = await directory("af-restart-writes-"), path = join(root, "state.sqlite");
  let persistence, database;
  try {
    persistence = createSqlitePersistence(path);
    const initial = { tasks: [], events: [{ id: "e1", content: "old" }, { id: "e2", content: "keep" }], communicationEvents: [{ id: "c1", content: "chat" }] };
    persistence.save(initial); persistence.close();
    database = new DatabaseSync(path);
    database.exec(`CREATE TABLE writes(kind TEXT);
      CREATE TRIGGER track_insert AFTER INSERT ON workspace_event_rows BEGIN INSERT INTO writes VALUES('insert'); END;
      CREATE TRIGGER track_update AFTER UPDATE ON workspace_event_rows BEGIN INSERT INTO writes VALUES('update'); END;
      CREATE TRIGGER track_delete AFTER DELETE ON workspace_event_rows BEGIN INSERT INTO writes VALUES('delete'); END;`);
    persistence = createSqlitePersistence(path);
    const loaded = persistence.load(); persistence.save(loaded);
    assert.deepEqual(persistence.load(), initial);
    assert.equal(database.prepare("SELECT count(*) AS n FROM writes").get().n, 0);

    // Real startup migration can modify a loaded event in place.
    const migrated = persistence.load(); migrated.events[0].content = "migrated";
    migrated.tasks.push({ id: "t" }); migrated.communicationEvents.push({ id: "c2", content: "new" });
    database.exec("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT,'restart rollback'); END");
    assert.throws(() => persistence.save(migrated), /restart rollback/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM writes").get().n, 0);
    assert.equal(JSON.parse(database.prepare("SELECT value_json FROM workspace_event_rows WHERE id='e1'").get().value_json).content, "old");
    database.exec("DROP TRIGGER reject_snapshot");
    // Retry without load: a failed transaction must not advance the baseline.
    persistence.save(migrated);
    assert.deepEqual(database.prepare("SELECT kind FROM writes ORDER BY rowid").all().map(row => row.kind).sort(), ["insert", "update"]);
    assert.deepEqual(persistence.load(), migrated);
    database.exec("DELETE FROM writes");
    migrated.events = [migrated.events[1]]; persistence.save(migrated);
    assert.deepEqual(database.prepare("SELECT kind FROM writes ORDER BY rowid").all().map(row => row.kind).sort(), ["delete", "update"]);
    persistence.close(); persistence = createSqlitePersistence(path);
    assert.deepEqual(persistence.load(), migrated);
    database.exec("DELETE FROM writes"); persistence.save(persistence.load());
    assert.equal(database.prepare("SELECT count(*) AS n FROM writes").get().n, 0);
    // Saving without loading remains a complete replacement, not an append.
    persistence.close(); persistence = createSqlitePersistence(path);
    const replacement = { tasks: [], events: [{ id: "fresh", content: "replacement" }] };
    persistence.save(replacement);
    assert.deepEqual(persistence.load(), replacement);
    assert.deepEqual(database.prepare("SELECT id FROM workspace_event_rows").all().map(row => row.id), ["fresh"]);
  } finally { persistence?.close(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite save diagnostics preserve incremental counts and committed visibility", async () => {
  const root = await directory("af-save-diagnostic-"), path = join(root, "state.sqlite"), records = [], visible = [];
  let persistence, database;
  try {
    persistence = createSqlitePersistence(path, { onSaveDiagnostic(record) {
      records.push(record);
      visible.push(database.prepare("SELECT id FROM workspace_event_rows ORDER BY position").all().map(row => row.id));
      throw new Error("observer failure must not undo commit");
    } });
    database = new DatabaseSync(path);
    const state = { tasks: [{ id: "private-marker", content: "SENSITIVE_DIAGNOSTIC_SENTINEL" }], events: [{ id: "e1" }, { id: "e2" }], communicationEvents: [] };
    persistence.save(state);
    assert.deepEqual(visible.at(-1), ["e1", "e2"]);
    const phase = (record, name) => record.phases.find(item => item.phase === name);
    assert.deepEqual(records[0].phases.map(item => item.phase), ["diff", "serialize", "begin", "reconcile", "delete", "upsert_events", "upsert_snapshot", "commit"]);
    assert.equal(phase(records[0], "diff").count, 2);
    assert.equal(phase(records[0], "reconcile").count, 3);
    assert.equal(phase(records[0], "upsert_events").count, 2);
    persistence.save(state);
    assert.equal(phase(records.at(-1), "upsert_events").count, 0);
    state.events = [{ id: "e2" }, { id: "e3" }];
    persistence.save(state);
    assert.deepEqual(visible.at(-1), ["e2", "e3"]);
    assert.equal(phase(records.at(-1), "delete").count, 1);
    assert.equal(phase(records.at(-1), "upsert_events").count, 2);
    assert.deepEqual(persistence.load(), state);
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), ["elapsedMs", "operation", "outcome", "phases", "transactionOutcome"]);
      assert.equal(record.operation, "save"); assert.equal(record.outcome, "success"); assert.equal(record.transactionOutcome, "committed");
      assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
      for (const item of record.phases) {
        assert.deepEqual(Object.keys(item).sort(), ["count", "elapsedMs", "outcome", "phase"]);
        assert.ok(Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0);
        assert.ok(Number.isSafeInteger(item.count) && item.count >= 0);
        assert.equal(item.outcome, "success");
      }
      assert.equal(phase(record, "serialize").count, 1);
      assert.equal(phase(record, "commit").count, 1);
      assert.doesNotMatch(JSON.stringify(record), /SENSITIVE_DIAGNOSTIC_SENTINEL|private-marker|state\.sqlite|SELECT/);
    }
    persistence.close(); persistence = createSqlitePersistence(path);
    assert.deepEqual(persistence.load(), state);
  } finally { persistence?.close(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("SQLite save diagnostics preserve original failures and real rollback boundaries", async () => {
  const root = await directory("af-save-failure-"), path = join(root, "state.sqlite"), records = [], visible = [], ended = [];
  let persistence, database;
  try {
    persistence = createSqlitePersistence(path, { onSaveDiagnostic(record) {
      records.push(record);
      visible.push(database.prepare("SELECT value_json FROM workspace_event_rows ORDER BY id").all().map(row => JSON.parse(row.value_json).id));
      if (record.transactionOutcome !== "not_started") {
        database.exec("BEGIN IMMEDIATE"); database.exec("ROLLBACK"); ended.push(record);
      }
      throw new Error("observer must not replace original error");
    } });
    database = new DatabaseSync(path);
    const initial = { tasks: [], events: [{ id: "e1" }] };
    persistence.save(initial);
    const original = new Error("SENSITIVE_SERIALIZATION_SENTINEL");
    assert.throws(() => persistence.save({ tasks: [{ toJSON() { throw original; } }], events: initial.events }), error => error === original);
    assert.equal(records.at(-1).transactionOutcome, "not_started");
    assert.deepEqual(records.at(-1).phases.map(p => [p.phase, p.outcome]), [["diff", "success"], ["serialize", "error"]]);
    assert.equal(records.at(-1).phases.at(-1).count, 0);
    database.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => persistence.save(initial), /locked/); }
    finally { database.exec("ROLLBACK"); }
    assert.equal(records.at(-1).transactionOutcome, "not_started");
    assert.equal(records.at(-1).phases.at(-1).phase, "begin");
    assert.equal(records.at(-1).phases.at(-1).count, 0);
    const changed = { tasks: [], events: [{ id: "e1" }, { id: "e2" }] };
    for (const [action, transactionOutcome] of [["ABORT", "rolled_back"], ["ROLLBACK", "rollback_failed"]]) {
      database.exec(`CREATE TRIGGER reject_diagnostic_snapshot BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(${action},'SENSITIVE_SQL_SENTINEL'); END`);
      assert.throws(() => persistence.save(changed), error => error.message === "SENSITIVE_SQL_SENTINEL");
      const record = records.at(-1);
      assert.equal(record.outcome, "error"); assert.equal(record.transactionOutcome, transactionOutcome);
      assert.equal(record.phases.find(p => p.phase === "upsert_events").count, 1);
      assert.equal(record.phases.find(p => p.phase === "upsert_snapshot").outcome, "error");
      assert.equal(record.phases.at(-1).phase, "rollback");
      assert.equal(record.phases.at(-1).count, action === "ABORT" ? 1 : 0);
      assert.equal(record.phases.at(-1).outcome, action === "ABORT" ? "success" : "error");
      assert.deepEqual(visible.at(-1), ["e1"]);
      assert.equal(ended.at(-1), record);
      assert.deepEqual(persistence.load(), initial);
      database.exec("DROP TRIGGER reject_diagnostic_snapshot");
    }
    persistence.save(changed);
    assert.deepEqual(visible.at(-1), ["e1", "e2"]);
    assert.deepEqual(persistence.load(), changed);
    assert.doesNotMatch(JSON.stringify(records), /SENSITIVE_|observer|state\.sqlite|RAISE/);
  } finally { persistence?.close(); database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Store save diagnostic callback failure cannot revert committed domain state", async () => {
  const root = await directory("af-store-diagnostic-"), path = join(root, "state.sqlite"), records = [];
  let database;
  try {
    const store = createStore({ databasePath: path, workspaceRoot: join(root, "work"), onSaveDiagnostic(record) { records.push(record); throw new Error("diagnostic sink unavailable"); } });
    const run = store.createRun(fixtureTaskInput(store).id);
    database = new DatabaseSync(path, { readOnly: true });
    const disk = JSON.parse(database.prepare("SELECT state_json FROM workspace_snapshots").get().state_json);
    assert.deepEqual(disk.runs, store.snapshot().runs);
    assert.equal(disk.runs.some(item => item.id === run.id), true);
    assert.ok(records.length >= 2);
    assert.ok(records.every(record => record.outcome === "success" && record.transactionOutcome === "committed"));
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP save diagnostic injection logs errors and inclusive slow saves without extra context", async () => {
  const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const storeOptions ="), end = source.indexOf("\nconst { version }", start);
  assert.ok(start >= 0 && end > start);
  let options;
  const calls = [];
  const databasePath = "PRIVATE_DATABASE_SENTINEL", workspaceRoot = "PRIVATE_WORKSPACE_SENTINEL";
  const evaluate = new Function("createStore", "databasePath", "workspaceRoot", "diagnostic", `${source.slice(start, end)}; return store;`);
  const sentinelStore = {};
  assert.equal(evaluate(input => { options = input; return sentinelStore; }, databasePath, workspaceRoot, (...args) => calls.push(args)), sentinelStore);
  assert.equal(options.databasePath, databasePath); assert.equal(options.workspaceRoot, workspaceRoot);
  const record = (outcome, elapsedMs) => ({ operation: "save", outcome, elapsedMs, transactionOutcome: outcome === "success" ? "committed" : "not_started", phases: [] });
  const fast = record("success", 249.999), boundary = record("success", 250), slow = record("success", 251), failure = record("error", 0);
  options.onSaveDiagnostic(fast);
  assert.deepEqual(calls, []);
  for (const value of [boundary, slow, failure]) options.onSaveDiagnostic(value);
  assert.deepEqual(calls, [["persistence.save", boundary], ["persistence.save", slow], ["persistence.save", failure]]);
  assert.equal(calls[0][1], boundary); assert.equal(calls[2][1], failure);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_DATABASE_SENTINEL|PRIVATE_WORKSPACE_SENTINEL/);
});

test("legacy trace acceptance wording remains immutable across Store restart", async () => {
  const root = await directory("af-legacy-acceptance-copy-"), path = join(root, "state.sqlite");
  try {
    const first = createStore({ databasePath: path }), run = first.createRun(first.listTasks()[0].id);
    const event = first.addEvent({ type: "trace.accepted", runId: run.id, message: "交付已验收；接手方仍须按自身目标评估输入。", data: { traceId: "legacy_trace", workflowNodeId: "requirements", artifactCount: 1 } });
    const before = first.getRunWorkspace(run.id).events.find(item => item.id === event.id);
    const reopened = createStore({ databasePath: path });
    assert.deepEqual(reopened.getRunWorkspace(run.id).events.find(item => item.id === event.id), before);
    assert.equal(before.message, "交付已验收；接手方仍须按自身目标评估输入。");
    assert.notEqual(reopened.getRun(run.id).status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP JSON reader bounds oversized bodies while accepting normal input", async () => {
  const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const maxJsonBodyBytes"), end = source.indexOf("\n\nasync function routeApi", start);
  const { maxJsonBodyBytes, RequestBodyTooLargeError, readJson } = new Function(`${source.slice(start, end)}; return { maxJsonBodyBytes, RequestBodyTooLargeError, readJson };`)();
  const request = (chunks) => ({ async *[Symbol.asyncIterator]() { yield* chunks; } });
  assert.deepEqual(await readJson(request(['{"title":"small request"}'])), { title: "small request" });
  await assert.rejects(readJson(request([JSON.stringify({ payload: "x".repeat(maxJsonBodyBytes) })])), (error) => error instanceof RequestBodyTooLargeError && /1 MiB/.test(error.message));
  assert.match(source, /error instanceof RequestBodyTooLargeError \? 413 : 400/);
});

test("Task deletion lock rejects duplicate deletion while always releasing the Task", async () => {
  const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function withTaskDeletionLock"), end = source.indexOf("\n\nasync function routeApi", start);
  const { withTaskDeletionLock } = new Function(`${source.slice(start, end)}; return { withTaskDeletionLock };`)();
  const locks = new Set();
  let release;
  const first = withTaskDeletionLock(locks, "task_same", () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(withTaskDeletionLock(locks, "task_same", async () => true), /正在删除/);
  release("first");
  assert.equal(await first, "first");
  assert.equal(locks.has("task_same"), false);
  await assert.rejects(withTaskDeletionLock(locks, "task_same", async () => { throw new Error("Store rejected deletion"); }), /Store rejected deletion/);
  assert.equal(locks.has("task_same"), false);
});

test("Artifact read errors stay actionable without exposing Run file paths", async () => {
  const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function artifactReadError"), end = source.indexOf("\n\nfunction sendJson", start);
  const { artifactReadError, readArtifactSafely } = new Function(`${source.slice(start, end)}; return { artifactReadError, readArtifactSafely };`)();
  const missing = artifactReadError(new Error("ENOENT: no such file or directory, lstat '/tmp/agentforge-runs/runs/run/traces/trace/missing.md'"));
  assert.equal(missing.message, "Artifact 文件不可读取或已不存在");
  assert.doesNotMatch(missing.message, /ENOENT|\/tmp|run\//);
  assert.equal(artifactReadError(new Error("产物大于 524288 字节，请在本地文件系统中查看")).message, "产物大于 524288 字节，请在本地文件系统中查看");
  assert.equal(artifactReadError(new Error("Artifact 快照完整性校验失败")).message, "Artifact 快照完整性校验失败");
  await assert.rejects(readArtifactSafely(async () => { throw new Error("EACCES: permission denied, open '/private/run-file'"); }), /Artifact 文件不可读取或已不存在/);
  assert.match(source, /readArtifactSafely\(\(\) => runFiles\.readArtifact\(artifact\.storagePath, \{ expected: artifact \}\)\)/);
  assert.match(source, /readArtifactSafely\(\(\) => runFiles\.readArtifactBytes\(artifact\.storagePath, \{ expected: artifact \}\)\)/);
  assert.match(source, /if \(!rasterImageType\(artifact\.mediaType\)\) throw new Error\("raw 预览仅支持 PNG、JPEG、GIF 和 WebP 图片"\)/);
});

test("page summaries omit history and role console cursors preserve paginated audit boundaries", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  for (let n = 0; n < 215; n++) store.addEvent({ type: "runtime.event", runId: run.id, actor: { id: "agent_analyst", type: "agent", name: "分析师" }, message: `LEGACY_RUNTIME_SENTINEL ${n} ${"x".repeat(2048)}`, data: { traceId: trace.id, raw: "LEGACY_RUNTIME_DATA_SENTINEL" } });
  store.addEvent({ type: "runtime.event", runId: run.id, actor: { id: run.manager.id, type: "agent", name: "经理" }, message: "别的角色", data: {} });
  const bootstrap = store.getBootstrap();
  assert.equal(bootstrap.events.length, 6);
  for (const field of ["traces", "messages", "artifacts", "dispatches", "decisions", "defects"]) assert.equal(field in bootstrap, false);
  assert.ok(JSON.stringify(bootstrap).length < 60000);
  assert.equal(bootstrap.runs[0].traceCount, 1);
  assert.equal(bootstrap.tasks[0].workflowSnapshot.nodes, undefined);
  assert.equal("workspacePath" in bootstrap.tasks[0], false);
  assert.equal(bootstrap.tasks[0].workspaceKind, "legacy");
  const summary = store.getRunWorkspace(run.id, { summary: true });
  assert.equal(summary.events.some((event) => event.type === "runtime.event"), false);
  assert.ok(store.getRunWorkspace(run.id).events.some((event) => event.type === "runtime.event"));
  const first = store.getConsoleEvents(run.id, { agentId: "agent_analyst", traceId: trace.id });
  assert.equal(first.events.length, 200); assert.equal(first.hasMore, true);
  assert.equal(first.events[0].message, "历史运行记录已按当前审计边界隐藏原始内容。");
  assert.doesNotMatch(JSON.stringify(first), /LEGACY_RUNTIME_(?:SENTINEL|DATA_SENTINEL)/);
  const second = store.getConsoleEvents(run.id, { agentId: "agent_analyst", traceId: trace.id, before: first.nextBefore });
  assert.equal(second.events.length, 15); assert.equal(second.hasMore, false);
  assert.equal(new Set([...second.events, ...first.events].map((event) => event.id)).size, 215);
  store.addEvent({ type: "runtime.event", runId: run.id, actor: { id: "agent_analyst" }, message: "实时新事件", data: { traceId: trace.id } });
  assert.deepEqual(store.getConsoleEvents(run.id, { agentId: "agent_analyst", traceId: trace.id, before: first.nextBefore }).events, second.events);
  const legacyFailure = store.addEvent({ type: "trace.failed", runId: run.id, actor: { id: "agent_analyst", type: "agent", name: "分析师" }, message: "LEGACY_TRACE_FAILURE_SENTINEL", data: { traceId: trace.id, error: "LEGACY_TRACE_DATA_SENTINEL" } });
  const currentAudit = store.addEvent({ type: "runtime.event", runId: run.id, actor: { id: "agent_analyst", type: "agent", name: "分析师" }, message: "已请求本机工具", data: { auditVersion: 2, traceId: trace.id, toolName: "Read", status: "running" } });
  const all = store.getConsoleEvents(run.id, { agentId: "agent_analyst", traceId: trace.id, limit: 500 });
  const projectedFailure = all.events.find((event) => event.id === legacyFailure.id);
  assert.deepEqual(projectedFailure.data, { auditVersion: 1, traceId: trace.id });
  assert.equal(projectedFailure.message, "历史 Trace 失败原因已按当前审计边界隐藏原始内容。");
  assert.deepEqual(all.events.find((event) => event.id === currentAudit.id), currentAudit);
  assert.doesNotMatch(JSON.stringify(all), /LEGACY_(?:RUNTIME_(?:SENTINEL|DATA_SENTINEL)|TRACE_(?:FAILURE_SENTINEL|DATA_SENTINEL))/);
  assert.throws(() => store.getConsoleEvents(run.id, { agentId: "intruder" }), /成员/);
  assert.throws(() => store.getConsoleEvents(run.id, { agentId: "agent_analyst", before: "wrong" }), /游标/);
  assert.throws(() => store.getConsoleEvents(run.id, { agentId: run.manager.id, traceId: trace.id }), /Trace/);
  assert.throws(() => store.getConsoleEvents(run.id, { agentId: "agent_analyst", limit: 501 }), /页大小/);
  const empty = store.getConsoleEvents(run.id, { agentId: "agent_engineer" });
  assert.equal(empty.events.length, 0);
});

test("system workspace root assigns isolated Task/Run paths and survives configuration changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-managed-"));
  try {
    const db = join(root, "meta.sqlite"), store = createStore({ databasePath: db, workspaceRoot: join(root, "work") });
    const seed = fixtureTaskInput(store), input = { ...seed }; delete input.workspacePath;
    assert.throws(() => store.createTask({ ...input, workspacePath: root }), /系统自动分配/);
    assert.throws(() => store.createTask({ ...input, repositorySources: [{ path: "repos/app", url: "https://token@example.com/repo.git" }] }), /数字员工/);
    const a = store.createTask(input), b = store.createTask(input), run = store.createRun(a.id);
    assert.equal(a.workspacePath, join(root, "work", a.id)); assert.notEqual(a.workspacePath, b.workspacePath);
    assert.equal(run.workspacePath, join(a.workspacePath, run.id));
    assert.equal(store.getRunWorkspace(run.id).run.task.workspacePath, run.workspacePath);
    const taskSummary = store.getBootstrap().tasks.find((task) => task.id === a.id);
    assert.equal(taskSummary.workspaceKind, "managed");
    assert.equal("workspacePath" in taskSummary, false);
    assert.equal(JSON.stringify(taskSummary).includes(root), false);
    const files = createRunFiles({ root: join(root, "audit") });
    await files.prepareTaskWorkspace(a); await files.prepareRunWorkspace(store.getRunTask(run.id));
    await files.prepareRunWorkspace(store.getRunTask(run.id));
    assert.deepEqual(a.repositorySources, []); // No typed developer: no implicit empty repository.
    assert.deepEqual(a.workflowSnapshot.nodes.map(node => node.repositoryPath), a.workflowSnapshot.nodes.map(() => null));
    const reopened = createStore({ databasePath: db, workspaceRoot: join(root, "new-root") });
    assert.equal(reopened.getRunTask(run.id).workspacePath, run.workspacePath);
    const future = reopened.createTask(input); assert.equal(future.workspacePath, join(root, "new-root", future.id));
    const second = reopened.createRun(b.id); assert.equal(second.workspacePath, join(b.workspacePath, second.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bootstrap Task lists use workspace labels instead of host paths", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const listViews = source.slice(source.indexOf("function renderOverview()"), source.indexOf("/* ---------- 团队 ---------- */"));
  assert.match(source, /const workspaceSummary = \(task = \{\}\)/);
  assert.match(listViews, /workspaceSummary\(task\)/);
  assert.doesNotMatch(listViews, /task\.workspacePath/);
  assert.doesNotMatch(source.slice(source.indexOf("function renderTasks()"), source.indexOf("/* ---------- 团队 ---------- */")), /col-path|col-workflow/);
});

test("Task freezes explicit acceptance criteria, rejects malformed input, and migrates legacy scalars", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-acceptance-"));
  let database;
  try {
    const db = join(root, "state.sqlite"), store = createStore({ databasePath: db }), base = fixtureTaskInput(store);
    const criteria = ["登录页可由键盘完成操作", "新增路径具备可重复测试证据"];
    const task = store.createTask({ ...base, title: "显式验收标准", acceptanceCriteria: criteria });
    criteria[0] = "调用方后续修改不应影响 Task";
    assert.deepEqual(task.acceptanceCriteria, ["登录页可由键盘完成操作", "新增路径具备可重复测试证据"]);
    assert.deepEqual(store.createTask({ ...base, title: "基础验收标准", acceptanceCriteria: [] }).acceptanceCriteria, []);
    assert.throws(() => store.createTask({ ...base, title: "错误验收标准类型", acceptanceCriteria: "只有一条字符串" }), /字符串数组/);
    assert.throws(() => store.createTask({ ...base, title: "空验收标准", acceptanceCriteria: [""] }), /第 1 条任务验收标准不能为空/);
    assert.throws(() => store.createTask({ ...base, title: "过多验收标准", acceptanceCriteria: Array.from({ length: 21 }, () => "可验证" ) }), /最多 20 条/);
    assert.throws(() => store.createTask({ ...base, title: "过长验收标准", acceptanceCriteria: ["x".repeat(501)] }), /不能超过 500 字符/);

    database = new DatabaseSync(db);
    const snapshot = JSON.parse(database.prepare("SELECT state_json FROM workspace_snapshots WHERE id = 1").get().state_json);
    snapshot.tasks.find((item) => item.id === base.id).acceptanceCriteria = "历史任务的单条验收标准";
    database.prepare("UPDATE workspace_snapshots SET state_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(snapshot), new Date().toISOString());
    database.close(); database = null;
    const reopened = createStore({ databasePath: db });
    assert.deepEqual(reopened.getTask(base.id).acceptanceCriteria, ["历史任务的单条验收标准"]);
  } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("content delivery workflow freezes boundaries and never resurrects deleted templates", async () => {
  const store = createStore(), template = store.listWorkflowTemplates().find((item) => item.id === "content_delivery");
  assert.ok(template);
  assert.equal(template.name, "内容交付"); assert.equal(template.system, true);
  assert.ok(template.nodes.every(item => item.staffingGuidance && !Object.hasOwn(item, "ownerRole")));
  assert.deepEqual(template.nodes.map(({ id, title, dependsOn, artifactPaths }) => ({ id, title, dependsOn, artifactPaths })), [
    { id: "content_brief", title: "内容简报与验收标准", dependsOn: [], artifactPaths: ["docs/content-brief/"] },
    { id: "content_creation", title: "内容创作与编辑", dependsOn: ["content_brief"], artifactPaths: ["docs/content/"] },
    { id: "content_review", title: "内容审校与质量核查", dependsOn: ["content_creation"], artifactPaths: ["docs/content-review/"] }
  ]);
  const task = store.createTask({ title: "交付试用邀请文案", objective: "形成可审校的本地邮件文案。", workspacePath: process.cwd(), teamId: "team_product_delivery", workflowTemplateId: template.id });
  assert.deepEqual(task.nodeAssignments, {});
  assert.ok(task.workflowSnapshot.nodes.every((node) => node.staffingGuidance));
  assert.deepEqual(task.workflowSnapshot.nodes.map(({ id, artifactPaths, repositoryPath }) => ({ id, artifactPaths, repositoryPath })), [
    { id: "content_brief", artifactPaths: ["docs/content-brief/"], repositoryPath: null },
    { id: "content_creation", artifactPaths: ["docs/content/"], repositoryPath: null },
    { id: "content_review", artifactPaths: ["docs/content-review/"], repositoryPath: null }
  ]);
  const incompleteTeam = store.createTeam({ name: "缺少审校角色的内容团队", memberAgentIds: ["agent_analyst", "agent_designer"] });
  const flexibleTask = store.createTask({ title: "按能力安排审校", objective: "项目经理从现有成员中选择合适的人。", workspacePath: process.cwd(), teamId: incompleteTeam.id, workflowTemplateId: template.id });
  assert.deepEqual(flexibleTask.nodeAssignments, {});

  const root = await mkdtemp(join(tmpdir(), "agentforge-content-workflow-")), path = join(root, "state.sqlite"), persistence = createSqlitePersistence(path);
  let persistenceClosed = false;
  try {
    persistence.save({ agents: [], teams: [], tasks: [], workflowTemplates: [{ id: "workflow_custom_content", system: false, name: "内容交付", description: "历史自定义内容流", nodes: [{ id: "draft", title: "已有草稿", ownerRole: "产品设计师", dependsOn: [], artifactPaths: ["docs/draft/"] }] }], runs: [], traces: [], artifacts: [], messages: [], decisions: [], defects: [], events: [] });
    persistence.close(); persistenceClosed = true;
    const migrated = createStore({ databasePath: path }), migratedTemplates = migrated.listWorkflowTemplates();
    const custom = migratedTemplates.find((item) => item.id === "workflow_custom_content"), builtin = migratedTemplates.find((item) => item.id === "content_delivery");
    assert.equal(custom.name, "内容交付"); assert.equal(custom.system, false);
    assert.equal(builtin, undefined);
    const restarted = createStore({ databasePath: path });
    assert.equal(restarted.listWorkflowTemplates().filter((item) => item.id === "content_delivery").length, 0);
    assert.equal(restarted.listWorkflowTemplates().find((item) => item.id === "workflow_custom_content").name, "内容交付");
  } finally { if (!persistenceClosed) persistence.close(); await rm(root, { recursive: true, force: true }); }
});

test("task creation presents explicit acceptance criteria before execution", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /name="acceptanceCriteria"/);
  assert.match(source, /验收标准（每行一条）/);
  assert.match(source, /input\.acceptanceCriteria = acceptanceCriteria/);
  assert.match(source, /验收标准最多 20 条/);
});

test("task launch discloses local execution without claiming a sandbox", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const modal = source.slice(source.indexOf("function newTaskModal()"), source.indexOf("function workflowNodeRow("));
  assert.match(modal, /aria-label="本机执行与资料边界"/);
  assert.match(modal, /工作目录不是沙箱，工具可能访问目录外文件和网络/);
  assert.match(modal, /任务资料可能发送至配置的模型服务/);
  assert.doesNotMatch(modal, /只在指定工作目录内工作/);
  const settings = await readFile(new URL("../web/settings.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /本机执行说明与版本|启动目录<\/dt>/);
});

test("inline form validation clears stale errors only after the affected control changes", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function clearInvalidField"), end = source.indexOf("\n\n/* ---------- 壳层 ---------- */", start);
  assert.ok(start >= 0 && end > start);
  const { setInvalid, clearInvalid } = new Function(`${source.slice(start, end)}; return { setInvalid, clearInvalid };`)();
  const field = () => {
    const classes = new Set(), error = { textContent: "" };
    return {
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      querySelector: (selector) => selector === ".field-error" ? error : null,
      error
    };
  };
  class Control extends EventTarget {
    constructor(owner, editable) { super(); this.owner = owner; this.editable = editable; }
    closest(selector) { return selector === ".form-field" ? this.owner : null; }
    matches(selector) { return selector === "input, textarea" && this.editable; }
  }

  const textField = field(), text = new Control(textField, true);
  setInvalid(text, "请填写任务标题。");
  assert.equal(textField.classList.contains("invalid"), true);
  assert.equal(textField.error.textContent, "请填写任务标题。");
  const unrelated = new Control(field(), true);
  unrelated.dispatchEvent(new Event("input"));
  assert.equal(textField.classList.contains("invalid"), true);
  text.dispatchEvent(new Event("change"));
  assert.equal(textField.classList.contains("invalid"), false);
  assert.equal(textField.error.textContent, "");

  const selectField = field(), select = new Control(selectField, false);
  setInvalid(select, "请选择当前团队已绑定的仓库。");
  select.dispatchEvent(new Event("input"));
  assert.equal(selectField.classList.contains("invalid"), true);
  select.dispatchEvent(new Event("change"));
  assert.equal(selectField.classList.contains("invalid"), false);
  assert.equal(selectField.error.textContent, "");

  setInvalid(text, "请填写任务标题。");
  clearInvalid({ querySelectorAll: () => [textField] });
  assert.equal(textField.classList.contains("invalid"), false);
  assert.equal(textField.error.textContent, "");
});

test("developer repositories are validated, deduplicated and frozen with Task members", () => {
  const store = createStore(), base = fixtureTaskInput(store);
  const repository = { url: "https://example.test/team/app.git", ref: "main" };
  assert.throws(() => store.createAgent({ name: "研发", role: "任意职责", kind: "developer" }), /无凭据/);
  const original = store.listAgents().find(agent => agent.id === "agent_engineer");
  assert.throws(() => store.updateAgent(original.id, { name: "不应保存", kind: "developer", repository: { url: "https://secret@example.test/app.git" } }), /无凭据/);
  assert.deepEqual(store.listAgents().find(agent => agent.id === original.id), original);
  store.updateAgent(original.id, { kind: "developer", repository });
  store.updateAgent("agent_tester", { kind: "developer", repository });
  const task = store.createTask(base);
  assert.equal(task.repositorySources.length, 1);
  assert.equal(task.repositoryBindings.agent_engineer.path, "repos/app");
  assert.deepEqual(task.repositoryBindings.agent_engineer, task.repositoryBindings.agent_tester);
  assert.equal(task.workflowSnapshot.nodes.find(node => node.id === "requirements").repositoryPath, null);
  store.updateAgent(original.id, { repository: { ...repository, ref: "next" } });
  assert.throws(() => store.createTask(base), /不同基线/);
  store.updateAgent(original.id, { kind: "business" });
  const run = store.createRun(task.id);
  assert.equal(store.getRunAgent(run.id, original.id).repository.ref, "main");
  assert.equal(store.getRunAgent(run.id, original.id).kind, "developer");
  assert.equal(store.getRunTask(run.id).repositoryBindings.agent_engineer.ref, "main");
  const extra = store.createAgent({ name: "另一个研发", role: "任意职责", kind: "developer", repository: { url: "https://example.test/other/app.git" } });
  store.updateTeam(base.teamId, { memberAgentIds: [...store.listTeams()[0].memberAgentIds, extra.id] });
  const collision = store.createTask(base);
  assert.equal(new Set(collision.repositorySources.map(source => source.path)).size, 2);
  assert.ok(collision.repositoryBindings[extra.id]); // Also prepare consultable, unassigned developers.
});

test("real Git preparation clones employee sources, preserves changes and retries failed checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-employee-git-"));
  const envKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"], previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    const executable = join(root, "provider.mjs"); await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const reviewCriteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const reviewEvidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
const out = { kind: "node_result", summary: "恢复后的本地交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "恢复后可继续", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "requirements", findings: ["恢复后的 Trace 已复核"] };
else if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "requirements", rationale: "恢复后先完成需求职责" };
else { mkdirSync("docs/requirements", { recursive: true }); writeFileSync("docs/requirements/recovery.md", "# Recovery\\nverified after checkout."); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`); await chmod(executable, 0o755);
    const origin = join(root, "origin"); await mkdir(origin);
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("-C", origin, "init", "-b", "main"); await writeFile(join(origin, "README.md"), "baseline\n");
    git("-C", origin, "add", "README.md"); git("-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
    process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`; process.env.GIT_CONFIG_VALUE_0 = "https://example.test/app.git";
    const store = createStore({ workspaceRoot: join(root, "work") });
    for (const agent of store.listAgents().filter((agent) => agent.kind !== "manager")) store.updateAgent(agent.id, { runtime: { provider: "claude-code", executable } });
    store.updateAgent("agent_engineer", { kind: "developer", repository: { url: "https://example.test/app.git", ref: "missing" } });
    const input = { ...fixtureTaskInput(store), managerRuntime: { provider: "claude-code", executable } }; delete input.workspacePath;
    const task = store.createTask(input), run = store.createRun(task.id), runTask = store.getRunTask(run.id), files = createRunFiles({ root: join(root, "audit") });
    await assert.rejects(files.prepareRunWorkspace(runTask));
    await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
    assert.equal(store.getRunWorkspace(run.id).traces.length, 0);
    assert.equal(store.getRun(run.id).status, "failed");
    assert.equal(store.getRunTask(run.id).status, "blocked");
    assert.match(store.getRun(run.id).failure.message, /运行文件或冻结仓库/);
    assert.deepEqual(store.timeline(run.id).find(event => event.type === "run.failed")?.data, { phase: "workspace_preparation" });
    assert.throws(() => store.retryFailedNode(run.id, "requirements"), /没有可恢复/);
    git("-C", origin, "branch", "missing"); // Fix external cause, retry the unchanged Task snapshot.
    store.retryFailedOrchestration(run.id);
    const recovery = store.listDispatches(run.id).find((delivery) => delivery.purpose === "manager" && delivery.status === "queued");
    assert.equal(recovery?.workflowNodeId, "requirements");
    await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
    assert.equal(store.getRun(run.id).status, "awaiting_acceptance", "the platform executes the manager handoff");
    assert.equal(store.getRunWorkspace(run.id).artifacts.some((artifact) => artifact.name === "docs/testing/review.md"), false, "this Task has no mandatory testing report");
    assert.ok(store.getRunWorkspace(run.id).traces.some((trace) => trace.type === "manager" && trace.status === "completed"));
    const baselineRevisions = await files.prepareRunWorkspace(runTask);
    const repo = join(run.workspacePath, "repos/app");
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "baseline\n");
    assert.equal(git("-C", repo, "rev-parse", "HEAD"), git("-C", origin, "rev-parse", "HEAD"));
    await writeFile(join(repo, "README.md"), "local work\n"); await files.prepareRunWorkspace(runTask);
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "local work\n");
    assert.ok((await files.listWorkingDirectory(runTask,{path:'repos'})).entries.some(entry => entry.path==='repos/app' && entry.type==='directory'));
    const next = store.createTask(input), nextRun = store.createRun(next.id);
    await files.prepareRunWorkspace(store.getRunTask(nextRun.id));
    assert.equal(await readFile(join(nextRun.workspacePath, "repos/app/README.md"), "utf8"), "baseline\n");
    assert.equal(baselineRevisions[0].commitSha, git("-C", repo, "rev-parse", "HEAD"));
    await writeFile(join(origin, "README.md"), "new upstream\n");
    git("-C", origin, "add", "README.md"); git("-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "advance");
    git("-C", origin, "branch", "-f", "missing", "HEAD");
    const recoveryTask = store.getRunTask(nextRun.id), recoveryRepo = join(nextRun.workspacePath, "repos/app");
    await rm(recoveryRepo, { recursive: true, force: true }); // Test-owned checkout only.
    const recovered = await files.prepareRunWorkspace(recoveryTask);
    assert.equal(git("-C", recoveryRepo, "rev-parse", "HEAD"), baselineRevisions[0].commitSha);
    assert.deepEqual(recovered, baselineRevisions);
    const markerPath = join(nextRun.workspacePath, ".agentforge/workspace-ready.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.repositoryRevisions[0].commitSha = "invalid";
    await writeFile(markerPath, JSON.stringify(marker));
    await assert.rejects(files.prepareRunWorkspace(recoveryTask), /基线提交无效/);
    git("-C", repo, "remote", "set-url", "origin", "https://example.test/wrong.git");
    await assert.rejects(files.prepareRunWorkspace(runTask), /来源不匹配/);
    const legacy = { ...runTask }; delete legacy.repositoryMode;
    await files.prepareRunWorkspace(legacy); // Existing ready legacy Tasks keep their original recovery semantics.
  } finally {
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
});

test("task form shows node staffing guidance without preassigning a role", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function taskAssignmentMarkup("), end = source.indexOf("function syncTaskAssignments", start);
  const state = { workflowTemplates: [{ id: "flow", nodes: [{ id: "testing", title: "开发验证", staffingGuidance: "能复现问题并给出测试证据" }] }] };
  const render = new Function("state", "esc", source.slice(start, end) + "; return taskAssignmentMarkup;")(state, value => String(value));
  const html = render({ workflowTemplateId: { value: "flow" } });
  assert.match(html, /能复现问题并给出测试证据/);
  assert.doesNotMatch(html, /nodeAssignment_|<select/);
  assert.doesNotMatch(source, /input.nodeAssignments =/);
});

test("task creation has no delivery permission form", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /taskDeliveryAuthorizationInput|task-delivery-authorization-panel|input\.deliveryAuthorization/);
});

test("console subscription invalidates stale visits and preserves history during live pagination", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function connectEvents(runId)"), source.indexOf("async function runTask(taskId"));
  const pages = new Map([["run:agent", { request: 0, loaded: true, events: [{ id: "stale" }] }]]);
  const state = { currentView: "workspace", selectedRunId: "run", selectedAgentId: "agent", eventSource: null };
  const timers = [];
  class EventSource {
    handlers = {};
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.closed = true; }
    emit(event) { this.handlers["run-event"]({ data: JSON.stringify(event) }); }
  }
  const connect = new Function("state", "consolePages", "EventSource", "setTimeout", "clearTimeout", "workspaceView", "setLiveIndicator", "loadConsolePage", "loadWorkspace", "renderConsolePage", `let workspaceRefreshTimer, consoleRenderTimer; ${code}; return connectEvents;`)(state, pages, EventSource, (fn) => { timers.push(fn); return timers.length; }, () => {}, () => ({ tab: "console" }), () => {}, () => {}, () => {}, () => {});
  connect("run");
  const page = pages.get("run:agent"); assert.equal(page.loaded, false); assert.deepEqual(page.events, []);
  page.loaded = true; page.browsingHistory = true;
  page.events = Array.from({ length: 1000 }, (_, index) => ({ id: `event_${index}` }));
  const live = { id: "new", type: "runtime.event", runId: "run", actor: { id: "agent" }, data: {} };
  state.eventSource.emit(live); state.eventSource.emit(live);
  assert.equal(page.events.length, 1001); assert.equal(page.events[0].id, "event_0");
  assert.equal(timers.length, 1, "runtime frames only schedule console painting, not metadata/global requests");
  state.eventSource.emit({ ...live, id: "status", type: "trace.accepted" });
  state.eventSource.emit({ ...live, id: "status2", type: "message.sent" });
  assert.equal(timers.length, 2, "domain changes share one coalesced refresh");
  state.eventSource.close(); state.eventSource = null;
  connect("run"); assert.equal(page.loaded, false); assert.deepEqual(page.events, []);
});

test("member sessions persist across retry and restart, isolate members and audit reconstruction", async () => {
  const root = await directory("agentforge-sessions-");
  try {
    const databasePath = join(root, "state.sqlite"), store = createStore({ databasePath }), run = store.createRun(fixtureTaskInput(store).id);
    store.initializeDispatches(run.id);
    const delivery = store.claimDispatch(run.id), trace = store.createTrace(run.id, { workflowNodeId: delivery.workflowNodeId, agentId: delivery.recipientAgentId });
    store.attachDispatchTrace(delivery.id, trace.id);
    const first = store.prepareMemberSession(delivery.id, trace.id, root);
    assert.equal(first.resume, false);
    store.completeTrace(trace.id, { status: "failed" }); store.retryDispatch(delivery.id, "429", 0);
    const restarted = createStore({ databasePath }), next = restarted.claimDispatch(run.id), secondTrace = restarted.createTrace(run.id, { workflowNodeId: next.workflowNodeId, agentId: next.recipientAgentId });
    restarted.attachDispatchTrace(next.id, secondTrace.id);
    assert.throws(() => restarted.prepareMemberSession(next.id, secondTrace.id, join(root, "other")), /工作目录/);
    const second = restarted.prepareMemberSession(next.id, secondTrace.id, root);
    assert.equal(second.sessionId, first.sessionId); assert.equal(second.resume, true);
    assert.throws(() => restarted.resetMemberSession(trace.id, "stale"), /其他执行/);
    restarted.resetMemberSession(secondTrace.id, "明确不存在");
    const rebuilt = restarted.prepareMemberSession(next.id, secondTrace.id, root);
    assert.notEqual(rebuilt.sessionId, first.sessionId);
    assert.ok(restarted.getRunWorkspace(run.id).events.some(item => item.type === "session.reset"));
    restarted.completeTrace(secondTrace.id); restarted.completeDispatch(next.id);
    const business = restarted.enqueueDispatch(run.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node" });
    restarted.claimDispatch(run.id);
    const businessTrace = restarted.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" }); restarted.attachDispatchTrace(business.id, businessTrace.id);
    assert.notEqual(restarted.prepareMemberSession(business.id, businessTrace.id, root).sessionId, rebuilt.sessionId);
    assert.throws(() => restarted.enqueueDispatch(run.id, { recipientAgentId: "human_operator", workflowNodeId: "requirements", purpose: "node" }), /数字员工/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime uses explicit session IDs and only classifies missing sessions for reconstruction", async () => {
  const root = await directory("agentforge-session-cli-");
  try {
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.at(-1)==='missing'){console.error('No conversation found with session ID');process.exit(1)}if(a.at(-1)==='retry'){console.error('503 temporary provider error');process.exit(1)}console.log(JSON.stringify({type:'result',result:JSON.stringify(a)}));`); await chmod(executable, 0o755);
    const input = { runtime: { executable }, workspacePath: root, traceDirectory: root, outputSchema: {}, prompt: "ok", runId: "session-fixture", onEvent: async () => {}, session: { sessionId: "11111111-1111-4111-8111-111111111111", resume: false } };
    const first = JSON.parse((await runClaudeCodeCli(input)).finalText); assert.ok(first.includes("--session-id")); assert.ok(!first.includes("--continue"));
    input.session.resume = true;
    const next = JSON.parse((await runClaudeCodeCli(input)).finalText); assert.ok(next.includes("--resume")); assert.ok(!next.includes("--session-id"));
    await assert.rejects(runClaudeCodeCli({ ...input, prompt: "missing" }), RuntimeSessionMissingError);
    await assert.rejects(runClaudeCodeCli({ ...input, prompt: "retry" }), error => !(error instanceof RuntimeSessionMissingError) && /503 temporary provider error/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collaboration view projects routing and replies without runtime operation details", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const project = (workspace) => collaborationRecords(workspace, { formatTime: (value) => value });
  const data = { run: { manager: { id: "pm", name: "经理" }, participants: [{ id: "a", name: "架构师" }], task: { workflowSnapshot: { nodes: [{ id: "design", title: "设计" }] } } }, messages: [{ id: "q", createdAt: "2026-01-01", sender: { type: "agent", name: "架构师" }, recipient: { type: "human", name: "你" }, kind: "clarification_question", content: "策略？" }, { id: "a", createdAt: "2026-01-02", sender: { type: "human", name: "你" }, recipient: { type: "agent", name: "架构师" }, replyToMessageId: "q", content: "策略 A" }], dispatches: [{ id: "d", createdAt: "2026-01-01", recipientAgentId: "a", workflowNodeId: "design", purpose: "node", messageIds: [], traceIds: [], attempts: 1, status: "done" }], events: [{ id: "tool", type: "runtime.event", message: "Bash private tool input" }] };
  const records = project(data); assert.equal(records.length, 2); assert.equal(records.find(item => item.id === "q").status, "已回答"); assert.match(records.find(item => item.id === "a").reply, /策略/); assert.equal(records.some(item => item.id === "tool"), false);
  data.dispatches.unshift({ id: "pm-dispatch", createdAt: "2026-01-01", recipientAgentId: "pm", workflowNodeId: "design", purpose: "manager", messageIds: [], traceIds: [], attempts: 1, status: "done" });
  data.dispatches[1].dedupeKey = "handoff:pm-dispatch"; data.dispatches[1].messageIds = ["q", "a"];
  assert.equal(project(data).some(item => item.id === "d"), false);
  assert.ok(source.indexOf('id="collaboration-mode"') < source.indexOf('id="directory-mode"')); assert.ok(source.indexOf('id="directory-mode"') < source.indexOf('id="console-mode"'));
  assert.match(source, /data-ws-tab="collaboration"/); assert.doesNotMatch(source, /id="clarification-launcher"/);
  assert.doesNotMatch(source, /<summary>关联记录<\/summary>|data-collaboration-id/);
  assert.match(source, /item\.traceId \? `<button class="text-action trace-link" data-open-collaboration-trace/);
});

test("workspace file rows match the two-cell markup and bound wide-screen navigation", async () => {
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(css, /#run-workspace \.artifact-tree-file \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /clamp\(280px,23vw,360px\)/);
  assert.match(css, /artifact-viewer:has\(\.artifact-placeholder\)/);
});
test("composer lists real members once and supports selection, newline and IME-safe submission", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const members = mentionables;
  assert.equal(members([{ id: "pm", name: "经理" }, { id: "pm", name: "经理" }, { id: "worker", name: "成员" }]).length, 2);
  let handler, submits = 0, newlines = 0, selected = 0;
  const option = { classList: { contains: () => true }, click: () => selected++ };
  let options = [option];
  const list = { classList: { contains: () => true, remove() {} }, querySelectorAll: () => options };
  const register = source.slice(source.indexOf('document.addEventListener("keydown",'), source.indexOf('window.addEventListener("popstate",'));
  new Function("document", "$", "state", "Event", "closeModal", register)({ addEventListener: (_, fn) => handler = fn }, () => list, { workspace: { run: { task: {} } } }, class {}, () => {});
  const input = { id: "instruction-text", selectionStart: 0, selectionEnd: 0, setRangeText: () => newlines++, dispatchEvent() {}, form: { requestSubmit: () => submits++ } };
  const press = (key, extra = {}) => handler({ key, target: input, preventDefault() {}, ...extra });
  press("Tab"); press("Enter"); assert.equal(selected, 2); assert.equal(submits, 0);
  options = [];
  press("Enter", { isComposing: true }); press("Enter", { keyCode: 229 }); assert.equal(submits, 0);
  for (const modifier of ["shiftKey", "metaKey", "altKey", "ctrlKey"]) press("Enter", { [modifier]: true });
  assert.equal(newlines, 4); assert.equal(submits, 0); press("Enter"); assert.equal(submits, 1);
});
test("Runtime cancellation fence rejects before spawn and paused Task cannot be deleted", async () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id); store.pauseRun(run.id);
  assert.throws(() => store.deleteTask(run.taskId), /活跃/);
  await assert.rejects(runClaudeCodeCli({ runtime: { provider: "claude-code", executable: "/must-not-spawn" }, workspacePath: process.cwd(), traceDirectory: process.cwd(), outputSchema: { type: "object" }, prompt: "", runId: "fence-test", onEvent: async () => {}, canStart: () => false }), /启动前已暂停或终止/);
});

test("Task deletion stages Run files until Store deletion commits and recovers an interrupted handoff", async () => {
  const root = await directory("agentforge-task-delete-"), runFilesRoot = join(root, "run-files");
  try {
    const files = createRunFiles({ root: runFilesRoot }), store = createStore(), run = store.createRun(fixtureTaskInput(store).id), sentinel = join(runFilesRoot, "runs", run.id, "traces", "snapshot.txt");
    await files.prepareRun(run.id);
    await writeFile(sentinel, "verified delivery snapshot");

    const rejected = await files.stageRunsForDeletion([run.id]);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
    store.pauseRun(run.id);
    assert.throws(() => store.deleteTask(run.taskId), /活跃/);
    await files.restoreStagedRuns(rejected);
    assert.equal(await readFile(sentinel, "utf8"), "verified delivery snapshot");

    const interruptedBeforeStore = await files.stageRunsForDeletion([run.id]);
    assert.ok(interruptedBeforeStore);
    assert.deepEqual(await files.recoverStagedTaskDeletions((runId) => store.listRuns().some((item) => item.id === runId)), { restored: 1, finalized: 0, failed: 0 });
    assert.equal(await readFile(sentinel, "utf8"), "verified delivery snapshot");

    store.cancelRun(run.id, "test cleanup");
    const interruptedAfterStore = await files.stageRunsForDeletion([run.id]);
    store.deleteTask(run.taskId);
    const cleanupFailure = createRunFiles({ root: runFilesRoot, removeDirectory: async () => { const error = new Error("simulated cleanup failure"); error.code = "EACCES"; throw error; } });
    await assert.rejects(cleanupFailure.finalizeStagedRuns(interruptedAfterStore), /simulated cleanup failure/);
    assert.deepEqual(await files.recoverStagedTaskDeletions((runId) => store.listRuns().some((item) => item.id === runId)), { restored: 0, finalized: 1, failed: 0 });
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
    await assert.rejects(files.stageRunsForDeletion(["../runs"]), /Run ID 不合法/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("custom workflow deletion preserves Task template references", async () => {
  const store = createStore();
  const workflow = store.createWorkflowTemplate({ name: "受引用工作流", nodes: [{ id: "discovery", title: "发现", staffingGuidance: "需求分析师", dependsOn: [] }] });
  const base = fixtureTaskInput(store);
  const task = store.createTask({ ...base, workflowTemplateId: workflow.id, nodeAssignments: { discovery: "agent_analyst" } });
  assert.throws(() => store.deleteWorkflowTemplate(workflow.id), /仍被 1 个 Task 的冻结快照引用/);
  assert.ok(store.listWorkflowTemplates().some((item) => item.id === workflow.id));
  store.deleteTask(task.id);
  assert.equal(store.deleteWorkflowTemplate(workflow.id).id, workflow.id);
  assert.equal(store.listWorkflowTemplates().some((item) => item.id === workflow.id), false);

  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderWorkflows()"), end = source.indexOf("\n\nfunction workflowDetails", start);
  const host = {};
  const render = new Function("state", "disposeWorkflowGraphs", "$", "esc", "paginate", "renderListPager", `${source.slice(start, end)}; return renderWorkflows;`)({
    tasks: [{ workflowTemplateId: "referenced" }], listPages: { workflows: 1 },
    workflowTemplates: [
      { id: "referenced", name: "受引用", system: false, description: "", nodes: [{ id: "node", dependsOn: [] }] },
      { id: "available", name: "可删除", system: false, description: "", nodes: [{ id: "node", dependsOn: [] }] }
    ]
  }, () => {}, () => host, (value) => String(value), (items) => ({items, page:1}), () => {});
  render();
  assert.match(host.innerHTML, /已被 1 个任务引用/);
  assert.doesNotMatch(host.innerHTML, /data-delete-workflow="referenced"/);
  assert.match(host.innerHTML, /data-delete-workflow="available"/);
});

test("task center exposes deletion only when the Store says it is safe", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function taskMatchesSearch("), end = source.indexOf("\n\n/* ---------- 团队", start);
  const hosts = { "#tasks-heading": {}, "#task-filter-bar": {}, "#tasks-table": {}, "#task-search-form .task-directory-actions": { innerHTML: "" } };
  const state = {
    taskArchiveView: false, listPages: { tasks: 1, archive: 1 },
    taskFilter: "all",
    tasks: [
      { id: "backlog", title: "未启动", objective: "尚未创建 Run", status: "backlog", deletionBlockedBy: null, updatedAt: "2026-09-29T00:00:00.000Z", team: { name: "团队" }, workflowSnapshot: { name: "流程" } },
      { id: "finished", title: "已结束", objective: "可删除的历史任务", status: "done", deletionBlockedBy: null, updatedAt: "2026-09-29T00:00:00.000Z", team: { name: "团队" }, workflowSnapshot: { name: "流程" } },
      { id: "active", title: "执行中", objective: "必须保留", status: "running", deletionBlockedBy: "active_run", updatedAt: "2026-09-29T00:00:00.000Z", team: { name: "团队" }, workflowSnapshot: { name: "流程" } },
      { id: "inquiry", title: "答疑中", objective: "仍有可执行答疑", status: "done", deletionBlockedBy: "active_inquiries", updatedAt: "2026-09-29T00:00:00.000Z", team: { name: "团队" }, workflowSnapshot: { name: "流程" } }
    ],
    runs: [
      { id: "finished-run", taskId: "finished", status: "completed" },
      { id: "active-run", taskId: "active", status: "running" }
    ],
    workflowTemplates: []
  };
  const render = new Function("state", "$", "TASK_FILTERS", "taskNeedsAttention", "taskMatchesFilter", "runOfTask", "taskActionLabel", "pill", "esc", "exactTime", "timeAgo", "workspaceSummary", "statusText", "paginate", "paginationMarkup", "window", `${source.slice(start, end)}; return renderTasks;`)(
    state,
    (selector) => hosts[selector],
    [{ id: "all", label: "全部" }],
    () => false,
    () => true,
    (taskId) => state.runs.find((run) => run.taskId === taskId),
    () => "查看任务",
    (status) => status,
    (value) => String(value),
    (value) => String(value),
    (value) => String(value),
    (task) => task.workspaceKind === "managed" ? "系统受管目录" : "既有工作目录",
    {},
    (items) => ({ items, page: 1 }), () => "", { addEventListener() {} }
  );
  render();
  assert.match(hosts["#tasks-table"].innerHTML, /data-delete-task="backlog"/);
  assert.match(hosts["#tasks-table"].innerHTML, /data-delete-task="finished"/);
  assert.doesNotMatch(hosts["#tasks-table"].innerHTML, /data-delete-task="active"/);
  assert.doesNotMatch(hosts["#tasks-table"].innerHTML, /data-delete-task="inquiry"/);
  assert.match(hosts["#tasks-table"].innerHTML, /答疑进行中/);
  assert.match(source, /function openDeleteTaskModal\(taskId\)/);
  assert.match(source, /task\.deletionBlockedBy === "active_inquiries"/);
  assert.match(source, /task\.deletionBlockedBy = workspace\.run\.task\.deletionBlockedBy/);
  assert.match(source, /api\(`\/api\/tasks\/\$\{taskId\}`, \{ method: "DELETE" \}\)/);
  assert.match(source, /runFileCleanup === "pending"/);
  const server = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  assert.match(server, /store\.assertTaskDeletionAllowed\(taskId\)/);
  assert.match(server, /stageRunsForDeletion\(relatedRuns\.map\(\(run\) => run\.id\)\)/);
  assert.match(server, /restoreStagedRuns\(staged\)/);
  assert.match(server, /runFileCleanup: "pending"/);
  assert.match(server, /recoverStagedTaskDeletions/);
});
const result = (patch = {}) => ({ kind: "node_result", summary: "真实交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "已有输入足以完成当前目标", missingEvidence: [] }, deliveryReview: null, managerDecision: null, ...patch });

test("employee reports retain extra fields and do not require a result schema", () => {
  const report = readNodeResult({ summary: "员工结论", customReport: "保留", defects: [{ title: "问题", severity: "custom", affectedNodeIds: ["unknown"] }] });
  assert.equal(report.customReport, "保留");
  assert.equal(report.defects[0].severity, "custom");
  assert.equal(readNodeResult("普通文字交接").summary, "普通文字交接");
});


test("manager conclusions are interpreted without content validation", () => {
  assert.equal(readNodeResult({ deliveryReview: { verdict: "pass", findings: [] } }).deliveryReview.verdict, "pass");
  assert.deepEqual(readNodeResult({ summary: "完成" }).defects, []);
});

test("recording a manager conclusion never rewrites pass or checks workflow coverage", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const input = { verdict: "pass", findings: [], restartFromNodeId: "", extra: "原样记录" };
  assert.deepEqual(store.recordDeliveryReview(run.id, "manager-trace", input), { ...input, traceId: "manager-trace" });
  assert.equal(store.getRunWorkspace(run.id).artifacts.length, 0);
});

test("the manager can request human acceptance without platform completion conditions", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", trace.id, result({ defects: [{ title: "员工记录的问题", severity: "high" }] }));
  store.requestHumanAcceptance(run.id, { summary: "经理决定交人类验收" });
  assert.equal(store.getRun(run.id).status, "awaiting_acceptance");
  assert.equal(store.confirmRunCompletion(run.id).status, "completed");
  assert.equal(store.listDefects(run.id)[0].status, "open");
  assert.equal(store.getRunWorkspace(run.id).traces[0].status, "running");
});

test("Store records employee decisions and defects without business validation", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", trace.id, result({ decisions: [{ summary: "员工决定", impact: "custom", affectedNodeIds: ["external"] }], defects: [{ title: "员工问题", severity: "custom", affectedNodeIds: ["external"] }], resolvesDefectIds: ["unknown"] }));
  const workspace = store.getRunWorkspace(run.id);
  assert.equal(workspace.decisions[0].impact, "custom");
  assert.equal(workspace.defects[0].severity, "custom");
  assert.deepEqual(workspace.defects[0].affectedNodeIds, ["external"]);
});

test("repository snapshots ignore runtime logs but retain tracked files, new source and document evidence", async () => {
  const root = await directory("agentforge-git-snapshot-");
  try {
    const repo = join(root, "repos", "app"), files = createRunFiles({ root: join(root, "run-files") });
    execFileSync("git", ["-C", repo, "init", "--quiet"]);
    await mkdir(join(repo, "logs")); await mkdir(join(root, "docs"));
    await writeFile(join(repo, ".gitignore"), "logs/\n*.db\n");
    await writeFile(join(repo, "logs", "tracked.log"), "tracked fixture");
    execFileSync("git", ["-C", repo, "add", "-f", "logs/tracked.log"]);
    await writeFile(join(repo, "logs", "server.log"), "GET /api/health");
    await writeFile(join(repo, "runtime.db"), "runtime");
    await writeFile(join(repo, "new.mjs"), "export const value = 1;");
    await writeFile(join(root, "docs", "verification.log"), "test evidence");
    const before = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] });
    assert.ok(before.has("repos/app/new.mjs")); assert.ok(before.has("repos/app/logs/tracked.log")); assert.ok(before.has("docs/verification.log"));
    assert.equal(before.has("repos/app/logs/server.log"), false); assert.equal(before.has("repos/app/runtime.db"), false);
    await writeFile(join(repo, "logs", "server.log"), "GET /api/health again");
    assert.equal((await files.captureWorkspaceChanges({ runId: "r", traceId: "t", workspacePath: root, before, includeRoots: ["docs", "repos"] })).artifacts.length, 0);
    await writeFile(join(repo, "new.mjs"), "export const value = 2;");
    assert.equal((await files.captureWorkspaceChanges({ runId: "r", traceId: "t2", workspacePath: root, before, includeRoots: ["docs", "repos"] })).artifacts[0].name, "repos/app/new.mjs");
    await writeFile(join(repo, "later-ignored.tmp"), "still exists");
    const beforeIgnore = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] });
    await writeFile(join(repo, ".gitignore"), "logs/\n*.db\n*.tmp\n");
    const changedIgnore = await files.captureWorkspaceChanges({ runId: "r", traceId: "t3", workspacePath: root, before: beforeIgnore, includeRoots: ["docs", "repos"] });
    assert.deepEqual(changedIgnore.artifacts.map(a => a.name), ["repos/app/.gitignore"]);
    const beforeDelete = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] });
    await rm(join(repo, "new.mjs"));
    const deleted = (await files.captureWorkspaceChanges({ runId: "r", traceId: "t4", workspacePath: root, before: beforeDelete, includeRoots: ["docs", "repos"] })).artifacts;
    assert.equal(deleted[0].name, "repos/app/new.mjs"); assert.equal(deleted[0].deleted, true);
    const store = createStore(), run = store.createRun(fixtureTaskInput(store).id), trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
    store.acceptNodeResult(run.id, "requirements", trace.id, result(), deleted);
    assert.equal(store.getRunWorkspace(run.id).artifacts[0].deleted, true);
    await writeFile(join(repo, ".git", "index"), "invalid git index");
    await assert.rejects(files.snapshotWorkspace(root), /无法读取仓库文件清单/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Artifact capture ignores sensitive and symbolic-link changes without copying them", async () => {
  const root = await directory("agentforge-restricted-capture-"), outside = await mkdtemp(join(tmpdir(), "agentforge-restricted-outside-"));
  try {
    const files = createRunFiles({ root: join(root, "run-files") });
    await mkdir(join(root, "docs", "requirements"), { recursive: true });
    const sensitiveBefore = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] });
    await writeFile(join(root, "docs", "requirements", "report.md"), "# Valid delivery\n");
    await writeFile(join(root, "docs", "requirements", ".env"), "fixture-secret");
    const sensitive = await files.captureWorkspaceChanges({ runId: "run", traceId: "sensitive", workspacePath: root, before: sensitiveBefore, includeRoots: ["docs", "repos"], allowedRoots: null });
    assert.deepEqual(sensitive.artifacts.map((item) => item.name), ["docs/requirements/report.md"]);
    assert.doesNotMatch(JSON.stringify(sensitive), /fixture-secret|\.env/);

    await rm(join(root, "docs", "requirements", ".env"));
    const linkBefore = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] });
    await writeFile(join(root, "docs", "requirements", "report-2.md"), "# Second delivery\n");
    await writeFile(join(outside, "target.md"), "outside fixture");
    await symlink(join(outside, "target.md"), join(root, "docs", "requirements", "linked-report.md"));
    const linked = await files.captureWorkspaceChanges({ runId: "run", traceId: "link", workspacePath: root, before: linkBefore, includeRoots: ["docs", "repos"], allowedRoots: null });
    assert.deepEqual(linked.artifacts.map((item) => item.name), ["docs/requirements/report-2.md"]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("new tasks do not need delivery authorization", () => {
  const store = createStore(), base = fixtureTaskInput(store);
  store.updateAgent("agent_engineer", { kind: "developer", repository: { url: "https://github.com/example/app", ref: "main" } });
  const make = (deliveryAuthorization) => store.createTask({ ...base, deliveryAuthorization });
  assert.deepEqual(store.listTeams()[0].deliveryRepositories, [{ path: "repos/app", url: "https://github.com/example/app", ref: "main" }]);
  const task = make(undefined);
  assert.equal(task.deliveryAuthorization, null);
  assert.equal(make({ allowPush: false }).deliveryAuthorization, null);
  assert.equal(store.createRun(task.id).participants.some((member) => member.type === "human"), true);
});

test("teams select managers, include humans, and freeze Run member responsibilities", () => {
  const store = createStore(), worker = store.createAgent({ name: "通用成员", role: "任意职责", systemPrompt: "整理事实", capabilities: ["检索"] });
  const pm = store.createAgent({ name: "自定义经理", role: "协调者", kind: "manager", systemPrompt: "协调通用任务" });
  const team = store.createTeam({ name: "团队", managerAgentId: pm.id, memberAgentIds: [worker.id] });
  const flow = store.createWorkflowTemplate({ name: "不匹配名称仍可显式分配", nodes: [{ id: "work", title: "工作", staffingGuidance: "资料整理", dependsOn: [] }] });
  const task = store.createTask({ title: "任务", objective: "交付", workspacePath: process.cwd(), teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { work: worker.id } });
  const run = store.createRun(task.id);
  assert.equal(run.manager.sourceAgentId, pm.id);
  assert.equal(worker.kind, "business");
  const inferred = store.createTeam({ name: "直接加入经理", memberAgentIds: [worker.id, pm.id] });
  assert.equal(inferred.managerAgentId, pm.id); assert.deepEqual(inferred.memberAgentIds, [worker.id]);
  assert.equal(store.listTeams().find(item => item.id === inferred.id).members.filter(item => item.kind === "manager").length, 1);
  assert.equal(store.createTeam({ name: "无经理", memberAgentIds: [worker.id] }).managerAgentId, "system_project_manager");
  assert.throws(() => store.createTeam({ name: "冲突", memberAgentIds: [worker.id, pm.id, "system_project_manager"] }), /一名/);
  assert.equal(run.participants.filter((member) => member.kind === "manager").length, 1);
  assert.equal(run.participants.find((member) => member.type === "human").runtime, undefined);
  store.updateAgent(worker.id, { systemPrompt: "全新职责" });
  assert.equal(store.getRunAgent(run.id, worker.id).systemPrompt, "整理事实");
  const outsider = store.createAgent({ name: "外部", role: "任意" });
  assert.equal(store.getRunAgent(run.id, outsider.id), null);
  assert.throws(() => store.createTrace(run.id, { agentId: "human_operator", workflowNodeId: "work" }), /不属于/);
  assert.throws(() => store.updateTeam(team.id, { managerAgentId: worker.id }), /项目经理/);
  assert.throws(() => store.updateTeam(team.id, { memberAgentIds: [] }), /业务/);
});

test("durable dispatch deduplicates, retries, preserves queue on pause, and rolls back transactions", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.initializeDispatches(run.id);
  const beforeUntargeted = store.snapshot();
  assert.throws(() => store.submitHumanMessage(run.id, { content: "没有收件人的消息" }), /明确指定一位/);
  assert.deepEqual(store.snapshot(), beforeUntargeted);
  const claimed = store.claimDispatch(run.id);
  assert.equal(store.claimDispatch(run.id), null);
  const sent = store.submitHumanMessage(run.id, { content: "追加范围，不打断", recipientAgentId: run.manager.id });
  assert.equal(store.getDispatch(claimed.id).status, "claimed");
  const queued = store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id));
  assert.equal(store.enqueueDispatch(run.id, { ...queued }).id, queued.id);
  store.retryDispatch(claimed.id, "429", 0);
  assert.equal(store.claimDispatch(run.id).id, claimed.id);
  const snapshot = store.snapshot();
  assert.throws(() => store.transaction(() => { store.completeDispatch(claimed.id); store.addMessage({ runId: run.id, content: "必须回滚" }); throw Error("invalid"); }), /invalid/);
  assert.deepEqual(store.snapshot(), snapshot);
  store.pauseRun(run.id);
  assert.equal(store.claimDispatch(run.id), null);
  store.submitHumanMessage(run.id, { content: "暂停时继续排队", recipientAgentId: run.manager.id });
  assert.equal(store.getRun(run.id).status, "paused");
  store.cancelRun(run.id, "结束测试");
  assert.equal(store.listDispatches(run.id).every((item) => item.status === "cancelled"), true);
  assert.equal(store.submitHumanMessage(run.id, { content: "终止后仍可咨询", recipientAgentId: run.manager.id }).interactionOnly, true);
  assert.equal(store.claimDispatch(run.id).purpose, "inquiry");
  assert.equal(store.getRun(run.id).status, "cancelled");
});

test("human retry now clears a scheduled backoff without rewriting failed evidence", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.initializeDispatches(run.id);
  const delivery = store.claimDispatch(run.id), trace = store.createTrace(run.id, { workflowNodeId: delivery.workflowNodeId, agentId: delivery.recipientAgentId, type: delivery.purpose });
  store.attachDispatchTrace(delivery.id, trace.id);
  assert.throws(() => store.retryScheduledDispatches(run.id), /当前没有等待退避/);
  store.completeTrace(trace.id, { status: "failed", error: "临时 Provider 错误" });
  store.retryDispatch(delivery.id, "临时 Provider 错误", 300000);
  const before = store.getDispatch(delivery.id);
  assert.ok(before.nextRetryAt);
  const result = store.retryScheduledDispatches(run.id);
  const after = store.getDispatch(delivery.id);
  assert.deepEqual(result.dispatchIds, [delivery.id]);
  assert.equal(after.nextRetryAt, null);
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.lastError, before.lastError);
  assert.equal(store.getRunWorkspace(run.id).traces.find((item) => item.id === trace.id).status, "failed");
  assert.equal(store.getRunWorkspace(run.id, { summary: true }).events.at(-1).type, "dispatch.retry_requested");
  assert.equal(store.claimDispatch(run.id).id, delivery.id);
  assert.throws(() => store.retryScheduledDispatches(run.id), /当前没有等待退避/);
});

test("failed Run recovery preserves failed evidence and queues a manager reassessment", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const delivery = store.enqueueDispatch(run.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node", dedupeKey: "failed-requirements" });
  store.claimDispatch(run.id);
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst", type: "node" });
  store.attachDispatchTrace(delivery.id, trace.id);
  assert.throws(() => store.failRun(run.id, "不应在活跃 Trace 时失败"), /活跃执行/);
  store.completeTrace(trace.id, { status: "failed", error: "结构化输出无效" });
  store.retryDispatch(delivery.id, "结构化输出无效");
  store.failRun(run.id, "该职责未能完成，请修复原因后恢复。", "runtime");
  assert.equal(store.getRun(run.id).status, "failed");
  assert.equal(store.getRunTask(run.id).status, "blocked");
  assert.throws(() => store.retryFailedOrchestration(run.id), /失败的业务职责/);
  assert.throws(() => store.retryFailedNode(run.id, "design"), /没有可恢复/);
  store.retryFailedNode(run.id, "requirements");
  const dispatches = store.listDispatches(run.id), recovery = dispatches.find((item) => item.purpose === "manager" && item.status === "queued");
  assert.equal(store.getRun(run.id).status, "running");
  assert.equal(store.getRunTask(run.id).status, "running");
  assert.equal(store.getRun(run.id).failure, null);
  assert.equal(store.getDispatch(delivery.id).status, "cancelled");
  assert.equal(recovery.workflowNodeId, "requirements");
  store.failRun(run.id, "恢复时运行文件仍未准备好。", "workspace_preparation");
  store.retryFailedNode(run.id, "requirements");
  const retryRecovery = store.listDispatches(run.id).find((item) => item.purpose === "manager" && item.status === "queued");
  assert.notEqual(retryRecovery.id, recovery.id);
  assert.equal(store.getDispatch(recovery.id).status, "cancelled");
  assert.equal(store.claimDispatch(run.id).id, retryRecovery.id);
  const retries = store.timeline(run.id).filter((event) => event.type === "run.retry_requested");
  assert.deepEqual(retries.map((event) => event.data.failedTraceIds), [[trace.id], [trace.id]]);
  assert.deepEqual(retries.map((event) => event.data.cancelledDispatchIds), [[delivery.id], [recovery.id]]);
});

test("orchestration recovery replaces a cancelled manager dispatch after another preparation failure", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "failed" }); store.setTaskStatus(run.taskId, "blocked");
  store.retryFailedOrchestration(run.id);
  const first = store.listDispatches(run.id).find((item) => item.purpose === "manager" && item.status === "queued");
  store.failRun(run.id, "运行文件仍未准备好。", "workspace_preparation");
  store.retryFailedOrchestration(run.id);
  const second = store.listDispatches(run.id).find((item) => item.purpose === "manager" && item.status === "queued");
  assert.notEqual(second.id, first.id);
  assert.equal(store.getDispatch(first.id).status, "cancelled");
  assert.equal(store.claimDispatch(run.id).id, second.id);
});

test("nested consultation routes any role to human, rejects wait cycles, and resumes exact parent", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const a = store.enqueueDispatch(run.id, { recipientAgentId: "agent_engineer", workflowNodeId: "development", purpose: "node" });
  store.claimDispatch(run.id);
  const ask = (recipientAgentId, audience = "agent") => ({ audience, recipientAgentId, question: "策略是什么？", questionType: "策略选择", routingReason: "依据提示词和能力，技术策略需要责任人确认", consideredMemberIds: ["agent_designer", "agent_engineer", "human_operator"] });
  const first = store.askQuestion(a.id, ask("agent_designer"));
  const b = store.claimDispatch(run.id);
  assert.throws(() => store.askQuestion(b.id, ask("agent_engineer")), /等待环/);
  assert.equal(store.pendingQuestions(run.id).length, 1);
  const second = store.askQuestion(b.id, ask("", "human"));
  assert.equal(store.getRun(run.id).status, "awaiting_human");
  assert.throws(() => store.answerQuestion(run.id, first.id, "假冒", { type: "human", id: "human_operator" }), /匹配/);
  store.pauseRun(run.id);
  const answer = store.submitHumanMessage(run.id, { content: "选择 A", replyToMessageId: second.id });
  assert.equal(answer.message.replyToMessageId, second.id);
  assert.equal(store.getRun(run.id).status, "paused");
  assert.equal(store.claimDispatch(run.id), null);
  store.resumeRun(run.id); store.syncWaiting(run.id);
  assert.equal(store.claimDispatch(run.id).id, b.id);
  store.transaction(() => { store.answerQuestion(run.id, first.id, "策略 A", { type: "agent", id: "agent_designer" }); store.completeDispatch(b.id); });
  assert.equal(store.claimDispatch(run.id).id, a.id);
  assert.equal(store.pendingQuestions(run.id).length, 0);
  assert.equal(store.canCompleteRun(run.id), false);
  assert.throws(() => store.submitHumanMessage(run.id, { content: "重复回答", replyToMessageId: second.id }), /匹配/);
});

test("SQLite restart recovers claimed dispatch with the same messages and a new attempt", async () => {
  const root = await directory("agentforge-queue-");
  try {
    const databasePath = join(root, "queue.sqlite"), first = createStore({ databasePath });
    const run = first.createRun(first.listTasks()[0].id);
    first.updateRun(run.id, { status: "running" }); first.setTaskStatus(run.taskId, "running");
    const sent = first.submitHumanMessage(run.id, { content: "重启不能丢消息", recipientAgentId: run.manager.id });
    const claimed = first.claimDispatch(run.id);
    const trace = first.createTrace(run.id, { agentId: run.manager.id, workflowNodeId: "requirements", type: "manager" });
    first.attachDispatchTrace(claimed.id, trace.id);
    const restored = createStore({ databasePath }); restored.recoverInterruptedRun(run.id);
    const retry = restored.claimDispatch(run.id);
    assert.equal(retry.id, claimed.id); assert.equal(retry.attempts, 2);
    assert.deepEqual(retry.messageIds, [sent.message.id]);
    assert.equal(restored.getRunWorkspace(run.id).traces[0].status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("working directory reads all task files without a manifest and rejects unsafe paths", async () => {
  const workspacePath = await directory("agentforge-directory-");
  try {
    const files = createRunFiles({ root: join(workspacePath, "snapshots") });
    const task = { workspacePath, workflowSnapshot: { nodes: [{ repositoryPath: "repos/app" }] } };
    await mkdir(join(workspacePath, "docs"));
    await writeFile(join(workspacePath, "docs/spec.md"), "# Specification");
    await writeFile(join(workspacePath, "repos/app/index.js"), "export const ready = true;");
    const tree = await files.listWorkingDirectory(task);
    assert.ok(tree.entries.some(entry=>entry.path==='docs'));
    assert.ok(tree.entries.some(entry=>entry.path==='repos'));
    assert.equal((await files.readWorkingFile(task, "docs/spec.md")).content, "# Specification");
    await assert.rejects(files.readWorkingFile(task, "../package.json"));
    await assert.rejects(files.readWorkingFile(task, "repos/app/.env"));
    await symlink(join(workspacePath, "repos"), join(workspacePath, "docs/link"));
    await assert.rejects(files.readWorkingFile(task, "docs/link/app/index.js"), /符号链接/);
    const protocolPath = join(workspacePath, ".agentforge-workspace.json");
    await writeFile(protocolPath,'not a protocol any more');
    assert.ok(!(await files.listWorkingDirectory(task)).entries.some(entry=>entry.path==='.agentforge-workspace.json'));
    assert.equal(await readFile(protocolPath,'utf8'),'not a protocol any more');
  } finally { await rm(workspacePath, { recursive: true, force: true }); }
});

test("new Run stores overall status and Trace facts, never per-node lifecycle status", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id), snapshot = store.snapshot();
  assert.equal("nodeStates" in run, false); assert.equal("reflectionAgent" in run, false); assert.equal(run.manager.sourceAgentId, "system_project_manager");
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", trace.id, result({ decisions: [{ summary: "验收口径", impact: "clarification", affectedNodeIds: [], rationale: "明确" }] }), [{ name: "docs/requirements/acceptance.md", storagePath: "runs/x/docs/acceptance.md", sha256: "a", bytes: 1 }]); store.completeTrace(trace.id);
  const focus = store.setCurrentFocus(run.id, "requirements", "项目经理要求先确认验收口径");
  assert.deepEqual(focus.nodeId, "requirements"); assert.equal(store.getRun(run.id).currentFocus.reason, "项目经理要求先确认验收口径");
  assert.equal(store.getRunWorkspace(run.id).decisions.length, 1); assert.equal("nodeStates" in snapshot.runs[0], false);
});
test("workflow delivery positions and Artifacts can use any business workspace path", () => {
  const store = createStore();
  assert.deepEqual(store.createWorkflowTemplate({ name: "根交付", nodes: [{ id: "verify", title: "验证", staffingGuidance: "测试工程师", artifactPaths: ["report.md"], dependsOn: [] }] }).nodes[0].artifactPaths,['report.md']);
  const run = store.createRun(fixtureTaskInput(store).id), trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", trace.id, result(), [{ name: "docs/requirements/spec.md", storagePath: "runs/x/docs/spec.md", sha256: "a", bytes: 1 }]);
  assert.equal(store.getRunWorkspace(run.id).artifacts[0].category, "document");
});
test("business and manager handoffs can finish without changing files", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const businessTrace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", businessTrace.id, result());
  assert.equal(store.getRunWorkspace(run.id).artifacts.length, 0);
  const managerTrace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: run.manager.id, type: "manager" });
  store.acceptNodeResult(run.id, "requirements", managerTrace.id, result({ managerDecision: { nextNodeId: "requirements", rationale: "继续核验" } }));
  assert.equal(store.getRunWorkspace(run.id).artifacts.length, 0);
});
test("human clarification pauses and resumes the overall Run without changing a node state", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id); store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running"); store.waitForHuman(run.id, "requirements", "conversation_requirements");
  const message = store.addMessage({ runId: run.id, conversationId: "conversation_requirements", workflowNodeId: "requirements", recipientAgentId: "agent_analyst", content: "密码必须隐藏" }); store.resumeHuman(run.id, message.id);
  assert.equal(store.getRun(run.id).status, "running"); assert.equal(store.getRun(run.id).waitingNodeId, null);
});
test("any workflow responsibility remains a collaboration candidate after an earlier Trace", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id), trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" }); store.completeTrace(trace.id);
  assert.deepEqual(store.collaborationCandidates(run.id).map((node) => node.id), ["requirements", "design", "development", "testing", "bug_fix", "regression"]);
});
test("recovery preserves failed Trace and lets the project manager re-evaluate", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id); store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running"); const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  const recovered = store.recoverInterruptedRun(run.id); assert.deepEqual(recovered.interruptedTraceIds, [trace.id]); assert.equal(store.getRunWorkspace(run.id).traces[0].status, "failed"); assert.equal(store.getRun(run.id).status, "running");
});
test("pause, retry and cancellation only affect the Run, not invented node states", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id); store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running"); assert.equal("nodeStates" in store.pauseRun(run.id), false); assert.equal(store.resumeRun(run.id).status, "running"); store.updateRun(run.id, { status: "failed" }); store.setTaskStatus(run.taskId, "blocked"); assert.equal(store.retryFailedOrchestration(run.id).status, "running");
});
test("only completed Tasks can be archived without deleting their Run history", () => {
  const store = createStore(), task = fixtureTaskInput(store), run = store.createRun(task.id);
  assert.throws(() => store.archiveTask(task.id), /已完成/);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(task.id, "running");
  store.updateRun(run.id, { status: "review" }); store.setTaskStatus(task.id, "review");
  assert.throws(() => store.updateRun(run.id, { status: "completed" }), /人类/);
  store.updateRun(run.id, { status: "awaiting_acceptance", deliveryReview: { verdict: "pass", findings: ["已验证"] } }); store.setTaskStatus(task.id, "awaiting_acceptance");
  store.confirmRunCompletion(run.id);
  const archived = store.archiveTask(task.id);
  assert.ok(archived.archivedAt); assert.equal(store.listRuns().find((item) => item.id === run.id).task.archivedAt, archived.archivedAt);
  assert.throws(() => store.archiveTask(task.id), /已经归档/);
  const restored = store.unarchiveTask(task.id);
  assert.equal(restored.archivedAt, null); assert.equal(store.getRun(run.id).status, "completed");
});
test("Task deletion keeps a terminal Run's unfinished inquiry auditable", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.updateRun(run.id, { status: "review" }); store.setTaskStatus(run.taskId, "review");
  store.updateRun(run.id, { status: "awaiting_acceptance", deliveryReview: { verdict: "pass", findings: ["已验证"] } }); store.setTaskStatus(run.taskId, "awaiting_acceptance");
  store.confirmRunCompletion(run.id);
  const inquiry = store.submitHumanMessage(run.id, { content: "请解释已交付的取舍", recipientAgentId: run.manager.id });
  assert.equal(inquiry.interactionOnly, true);
  assert.equal(store.getBootstrap().tasks.find((task) => task.id === run.taskId).deletionBlockedBy, "active_inquiries");
  assert.equal(store.getRunWorkspace(run.id).run.task.deletionBlockedBy, "active_inquiries");
  assert.throws(() => store.deleteTask(run.taskId), /未结束答疑/);
  assert.equal(store.getRun(run.id).status, "completed");
  assert.equal(store.listDispatches(run.id).find((item) => item.messageIds.includes(inquiry.message.id)).status, "queued");
  store.cancelInquiries(run.id);
  assert.equal(store.getBootstrap().tasks.find((task) => task.id === run.taskId).deletionBlockedBy, null);
  assert.deepEqual(store.deleteTask(run.taskId).runIds, [run.id]);
  assert.throws(() => store.getTask(run.taskId), /任务不存在/);
});
test("human acceptance is guarded, new work invalidates review, and archived messages are rejected", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  assert.throws(() => store.confirmRunCompletion(run.id), /验收阶段/);
  store.updateRun(run.id, { status: "review" }); store.setTaskStatus(run.taskId, "review");
  store.updateRun(run.id, { status: "awaiting_acceptance", deliveryReview: { verdict: "pass", findings: ["证据"] } }); store.setTaskStatus(run.taskId, "awaiting_acceptance");
  store.submitHumanMessage(run.id, { content: "补充要求", recipientAgentId: run.manager.id });
  assert.equal(store.getRun(run.id).status, "running"); assert.equal(store.getRun(run.id).deliveryReview, null);
  assert.throws(() => store.confirmRunCompletion(run.id), /验收阶段/);
  store.completeDispatch(store.claimDispatch(run.id).id);
  store.updateRun(run.id, { status: "review" }); store.setTaskStatus(run.taskId, "review");
  store.updateRun(run.id, { status: "awaiting_acceptance", deliveryReview: { verdict: "pass", findings: ["新证据"] } }); store.setTaskStatus(run.taskId, "awaiting_acceptance");
  const trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.completeTrace(trace.id);
  store.confirmRunCompletion(run.id);
  const message = store.submitHumanMessage(run.id, { content: "为什么这样设计？", recipientAgentId: run.manager.id });
  assert.equal(message.interactionOnly, true); assert.equal(store.getRun(run.id).status, "completed");
  assert.throws(() => store.archiveTask(run.taskId), /未结束协作/);
  store.completeDispatch(store.claimDispatch(run.id).id);
  store.archiveTask(run.taskId);
  assert.throws(() => store.submitHumanMessage(run.id, { content: "归档禁止", recipientAgentId: run.manager.id }), /归档/);
});

test("human confirmation finalizes the terminal summary and clears obsolete collaboration focus", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running", summary: "等待项目经理交付复核。" });
  store.setTaskStatus(run.taskId, "running");
  store.setCurrentFocus(run.id, "requirements", "正在等待需求职责交付。");

  assert.throws(() => store.confirmRunCompletion(run.id), /验收阶段/);
  assert.equal(store.getRun(run.id).summary, "等待项目经理交付复核。");
  assert.equal(store.getRun(run.id).currentFocus.nodeId, "requirements");

  store.updateRun(run.id, { status: "review" });
  store.setTaskStatus(run.taskId, "review");
  store.updateRun(run.id, { status: "awaiting_acceptance", deliveryReview: { verdict: "pass", findings: ["证据已核验"] } });
  store.setTaskStatus(run.taskId, "awaiting_acceptance");

  const confirmed = store.confirmRunCompletion(run.id);
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.summary, "人类已验收并确认任务完成。");
  assert.equal(confirmed.currentFocus, null);
  assert.equal(store.getTask(run.taskId).status, "done");
});

test("paused inquiry resumes its own nested consultation without claiming business work", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  store.updateRun(run.id, { status: "running" }); store.initializeDispatches(run.id); store.pauseRun(run.id);
  store.submitHumanMessage(run.id, { content: "解释设计", recipientAgentId: run.manager.id });
  const inquiry = store.claimDispatch(run.id); assert.equal(inquiry.purpose, "inquiry");
  const q = store.askQuestion(inquiry.id, { audience: "agent", recipientAgentId: "agent_analyst", question: "口径？", questionType: "需求", routingReason: "负责口径", consideredMemberIds: ["agent_analyst"] }, null);
  const child = store.claimDispatch(run.id); assert.equal(child.interactionOnly, true);
  store.answerQuestion(run.id, q.id, "口径明确", { type: "agent", id: "agent_analyst", name: "分析师" }); store.completeDispatch(child.id);
  assert.equal(store.claimDispatch(run.id).id, inquiry.id); store.completeDispatch(inquiry.id);
  assert.equal(store.claimDispatch(run.id), null); assert.equal(store.getRun(run.id).status, "paused");
  store.submitHumanMessage(run.id, { content: "停止答疑测试", recipientAgentId: run.manager.id });
  const stopped = store.claimDispatch(run.id); store.cancelInquiries(run.id);
  store.retryDispatch(stopped.id, "被终止的调用不能重试", 0);
  assert.equal(store.getDispatch(stopped.id).status, "cancelled"); assert.equal(store.claimDispatch(run.id), null);
});

test("unmatched defect IDs do not reject a node handoff", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id), trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" }); store.acceptNodeResult(run.id, "requirements", trace.id, result({ resolvesDefectIds: ["invented"] })); assert.equal(store.getRunWorkspace(run.id).defects.length, 0);
});
test("a testing node can report a Defect without a Markdown file", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id), trace = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  const defect = (evidenceArtifactIds = []) => ({ title: "登录校验失败", description: "回归测试失败", severity: "high", reproduction: ["提交空密码"], evidenceArtifactIds, affectedNodeIds: ["requirements"] });
  const artifact = (name) => ({ name, storagePath: `runs/${run.id}/traces/${trace.id}/workspace/${name}`, sha256: "a".repeat(64), bytes: 24, mediaType: "text/plain" });
  store.acceptNodeResult(run.id, "requirements", trace.id, result({ defects: [defect()] }));
  const workspace = store.getRunWorkspace(run.id);
  assert.equal(workspace.artifacts.length, 0);
  assert.deepEqual(workspace.defects[0].evidenceArtifactIds, []);
  assert.equal(workspace.defects[0].traceId, trace.id);
});
test("Defect audit facts cannot be directly edited while verified Traces close them", () => {
  const store = createStore(), run = store.createRun(fixtureTaskInput(store).id);
  const artifact = (trace, name) => ({ name, storagePath: `runs/${run.id}/traces/${trace.id}/workspace/${name}`, sha256: "b".repeat(64), bytes: 24, mediaType: "text/markdown" });
  const discovery = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: "agent_analyst" });
  store.acceptNodeResult(run.id, "requirements", discovery.id, result({ defects: [{ title: "输入校验缺失", description: "空输入没有被拒绝", severity: "high", reproduction: ["提交空值"], evidenceArtifactIds: [], affectedNodeIds: ["requirements"] }] }), [artifact(discovery, "docs/requirements/input-validation.md")]);
  store.completeTrace(discovery.id);
  const [defect] = store.listDefects(run.id), before = structuredClone(defect);
  assert.throws(() => store.updateDefect(run.id, defect.id, { status: "closed" }), /Trace-bound 审计事实/);
  assert.throws(() => store.updateDefect(run.id, defect.id, { evidenceArtifactIds: [] }), /Trace-bound 审计事实/);
  assert.deepEqual(store.listDefects(run.id), [before]);
  const fix = store.createTrace(run.id, { workflowNodeId: "bug_fix", agentId: "agent_engineer" });
  store.acceptNodeResult(run.id, "bug_fix", fix.id, result({ resolvesDefectIds: [defect.id] }), [artifact(fix, "docs/development/fix.md")]);
  store.completeTrace(fix.id);
  assert.equal(store.listDefects(run.id)[0].status, "fixed");
  assert.equal(store.canCompleteRun(run.id), true);
  const regression = store.createTrace(run.id, { workflowNodeId: "regression", agentId: "agent_tester" });
  store.acceptNodeResult(run.id, "regression", regression.id, result({ verifiedDefectIds: [defect.id] }), [artifact(regression, "docs/testing/regression.md")]);
  store.completeTrace(regression.id);
  assert.equal(store.listDefects(run.id)[0].status, "closed");
  assert.equal(store.canCompleteRun(run.id), true);
});
test("task properties render safe recorded facts independently of the active tab", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function workspaceDirectoryDetails("), end = source.indexOf("\nfunction renderWorkspace()", start);
  assert.ok(start >= 0 && end > start);
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const risk = '<section aria-label="记录的质量风险">同 Trace 证据</section>';
  const details = new Function("esc", "workflowDiagramCanvas", "qualityRiskMarkup", `${source.slice(start, end)}; return workspaceDetailsMarkup;`)(esc, () => '<div class="workflow-diagram">职责图</div>', () => risk);
  const workspace = { run: { id: "run_test", task: { objective: '<script>bad()</script>', workspacePath: '/tmp/" onclick="bad()', team: { name: "A&B" }, workflowSnapshot: { name: "审批流程" } } } };
  for (const tab of ["collaboration", "artifacts", "directory", "console"]) {
    const markup = details(workspace, { agents: [{ id: "a" }], currentFocusNode: { title: "核验交付" }, view: { tab, disclosures: { brief: true } }, artifactCount: 2 });
    assert.match(markup, /^<aside[^>]+aria-label="任务详情"/);
    assert.match(markup, /A&amp;B/);
    assert.match(markup, /核验交付/);
    assert.match(markup, /<dd>2 项<\/dd>/);
    assert.ok(markup.includes(risk));
    assert.match(markup, /任务描述/);
    assert.doesNotMatch(markup, /目录说明|任务说明|data-toggle-task-description/);
    assert.doesNotMatch(markup, /<script>|data-copy="[^"]*" onclick=|role="tabpanel"/);
    assert.match(markup, /aria-label="任务详情" hidden/);
    assert.match(details(workspace, { agents: [], view: { detailsOpen: true, disclosures: {} }, artifactCount: 0 }), /aria-label="任务详情" >/);
  }
  const longTask = { ...workspace.run.task, objective: "字".repeat(100) + "尾部😀", taskWorkspacePath: "/tmp/task_one", workspacePath: "/tmp/task_one/run_one" };
  const longWorkspace = { run: { id: "run_one", task: longTask } };
  const collapsed = details(longWorkspace, { agents: [], view: {}, artifactCount: 0 });
  assert.match(collapsed, /字…/);
  assert.doesNotMatch(collapsed, /尾部😀/);
  assert.match(collapsed, /<span>task_one\/run_one<\/span>/);
  assert.match(collapsed, /data-copy="\/tmp\/task_one\/run_one"/);
  assert.match(collapsed, /aria-expanded="false" aria-controls="task-description-content">展开/);
  const expanded = details(longWorkspace, { agents: [], view: { descriptionExpanded: true }, artifactCount: 0 });
  assert.match(expanded, /尾部😀/);
  assert.match(expanded, /aria-expanded="true" aria-controls="task-description-content">收起/);
  const legacy = details({ run: { id: "legacy", task: { objective: "旧任务", workspacePath: "/tmp/legacy", workflowSnapshot: {} } } }, { agents: [], view: { disclosures: {} }, artifactCount: 0 });
  assert.match(legacy, /当前团队/);
  assert.match(legacy, /暂无指定重心/);
  assert.match(legacy, /<dd>0 项<\/dd>/);
  assert.doesNotMatch(legacy, /data-workspace-disclosure="brief" open|undefined/);
});
test("quality risk ledger exposes trace-bound Defect evidence without unsafe markup", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const DEFECT_STATUS_TEXT"), end = source.indexOf("\n\nfunction renderCollaboration", start);
  assert.ok(start >= 0 && end > start);
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const qualityRiskMarkup = new Function("esc", `${source.slice(start, end)}; return qualityRiskMarkup;`)(esc);
  const markup = qualityRiskMarkup({
    run: { task: { workflowSnapshot: { nodes: [{ id: "testing", title: "质量验证" }] } } },
    artifacts: [{ id: "artifact_evidence", name: "docs/testing/failure.md", traceId: "trace_evidence", storagePath: "runs/trace_evidence/failure.md", deleted: false }],
    defects: [
      { id: "defect_open", status: "open", severity: "high", title: "<script>unsafe</script>", description: "登录失败", reproduction: ["提交空密码"], evidenceArtifactIds: ["artifact_evidence"], affectedNodeIds: ["testing"], traceId: "trace_evidence" },
      { id: "defect_closed", status: "closed", severity: "low", title: "历史问题", evidenceArtifactIds: ["missing_artifact"], affectedNodeIds: [], traceId: "trace_closed" }
    ]
  });
  assert.match(markup, /质量风险/);
  assert.match(markup, /1 个待处理 Defect/);
  assert.match(markup, /已记录文件：docs\/testing\/failure.md/);
  assert.doesNotMatch(markup, /data-open-defect-evidence/);
  assert.match(markup, /data-open-collaboration-trace="trace_evidence"/);
  assert.match(markup, /证据快照暂不可读取/);
  assert.doesNotMatch(markup, /<script>unsafe<\/script>/);
  assert.doesNotMatch(source, /workspaceView\(\)\.tab = "artifacts"/);
  assert.match(source, /来源 Trace 在当前 Run 中不可读取/);
});
test("a Provider-reported Defect without Markdown evidence is recorded for coordination", async () => {
  const root = await directory("agentforge-defect-evidence-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
const open = prompt.split("开放 Defect：")[1]?.match(/"id":"(defect_[^"]+)"/);
if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: open || !prompt.includes('"workflowNodeId":"requirements","type":"node","status":"completed"') ? "requirements" : null, rationale: "按节点报告继续流程" };
else if (open) out.verifiedDefectIds = [open[1]];
else { out.defects = [{ title: "无证据缺陷", description: "没有写入报告", severity: "high", reproduction: ["运行测试"], evidenceArtifactIds: [], affectedNodeIds: ["requirements"] }]; }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, title: "缺陷证据端到端", workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id), nodeTrace = workspace.traces.find((trace) => trace.type === "node");
    assert.equal(nodeTrace.status, "completed");
    assert.equal(workspace.artifacts.length, 0);
    assert.equal(workspace.defects.length, 1);
    assert.equal(workspace.defects[0].status, "closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a business Provider handoff without a captured Artifact is recorded", async () => {
  const root = await directory("agentforge-artifact-required-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "没有实际文件的交付声明", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入足够", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: "requirements", rationale: "先完成需求交付" };
else out.artifacts = [{ path: "docs/requirements/claimed.md", description: "此文件没有被写入" }];
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, title: "空交付不得验收", workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id), nodeTrace = workspace.traces.find((trace) => trace.type === "node");
    assert.equal(nodeTrace.status, "completed");
    assert.equal(workspace.artifacts.length, 0);
    assert.equal(workspace.events.some(event => event.type === "trace.accepted"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("an employee result with custom report fields is recorded without rejection", async () => {
  const root = await directory("agentforge-node-result-schema-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: "requirements", rationale: "先验证本地输出" };
else { mkdirSync("docs/requirements", { recursive: true }); writeFileSync("docs/requirements/invalid-result.md", "# retained local file\\n"); out.decisions = [{ summary: "不应成为事实", impact: "unknown", affectedNodeIds: ["requirements"], rationale: "非法枚举" }]; }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, title: "结构化结果必须可验收", workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id), nodeTrace = workspace.traces.find((trace) => trace.type === "node");
    assert.equal(nodeTrace.status, "completed");
    assert.ok(workspace.decisions.some(item => item.impact === "unknown"));
    assert.ok(workspace.artifacts.length > 0);
    assert.equal(workspace.events.some(event => event.type === "dispatch.escalated"), false);
    assert.equal(await readFile(join(root, "docs", "requirements", "invalid-result.md"), "utf8"), "# retained local file\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("legacy snapshots drop node state and reflection-agent fields while keeping facts", async () => {
  const path = join(await directory("agentforge-legacy-"), "legacy.sqlite"); try { createSqlitePersistence(path).save({ agents: [], teams: [], tasks: [{ id: "task", workspacePath: process.cwd(), workflowTemplateId: "software_delivery", workflowSnapshot: { id: "software_delivery", name: "legacy", nodes: [{ id: "requirements", title: "需求", ownerRole: "需求分析师", dependsOn: [] }] }, managerRuntime: { provider: "codex" }, reflectionRuntime: { provider: "codex" }, status: "backlog" }], workflowTemplates: [{ id: "software_delivery", name: "legacy", nodes: [{ id: "requirements", title: "需求", ownerRole: "需求分析师", dependsOn: [] }] }], runs: [{ id: "run", taskId: "task", status: "completed", nodeStates: { requirements: "completed" }, reflectionAgent: { id: "system_reflection_agent" }, steps: [{ id: "step", nodeId: "requirements", ownerAgentId: "agent_analyst", status: "completed" }] }], artifacts: [{ id: "artifact", runId: "run", stepId: "step" }], messages: [], issues: [], decisions: [], events: [] }); const snapshot = createStore({ databasePath: path }).snapshot(); assert.equal("nodeStates" in snapshot.runs[0], false); assert.equal("reflectionAgent" in snapshot.runs[0], false); assert.equal(snapshot.traces[0].legacy, true); assert.equal(snapshot.agents.every((agent) => agent.runtime.provider === "claude-code"), true); } finally { await rm(join(path, ".."), { recursive: true, force: true }); } });
test("Run files keep real Trace and workspace files", async () => { const root = await directory("agentforge-files-"); try { const files = createRunFiles({ root }); await writeFile(join(root, "source.js"), "export const version = 2;\n"); const before = new Map(); const changed = await files.captureWorkspaceChanges({ runId: "run", traceId: "trace", workspacePath: root, before }); assert.match(changed.artifacts[0].storagePath, /traces\/trace\/workspace/); } finally { await rm(root, { recursive: true, force: true }); } });
test("Artifact previews verify the captured snapshot before returning content", async () => { const root = await directory("agentforge-artifact-read-"), outside = await mkdtemp(join(tmpdir(), "agentforge-artifact-outside-")); try { const files = createRunFiles({ root }); const storagePath = "runs/run/traces/trace/workspace/docs/report.md", artifact = join(root, "runs", "run", "traces", "trace", "workspace", "docs", "report.md"), original = "# Report\n", expected = { bytes: Buffer.byteLength(original), sha256: createHash("sha256").update(original).digest("hex") }; await mkdir(join(root, "runs", "run", "traces", "trace", "workspace", "docs"), { recursive: true }); await writeFile(artifact, original); assert.equal((await files.readArtifact(storagePath, { expected })).content, original); assert.deepEqual(await files.readArtifactBytes(storagePath, { expected }), Buffer.from(original)); await assert.rejects(files.readArtifactBytes(storagePath, 1), /产物大于 1 字节/); const tampered = "# Alter!\n"; assert.equal(Buffer.byteLength(tampered), expected.bytes); await writeFile(artifact, tampered); await assert.rejects(files.readArtifact(storagePath, { expected }), /完整性校验失败/); await assert.rejects(files.readArtifactBytes(storagePath, { expected }), /完整性校验失败/); await assert.rejects(files.readArtifact(storagePath, { expected: { bytes: expected.bytes, sha256: "not-a-sha" } }), /完整性无法验证/); await writeFile(join(outside, "secret.txt"), "OUTSIDE_ARTIFACT_SENTINEL"); await rm(artifact); await symlink(join(outside, "secret.txt"), artifact); await assert.rejects(files.readArtifact(storagePath, { expected }), /符号链接/); await assert.rejects(files.readArtifactBytes(storagePath, { expected }), /符号链接/); await rm(artifact); await rm(join(root, "runs", "run", "traces", "trace", "workspace"), { recursive: true, force: true }); await mkdir(join(outside, "docs"), { recursive: true }); await writeFile(join(outside, "docs", "report.md"), "OUTSIDE_ARTIFACT_SENTINEL"); await symlink(outside, join(root, "runs", "run", "traces", "trace", "workspace")); await assert.rejects(files.readArtifact(storagePath, { expected }), /符号链接/); } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } });

test("Artifact verification streams legal files above preview size and rejects changed snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-artifact-verify-"));
  try {
    const files = createRunFiles({ root });
    const storagePath = "runs/run/traces/trace/workspace/docs/large.md";
    const path = join(root, storagePath);
    await mkdir(join(root, "runs/run/traces/trace/workspace/docs"), { recursive: true });
    for (const size of [524288, 524289, 20 * 1024 * 1024]) {
      const content = Buffer.alloc(size, 65);
      await writeFile(path, content);
      const expected = { bytes: size, sha256: createHash("sha256").update(content).digest("hex") };
      assert.deepEqual(await files.verifyArtifact(storagePath, { expected }), { bytes: size });
      if (size === 524289) await assert.rejects(files.readArtifact(storagePath, { expected }), /产物大于 524288 字节/);
      await writeFile(path, Buffer.alloc(size, 66));
      await assert.rejects(files.verifyArtifact(storagePath, { expected }), /完整性校验失败/);
    }
    await writeFile(path, Buffer.alloc(20 * 1024 * 1024 + 1, 65));
    await assert.rejects(files.verifyArtifact(storagePath, { expected: { bytes: 20 * 1024 * 1024 + 1, sha256: "a".repeat(64) } }), /产物大于 20971520 字节/);
    await rm(path);
    await symlink(join(root, "outside.txt"), path);
    await assert.rejects(files.verifyArtifact(storagePath, { expected: { bytes: 1, sha256: "a".repeat(64) } }), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("product Artifact capture excludes workspace files outside docs and sensitive entries inside business roots", async () => { const root = await directory("agentforge-product-files-"); try { const files = createRunFiles({ root: join(root, "run-files") }); await mkdir(join(root, "docs", "testing"), { recursive: true }); await mkdir(join(root, "repos", "app"), { recursive: true }); for (const path of ["docs/.env", "docs/credentials.json", "repos/app/deploy.key", "repos/app/id_rsa"]) await writeFile(join(root, path), "QUALITY_SENTINEL_SECRET"); const before = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] }); await writeFile(join(root, "docs", "testing", "report.md"), "# report\n"); await writeFile(join(root, "scratch.txt"), "not a product artifact\n"); const changed = await files.captureWorkspaceChanges({ runId: "run", traceId: "trace", workspacePath: root, before, includeRoots: ["docs", "repos"], allowedRoots: ["docs/testing/", "repos/app"] }); assert.deepEqual(changed.artifacts.map((item) => item.name), ["docs/testing/report.md"]); assert.deepEqual([...changed.after.keys()], ["docs/testing/report.md"]); assert.doesNotMatch(JSON.stringify(changed), /QUALITY_SENTINEL_SECRET|\.env|credentials\.json|deploy\.key|id_rsa/); const beforeScope = await files.snapshotWorkspace(root, { includeRoots: ["docs", "repos"] }); await mkdir(join(root, "docs", "other"), { recursive: true }); await writeFile(join(root, "docs", "other", "outside.md"), "must not be accepted\n"); await assert.rejects(files.captureWorkspaceChanges({ runId: "run", traceId: "rejected", workspacePath: root, before: beforeScope, includeRoots: ["docs", "repos"], allowedRoots: ["docs/testing/"] }), /越界变更.*docs\/other\/outside\.md/); } finally { await rm(root, { recursive: true, force: true }); } });
test("repository tree exposes regular source while rejecting sensitive entries and symlink paths", async () => { const root = await directory("agentforge-tree-"), outside = await mkdtemp(join(tmpdir(), "agentforge-tree-outside-")); try { const files = createRunFiles({ root }); await mkdir(join(root, "repos", "app", "src"), { recursive: true }); await writeFile(join(root, "repos", "app", "src", "login.js"), "export const login = true;\n"); for (const name of [".env", "credentials.json", "deploy.key", "id_rsa"]) await writeFile(join(root, "repos", "app", name), "test-only"); const serialized = JSON.stringify(await files.listRepositoryTree(root, "repos/app")); assert.match(serialized, /login\.js/); assert.doesNotMatch(serialized, /\.env|credentials\.json|deploy\.key|id_rsa/); await assert.rejects(files.listRepositoryTree(root, "repos/app/../other"), /代码仓库路径/); await writeFile(join(outside, "outside-only.txt"), "not a task repository"); await rm(join(root, "repos", "app"), { recursive: true, force: true }); await symlink(outside, join(root, "repos", "app")); await assert.rejects(files.listRepositoryTree(root, "repos/app"), /符号链接/); await rm(join(root, "repos", "app"), { recursive: true, force: true }); await rm(join(root, "repos"), { recursive: true, force: true }); await symlink(outside, join(root, "repos")); await assert.rejects(files.listRepositoryTree(root, "repos/app"), /符号链接/); } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); } });
test("project manager routes employee work and directly hands off to the human", async () => {
  const root = await directory("agentforge-runtime-"); try { const executable = join(root, "provider.mjs"); await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const isTesting = prompt.includes('"purpose":"node"') && prompt.includes('"workflowNodeId":"testing"');
if (!isTesting) writeFileSync("provider-cwd.txt", process.cwd());
const args = process.argv.slice(2), sessionFlag = args.findIndex((item) => item === "--session-id" || item === "--resume"), sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : null;
const reviewCriteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const reviewEvidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
if (!prompt.includes('任务级项目经理') && !prompt.includes('任务验收标准：["验收口径必须进入项目经理复核"]')) throw new Error("冻结的验收标准未传入 Provider 提示词");
const out = { kind: "node_result", summary: "真实交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入足够", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "verify", findings: ["真实 Trace 已验收"] };
else if (prompt.includes("任务级项目经理")) { out.managerDecision = { nextNodeId: prompt.includes("独立验证完成") ? null : prompt.includes('"type":"node"') ? "testing" : "verify", rationale: "依据 Trace 决定" }; out.decisions = [{ summary: "保留追加验收标准", impact: "amendment", affectedNodeIds: ["verify"], rationale: "人类消息" }]; }
else { if (!prompt.includes("deliveryReview 必须为 null")) throw new Error("普通职责提示缺少最终复核边界"); if (isTesting) { mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/testing/review.md", "# Fixture independent testing report"); out.summary = "独立验证完成"; } }
if (sessionId) console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "RUNTIME_AUDIT_SENTINEL /private/model-output" }] } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "audit-tool", name: "Bash", input: { command: "cat /private/RUNTIME_TOOL_INPUT" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "audit-tool", content: "RUNTIME_TOOL_OUTPUT" }] } }));
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    const tester = store.createAgent({ name: "测试", role: "测试工程师", kind: "developer", repository: { url: "https://example.test/app.git", ref: "main" }, runtime: { provider: "claude-code", executable } });
    const reviewer = store.createAgent({ name: "独立验证", runtime: { provider: "claude-code", executable } });
    const team = store.createTeam({ name: "团队", memberAgentIds: [tester.id, reviewer.id] });
    const flow = store.createWorkflowTemplate({ name: "开发与测试", nodes: [{ id: "verify", title: "开发", staffingGuidance: "研发工程师", dependsOn: [] }, { id: "testing", title: "独立测试", staffingGuidance: "非作者验证", artifactPaths: ["docs/testing/"], dependsOn: [] }] });
    const task = store.createTask({ title: "真实运行", objective: "验证 Trace", acceptanceCriteria: ["验收口径必须进入项目经理复核"], workspacePath: root, teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { verify: tester.id, testing: reviewer.id }, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id);
    assert.equal(workspace.run.status, "awaiting_acceptance", workspace.run.error);
    assert.equal(workspace.run.task.status, "awaiting_acceptance");
    assert.equal(workspace.events.some(event => event.type === "run.completed"), false);
    const accepted = workspace.events.filter(event => event.type === "trace.accepted");
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].message, "已记录员工交接。");
    assert.ok(workspace.traces.some(trace => trace.id === accepted[0].data.traceId && trace.type === "node"));
    assert.equal(workspace.traces.some((trace) => trace.type === "delivery_review"), false);
    assert.ok(workspace.run.acceptanceRequest.traceId);
    assert.ok(workspace.artifacts.some((artifact) => artifact.name === "docs/testing/review.md"));
    const runtimeEvents = workspace.events.filter((event) => event.type === "runtime.event");
    const traceAudits = await Promise.all(workspace.traces.map((trace) => readFile(join(root, "run-files", "runs", run.id, "traces", trace.id, "events.ndjson"), "utf8")));
    const auditText = [JSON.stringify(runtimeEvents), ...traceAudits].join("\n");
    assert.match(auditText, /已请求本机工具/);
    assert.doesNotMatch(auditText, /RUNTIME_AUDIT_SENTINEL|RUNTIME_TOOL_INPUT|RUNTIME_TOOL_OUTPUT|\/private\/|sessionId/);
    store.confirmRunCompletion(run.id);
    assert.equal(store.getRun(run.id).confirmedBy, "human_operator");
    const humanCompletion = store.getRunWorkspace(run.id).events.find(event => event.type === "run.completed");
    assert.equal(humanCompletion.message, "人类已验收并确认任务完成。");
    assert.equal(humanCompletion.actor.type, "human");
    assert.equal(await readFile(join(root, "repos", "app", "provider-cwd.txt"), "utf8"), await realpath(join(root, "repos", "app")));
    assert.ok(workspace.artifacts.some((artifact) => artifact.name === "repos/app/provider-cwd.txt"));
    assert.equal("reflectionAgent" in workspace.run, false);
    assert.ok(workspace.decisions.some(item => item.summary === "保留追加验收标准"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("agent consultation immediately invokes the recipient instead of waiting for patrol", async () => {
  const root = await directory("agentforge-consultation-"); try {
    const store = createStore();
    const analyst = store.createAgent({ name: "需求", role: "需求分析师", runtime: { provider: "claude-code", executable: join(root, "provider.mjs") } });
    const architect = store.createAgent({ name: "架构", role: "系统架构师", runtime: { provider: "claude-code", executable: join(root, "provider.mjs") } });
    const executable = join(root, "provider.mjs"); await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const reviewCriteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const reviewEvidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
const out = { kind: "node_result", summary: "真实交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入足够", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "architecture", findings: ["咨询答复已纳入复核"] };
else if (prompt.includes("你正回答角色咨询")) { out.summary = "需求口径确认：token 仅内存，成功后停留当前页。"; }
else if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "architecture", rationale: "按咨询事实路由" };
else if (prompt.includes("token 仅内存，成功后停留当前页")) { mkdirSync("docs/architecture", { recursive: true }); mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/architecture/token-policy.md", "# Token policy\\n仅内存保存。"); writeFileSync("docs/testing/review.md", "# Fixture testing report"); out.summary = "架构师已将咨询结论落实到交付。"; }
else out.consultation = { audience: "agent", recipientAgentId: "${analyst.id}", question: "请确认 token 与成功页口径", questionType: "业务口径", routingReason: "该成员负责需求定义", consideredMemberIds: ["${analyst.id}"] };
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`); await chmod(executable, 0o755);
    const team = store.createTeam({ name: "咨询团队", memberAgentIds: [analyst.id, architect.id] });
    const flow = store.createWorkflowTemplate({ name: "咨询流程", nodes: [{ id: "architecture", title: "架构", staffingGuidance: "系统架构师", artifactPaths: ["docs/architecture/", "docs/testing/"], dependsOn: [] }] });
    const task = store.createTask({ title: "咨询续跑", objective: "验证立即答复", workspacePath: root, teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { architecture: architect.id }, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id); await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") }); const workspace = store.getRunWorkspace(run.id);
    assert.equal(workspace.run.status, "awaiting_acceptance"); store.confirmRunCompletion(run.id); assert.equal(store.getRun(run.id).status, "completed"); assert.equal(workspace.run.waitingAgentId, null); assert.ok(workspace.messages.some((message) => message.kind === "agent_consultation")); assert.ok(workspace.messages.some((message) => message.kind === "consultation_answer")); assert.ok(workspace.traces.some((trace) => trace.type === "consultation" && trace.status === "completed")); assert.equal(workspace.traces.filter((trace) => trace.workflowNodeId === "architecture" && trace.type === "node").length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("human retry now resumes a backoff Run without discarding its failed Trace", async () => {
  const root = await directory("agentforge-retry-now-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const attemptsPath = new URL("./provider-attempts.txt", import.meta.url);
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) : 0;
writeFileSync(attemptsPath, String(attempt + 1));
if (attempt === 0) { console.error("API Error: 503 QUALITY_SENTINEL_PROVIDER_FAILURE token=QUALITY_SENTINEL_TOKEN"); process.exit(1); }
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const reviewCriteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const reviewEvidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
const out = { kind: "node_result", summary: "重试后的真实交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入足够", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "verify", findings: ["重试后的 Trace 已验收"] };
else if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "verify", rationale: "失败事实已保留，现可进入复核" };
else { mkdirSync("docs/verify", { recursive: true }); mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/verify/retry.md", "# Retry evidence"); writeFileSync("docs/testing/review.md", "# Fixture testing report"); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    const tester = store.createAgent({ name: "验证", role: "验证工程师", runtime: { provider: "claude-code", executable } });
    const team = store.createTeam({ name: "重试团队", memberAgentIds: [tester.id] });
    const flow = store.createWorkflowTemplate({ name: "重试流程", nodes: [{ id: "verify", title: "验证", staffingGuidance: "验证工程师", artifactPaths: ["docs/verify/", "docs/testing/"], dependsOn: [] }] });
    const task = store.createTask({ title: "人工立即重试", objective: "保留失败事实并继续", workspacePath: root, teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { verify: tester.id }, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const waiting = store.getRunWorkspace(run.id), failedTrace = waiting.traces.find((trace) => trace.status === "failed"), waitingDispatch = waiting.dispatches.find((item) => item.nextRetryAt);
    assert.equal(waiting.run.status, "running");
    assert.ok(failedTrace); assert.ok(waitingDispatch?.nextRetryAt);
    assert.match(failedTrace.error, /API Error: 503 QUALITY_SENTINEL_PROVIDER_FAILURE/);
    assert.equal(waitingDispatch.lastError, failedTrace.error);
    assert.ok(waiting.events.some((event) => event.type === "trace.failed" && event.data.traceId === failedTrace.id && event.data.auditVersion === 2 && event.data.failureKind === "provider"));
    assert.doesNotMatch(JSON.stringify(waiting), /QUALITY_SENTINEL_TOKEN/);
    assert.doesNotMatch(await readFile(join(root, "run-files", "runs", run.id, "traces", failedTrace.id, "events.ndjson"), "utf8"), /QUALITY_SENTINEL_PROVIDER_FAILURE|QUALITY_SENTINEL_TOKEN/);
    const retry = store.retryScheduledDispatches(run.id);
    assert.deepEqual(retry.dispatchIds, [waitingDispatch.id]);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const completed = store.getRunWorkspace(run.id);
    assert.equal(completed.run.status, "awaiting_acceptance", completed.run.error);
    assert.equal(completed.traces.find((trace) => trace.id === failedTrace.id).status, "failed");
    assert.ok(completed.events.some((event) => event.type === "dispatch.retry_requested"));
    store.confirmRunCompletion(run.id);
    assert.equal(store.getRun(run.id).status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("failed business writes survive restart and become accepted Artifacts on retry", async () => {
  const root = await directory("agentforge-failed-write-retry-");
  try {
    const executable = join(root, "provider.mjs"), databasePath = join(root, ".agentforge/state.sqlite"), runFilesRoot = join(root, "run-files");
    await writeFile(executable, `#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "", findings: ["源码和测试已接纳"] };
else if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "develop", nextAgentId: null, rationale: "按交付事实路由" };
else if (!existsSync(".agentforge/first-attempt-marker")) {
  writeFileSync(".agentforge/first-attempt-marker", "failed");
  mkdirSync("docs/development/src", { recursive: true }); mkdirSync("docs/development/test", { recursive: true });
  writeFileSync("docs/development/src/main.js", "export const answer = 42;\\n");
  writeFileSync("docs/development/test/main.test.js", "assert.equal(answer, 42);\\n");
  rmSync("docs/development/obsolete.md");
  console.error('API Error: 503 temporarily unavailable');
  process.exit(1);
} else { mkdirSync("docs/development", { recursive: true }); writeFileSync("docs/development/src/main.js", "export const answer = 43;\\n"); writeFileSync("docs/development/report.md", "# Retried delivery\\n"); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    await mkdir(join(root, "docs/development"), { recursive: true });
    await writeFile(join(root, "docs/development/obsolete.md"), "# Remove me\n");
    let store = createStore({ databasePath });
    const developer = store.createAgent({ name: "开发", runtime: { provider: "claude-code", executable } });
    const team = store.createTeam({ name: "失败重试团队", memberAgentIds: [developer.id] });
    const flow = store.createWorkflowTemplate({ name: "失败重试流程", nodes: [{ id: "develop", title: "开发", staffingGuidance: "开发", artifactPaths: ["docs/development/"], dependsOn: [] }] });
    const task = store.createTask({ title: "失败写入后重试", objective: "源码和测试均应接纳", workspacePath: root, teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { develop: developer.id }, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot });
    const first = store.getRunWorkspace(run.id), failed = first.traces.find((trace) => trace.type === "node" && trace.status === "failed");
    assert.ok(failed);
    assert.equal(first.artifacts.length, 0);
    assert.equal(await readFile(join(root, "docs/development/src/main.js"), "utf8"), "export const answer = 42;\n");
    store.close();
    store = createStore({ databasePath });
    store.retryScheduledDispatches(run.id);
    await executeRun(store, run.id, { runFilesRoot });
    const retried = store.getRunWorkspace(run.id);
    assert.equal(retried.run.status, "awaiting_acceptance");
    assert.equal(retried.traces.find((trace) => trace.id === failed.id).status, "failed");
    assert.deepEqual(retried.artifacts.map((artifact) => artifact.name).sort(), ["docs/development/obsolete.md", "docs/development/report.md", "docs/development/src/main.js", "docs/development/test/main.test.js"]);
    assert.equal(retried.artifacts.find((artifact) => artifact.name === "docs/development/obsolete.md").deleted, true);
    assert.equal(await readFile(join(root, "docs/development/src/main.js"), "utf8"), "export const answer = 43;\n");
    for (const artifact of retried.artifacts) assert.equal(createHash("sha256").update(await readFile(join(runFilesRoot, artifact.storagePath))).digest("hex"), artifact.sha256);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("missing snapshot baseline does not block coordination or a manager handoff", async () => {
  const root = await directory("agentforge-missing-run-baseline-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",result:JSON.stringify({summary:"交人类验收",managerDecision:{nextNodeId:null,rationale:"经理安排"}})}));\n'.replaceAll('\\n', '\n'));
    await chmod(executable, 0o755);
    const store = createStore(), base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    store.updateRun(run.id, { status: "running" }); store.setTaskStatus(task.id, "running");
    const previous = store.createTrace(run.id, { workflowNodeId: "requirements", agentId: run.manager.id, type: "manager" });
    store.completeTrace(previous.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
    const workspace = store.getRunWorkspace(run.id);
    assert.equal(workspace.run.status, "awaiting_acceptance");
    assert.equal(workspace.traces.find(item => item.id === previous.id).status, "completed");
    assert.equal(workspace.events.some(item => item.type === "run.failed"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run workspace baseline survives restart and rejects uncovered or oversized changes", async () => {
  const root = await directory("agentforge-run-baseline-");
  try {
    const workspacePath = join(root, "workspace"), runFilesRoot = join(root, "audit"), runId = "run_baseline";
    await mkdir(join(workspacePath, "docs/development"), { recursive: true });
    await writeFile(join(workspacePath, "docs/development/source.js"), "export const before = 1;\n");
    let files = createRunFiles({ root: runFilesRoot });
    await files.prepareRun(runId);
    await assert.rejects(files.loadOrCreateWorkspaceBaseline(runId, workspacePath), /基线缺失/);
    const initial = await files.loadOrCreateWorkspaceBaseline(runId, workspacePath, { allowCreate: true });
    await writeFile(join(workspacePath, "docs/development/source.js"), "export const after = 2;\n");
    files = createRunFiles({ root: runFilesRoot });
    const persisted = await files.loadOrCreateWorkspaceBaseline(runId, workspacePath);
    assert.equal(persisted.get("docs/development/source.js").hash, initial.get("docs/development/source.js").hash);
    await assert.rejects(files.captureWorkspaceChanges({ runId, traceId: "review_uncovered", workspacePath, before: persisted, includeRoots: ["docs", "repos"], allowedRoots: [] }), /只能验收声明的 Artifact 路径/);
    const accepted = await files.captureWorkspaceChanges({ runId, traceId: "node_accepted", workspacePath, before: persisted, includeRoots: ["docs", "repos"], allowedRoots: ["docs/development/"] });
    assert.deepEqual(accepted.artifacts.map((item) => item.name), ["docs/development/source.js"]);
    await writeFile(join(workspacePath, "docs/development/oversized.bin"), Buffer.alloc(20 * 1024 * 1024 + 1));
    const oversized = await files.captureWorkspaceChanges({ runId, traceId: "node_oversized", workspacePath, before: persisted, includeRoots: ["docs", "repos"], allowedRoots: null });
    assert.deepEqual(oversized.artifacts.map((item) => item.name), ["docs/development/source.js"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("runtime preserves tool events and release guard", async () => { const root = await directory("agentforge-stream-"); try { const executable = join(root, "provider.mjs"); await writeFile(executable, "#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'x',name:'Read',input:{path:'a'}}]}})); console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'x',content:'ok'}]}})); console.log(JSON.stringify({type:'result',result:'{}'}));"); await chmod(executable, 0o755); const events = []; await runClaudeCodeCli({ runtime: { provider: "claude-code", executable, skillPaths: [], pluginPaths: [], mcpConfigPaths: [] }, workspacePath: root, traceDirectory: root, finalPath: join(root, "final.json"), outputSchema: { type: "object" }, prompt: "test", runId: "run", onEvent: async (event) => events.push(event) }); assert.equal(events.length, 3); } finally { await rm(root, { recursive: true, force: true }); } });
test("termination records Run and Trace cancellation facts without a false failure", async () => {
  const root = await directory("agentforge-cancel-");
  let store, run, execution, executionSettled = false, executionError;
  try {
    const executable = join(root, "slow.mjs"), readyPath = join(root, "provider-ready");
    await writeFile(executable, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(readyPath)}, "ready");\nsetInterval(() => {}, 1000);\n`);
    await chmod(executable, 0o755);
    store = createStore();
    const tester = store.createAgent({ name: "慢", role: "测试工程师", runtime: { provider: "claude-code", executable } });
    const team = store.createTeam({ name: "慢团队", memberAgentIds: [tester.id] });
    const flow = store.createWorkflowTemplate({ name: "慢流程", nodes: [{ id: "verify", title: "验证", staffingGuidance: "测试工程师", dependsOn: [] }] });
    const task = store.createTask({ title: "终止", objective: "验证", workspacePath: root, teamId: team.id, workflowTemplateId: flow.id, nodeAssignments: { verify: tester.id }, managerRuntime: { provider: "claude-code", executable } });
    run = store.createRun(task.id);
    execution = executeRun(store, run.id, { runFilesRoot: join(root, "files") });
    execution.then(() => { executionSettled = true; }, (error) => { executionSettled = true; executionError = error; });
    const readyDeadline = Date.now() + 10000;
    while (true) {
      if (executionSettled) throw new Error("Cancellation fixture finished before its child signalled ready", { cause: executionError });
      try { if (await readFile(readyPath, "utf8") === "ready") break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() >= readyDeadline) throw new Error("Cancellation fixture child did not signal ready within 10000ms");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    terminateRun(store, run.id, "测试终止");
    await assert.rejects(execution, /终止/);
    assert.equal(store.getRun(run.id).status, "cancelled");
    const workspace = store.getRunWorkspace(run.id);
    const cancelledTrace = workspace.traces.find((trace) => trace.status === "cancelled");
    const cancellation = workspace.events.find((event) => event.type === "run.cancelled");
    assert.ok(cancelledTrace);
    assert.ok(cancellation);
    assert.equal(cancellation.data.reason, "测试终止");
    assert.ok(cancellation.data.cancelledDispatchIds.includes(cancelledTrace.dispatchId));
    assert.deepEqual([...cancellation.data.cancelledDispatchIds].sort(), workspace.dispatches.filter((dispatch) => dispatch.status === "cancelled").map((dispatch) => dispatch.id).sort());
    assert.ok(workspace.events.some((event) => event.type === "trace.cancelled" && event.data.traceId === cancelledTrace.id));
    assert.equal(workspace.events.some((event) => event.type === "trace.failed" && event.data.traceId === cancelledTrace.id), false);
    assert.equal(workspace.events.some((event) => event.type === "dispatch.retry_scheduled"), false);
    assert.ok(store.getRunWorkspace(run.id, { summary: true }).events.some((event) => event.type === "run.cancelled"));
  } finally {
    if (execution && !executionSettled) terminateRun(store, run.id, "终止测试夹具清理");
    await execution?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
test("ELK yields non-overlapping dependency positions", async () => { const layout = await new ELK().layout({ id: "flow", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL" }, children: ["a", "b", "c"].map((id) => ({ id, width: 120, height: 64 })), edges: [{ id: "ab", sources: ["a"], targets: ["b"] }, { id: "bc", sources: ["b"], targets: ["c"] }] }); assert.equal(layout.children.length, 3); assert.ok(layout.edges.every((edge) => edge.sections?.[0]?.startPoint)); });
test("console and diagrams render the PM-owned current focus, not node lifecycle state", async () => { const [app, graphs, projections] = await Promise.all([readFile(new URL("../web/app.js", import.meta.url), "utf8"), readFile(new URL("../web/manual-graphs.mjs", import.meta.url), "utf8"), readFile(new URL("../client/console-projections.mjs", import.meta.url), "utf8")]); assert.match(app, /workflowFocus/); assert.match(projections, /trace\.agentId !== run\.manager\?\.id/); assert.match(graphs, /项目经理当前重心/); assert.match(graphs, /交接参考/); assert.match(graphs, /经理提交人类验收/); assert.doesNotMatch(app, /run\.nodeStates/); });
test("termination confirmation describes Run audit facts rather than invented node lifecycle", async () => { const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8"); assert.match(app, /将本次 Run 标记为已终止，并取消尚未完成的协作投递/); assert.match(app, /Trace、Artifact、消息与终止审计记录会保留/); assert.doesNotMatch(app, /所有未完成节点标记为已跳过/); });
test("collaboration responsibilities come from configured prompts, not role-name branches", async () => { const source = await readFile(new URL("../server/prompts.mjs", import.meta.url), "utf8"); assert.match(source, /agent.systemPrompt/); assert.match(source, /agent.capabilities/); assert.match(source, /consideredMemberIds/); assert.match(source, /consultationMode/); assert.doesNotMatch(source, /function roleGuidance|role === "需求分析师"/); });
test("workspace Artifact counts do not filter custom business paths by docs/repos prefixes", async () => { const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8"); assert.ok(!app.includes("/^(docs|repos)\\//")); assert.doesNotMatch(app, /历史兼容/); });
test("workspace shows current files and CHANGE while retaining documented Artifact history", async () => {
  const [app, artifactDoc] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/13-local-artifact-rendering.md", import.meta.url), "utf8")
  ]);
  assert.ok(app.indexOf('id="collaboration-mode"') < app.indexOf('id="directory-mode"'));
  assert.doesNotMatch(app, /id="artifacts-mode"/);
  assert.match(app, /aria-label="文件来源"/);
  assert.match(app, /view.detailsOpen \? "" : "hidden"/);
  assert.doesNotMatch(app, /职责与交付要求/);
  assert.doesNotMatch(app, /data-ws-tab="artifacts"|rasterArtifact|loadArtifactSnapshot/);
  assert.match(app, /data-ws-tab="diff"/);
  assert.match(app, /CHANGE/);
  assert.match(app, /当前工作文件/);
  assert.match(artifactDoc, /不删除 Trace 绑定的不可变 Artifact 历史/);
});

test("Console exposes immediate retry only for executable scheduled Dispatches", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function retryableDispatches"), end = source.indexOf("\n\nconst $", start);
  const { retryableDispatches, failedRunRecovery, failedRunMessage } = new Function(`${source.slice(start, end)}; return { retryableDispatches, failedRunRecovery, failedRunMessage };`)();
  const scheduled = { id: "scheduled", status: "queued", nextRetryAt: "2026-09-21T00:00:00.000Z", interactionOnly: false };
  const inquiry = { id: "inquiry", status: "queued", nextRetryAt: "2026-09-21T00:00:00.000Z", interactionOnly: true };
  assert.deepEqual(retryableDispatches({ run: { status: "running", task: {} }, dispatches: [scheduled] }).map((item) => item.id), ["scheduled"]);
  assert.deepEqual(retryableDispatches({ run: { status: "paused", task: {} }, dispatches: [scheduled, inquiry] }).map((item) => item.id), ["inquiry"]);
  assert.deepEqual(retryableDispatches({ run: { status: "running", task: { archivedAt: "2026-09-21T00:00:00.000Z" } }, dispatches: [scheduled] }), []);
  assert.deepEqual(failedRunRecovery({ run: { status: "failed", task: {} }, traces: [{ status: "failed", type: "node", workflowNodeId: "requirements" }] }), { type: "node", nodeIds: ["requirements"] });
  assert.deepEqual(failedRunRecovery({ run: { status: "failed", task: {} }, traces: [{ status: "failed", type: "manager", workflowNodeId: "requirements" }] }), { type: "orchestration", nodeIds: [] });
  assert.equal(failedRunRecovery({ run: { status: "failed", task: { archivedAt: "2026-09-21T00:00:00.000Z" } }, traces: [] }), null);
  assert.equal(failedRunMessage({ run: { status: "failed", failure: { message: "运行文件尚未准备好" } }, traces: [] }), "运行文件尚未准备好");
  assert.equal(failedRunRecovery({ run: { status: "failed", failure: { phase: "workspace_baseline_missing" }, task: {} }, traces: [{ status: "failed", type: "node", workflowNodeId: "requirements" }] }), null);
  assert.match(source, /data-retry-scheduled/);
  assert.match(source, /\/api\/runs\/\$\{runId\}\/retry-now/);
  assert.match(source, /data-retry-failed-node/);
  assert.match(source, /\/api\/runs\/\$\{runId\}\/retry-failed-node/);
  assert.match(source, /data-retry-orchestration/);
  assert.match(source, /\/api\/runs\/\$\{runId\}\/retry-orchestration/);
});

test("human acceptance shows overall review and frozen user requirements without a criterion matrix", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function acceptanceReview"), end = source.indexOf("\n\nconst $", start);
  assert.ok(start >= 0 && end > start);
  const { acceptanceReview } = new Function(`${source.slice(start, end)}; return { acceptanceReview };`)();
  const legacy = acceptanceReview({
    run: { status: "awaiting_acceptance", task: { acceptanceCriteria: ["真实 Artifact", "经理复核"] }, deliveryReview: { verdict: "pass", findings: ["已核对交付证据"] } },
    artifacts: [{ id: "artifact_document", name: "reports/review.md" }, { id: "artifact_media", name: "artifacts/source.mp4" }, { id: "artifact_code", name: "src/index.mjs" }],
    traces: [{ id: "trace_review", type: "delivery_review", status: "completed" }],
  });
  assert.equal(legacy.verified, true); assert.equal(legacy.artifactCount, 3); assert.equal(legacy.reviewTraceId, "trace_review");
  const structured = acceptanceReview({
    run: { status: "awaiting_acceptance", task: { acceptanceCriteria: ["真实 Artifact", "经理复核"] }, deliveryReview: { verdict: "pass", traceId: "trace_current_review", findings: ["已逐条核对交付证据"], criteriaAssessments: [{ criterionIndex: 0, verdict: "met", rationale: "文档快照已验收", evidenceArtifactIds: ["artifact_document"] }, { criterionIndex: 1, verdict: "met", rationale: "代码快照已验收", evidenceArtifactIds: ["artifact_code"] }] } },
    artifacts: [{ id: "artifact_document", name: "docs/review.md" }, { id: "artifact_internal", name: "traces/internal.json" }, { id: "artifact_code", name: "repos/app/index.mjs" }],
    traces: [{ id: "trace_review", type: "delivery_review", status: "completed" }, { id: "trace_current_review", type: "delivery_review", status: "completed" }],
  });
  assert.equal(structured.verified, true); assert.equal(structured.reviewTraceId, "trace_current_review");
  assert.equal(Object.hasOwn(structured, "criteriaAssessments"), false);
  assert.equal(acceptanceReview({ run: { status: "running", task: {} } }), null);
  assert.equal(acceptanceReview({ run: { status: "awaiting_acceptance", task: {}, deliveryReview: { verdict: "pass", findings: [] } } }).verified, true);
  assert.equal(acceptanceReview({ run: { status: "awaiting_acceptance", task: { acceptanceCriteria: ["真实 Artifact"] }, deliveryReview: { verdict: "pass", findings: ["摘要"], criteriaAssessments: [{ criterionIndex: 0, verdict: "met", rationale: "没有可读取的证据", evidenceArtifactIds: ["missing_artifact"] }] } }, artifacts: [], traces: [] }).verified, true);
  assert.match(source, /data-open-acceptance-directory/);
  assert.match(source, /data-open-acceptance-review/);
  // Historical matrix facts may remain in saved runs, but current UI ignores them.
  assert.doesNotMatch(source, /data-open-acceptance-evidence|acceptance-criteria-list|逐条验收标准复核/);
  assert.doesNotMatch(source.slice(source.indexOf("function acceptanceReview"), source.indexOf("/* ---------- API")), /criteriaAssessments/);
  assert.match(source, /run\.acceptanceRequest\?\.traceId/);
  assert.match(source, /data-open-completion-confirm/);
  assert.match(source, /id="ack-completion"/);
  assert.doesNotMatch(source, /data-confirm-completion=/);
});

test("collaboration is chronological without pinned acceptance duplicates and unarchived tasks remain answerable", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const reviewSource = source.slice(source.indexOf("function acceptanceReview"), source.indexOf("\n\nconst $"));
  const esc = (value = "") => String(value).replaceAll("<", "&lt;");
  const acceptanceReview = new Function(`${reviewSource};return acceptanceReview;`)();
  const workspace = { run: { id: "run", status: "awaiting_acceptance", task: { acceptanceCriteria: [] }, deliveryReview: { verdict: "pass", traceId: "trace_review", findings: ["<真实复核>"] } }, traces: [{ id: "trace_review", type: "delivery_review", status: "completed" }] };
  assert.equal(acceptanceReview(workspace).verified, true);
  workspace.run.status = "completed";
  assert.equal(acceptanceReview(workspace), null);
  assert.equal(acceptanceReview(workspace, { history: true }).verified, true);
  workspace.run.status = "running";
  assert.equal(acceptanceReview(workspace, { history: true }), null);
  workspace.run.status = "awaiting_acceptance";
  workspace.run.task.archivedAt = "2026-10-19";
  assert.equal(acceptanceReview(workspace), null);
  assert.match(source, /acceptance\?\.verified \? `<button[^`]*data-open-completion-confirm/);
  assert.doesNotMatch(source, /acceptancePanel|collaboration-review|data-stop-inquiries|停止答疑/);
  assert.match(source, /confirm-completion.*disabled/);
  const renderSource = source.slice(source.indexOf("function renderCollaboration("), source.indexOf("/* ---------- 任务空间数据与动作"));
  const view = { draft: "", collaborationFilter: "all" };
  const elements = new Map();
  const select = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", addEventListener() {} });
    return elements.get(id);
  };
  const render = new Function("$", "state", "workspaceView", "collaborationRecords", "collaborationMessageMarkup", "exactTime", "esc", "sendInstruction", `${renderSource}; return renderCollaboration;`)(select, { workspace }, () => view, collaborationRecords, text => `<p>${esc(text)}</p>`, String, esc, () => {});
  workspace.run.task.archivedAt = null;
  workspace.messages = [
    { id: 'manager-final', kind: 'manager_decision', sender: { type: 'agent', name: '经理' }, recipient: { type: 'team', name: '团队' }, content: '最终交接结论', createdAt: '2026-10-19T00:00:00Z' },
    { id: 'follow-up', kind: 'inquiry', sender: { type: 'human', name: '你' }, recipient: { type: 'agent', name: '实现者' }, content: '新的提问', createdAt: '2026-10-19T00:01:00Z' },
  ];
  workspace.dispatches = [{ interactionOnly: true, status: 'claimed', messageIds: ['follow-up'] }];
  workspace.events = [{ id: "review-event", type: "run.awaiting_acceptance", timestamp: "2026-10-19T00:00:00Z", message: "等待人类确认" }];
  for (const status of ["planning", "running", "awaiting_human", "review", "awaiting_acceptance", "paused", "failed", "cancelled", "completed"]) {
    workspace.run.status = status;
    render(workspace, []);
    const html = select("#collaboration-panel").innerHTML;
    assert.equal((html.match(/最终交接结论/g) || []).length, 1);
    assert.ok(html.indexOf('最终交接结论') < html.indexOf('新的提问'));
    assert.equal(select('#instruction-text').disabled, false);
    assert.doesNotMatch(html, /collaboration-review|经理交接说明|等待人类确认|停止答疑/);
    assert.doesNotMatch(html, /data-open-completion-confirm|workspace-acceptance/);
  }
  view.collaborationFilter = "human";
  render(workspace, []);
  assert.match(select("#collaboration-panel").innerHTML, /新的提问/);
  assert.doesNotMatch(select("#collaboration-panel").innerHTML, /最终交接结论/);
  workspace.run.task.archivedAt = '2026-10-20';
  render(workspace, []);
  assert.equal(select('#instruction-text').disabled, true);
  assert.match(select('#collaboration-panel').innerHTML, /data-send-instruction disabled/);
  const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(css, /#run-workspace \.collaboration-row \{ display:block; max-width:none; margin:0; padding:14px 0;/);
  assert.match(css, /\.collaboration-row.from-human \.collaboration-content \{[^}]*padding:10px 12px/);
});

test("clarification submission preserves another Run or a newly edited draft, including API failure", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const submitSource = source.slice(source.indexOf("async function sendInstruction("), source.indexOf("function openTerminateModal("));
  for (const scenario of ["switch-run", "edit-draft", "failure", "success"]) {
    const state = { selectedRunId: "run-a", workspace: null };
    const views = { "run-a": { draft: "原草稿" }, "run-b": { draft: "另一个任务的草稿" } };
    const refreshed = [], requests = [], notices = [];
    let resolveRequest, rejectRequest;
    const pending = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const submit = new Function("state", "workspaceView", "FormData", "api", "toast", "loadWorkspace", "workspaceAgents", `${submitSource}; return sendInstruction;`)(
      state, (id = state.selectedRunId) => views[id], class { get(key) { return key === "replyToMessageId" ? "question-1" : "原草稿"; } },
      (url) => { requests.push(url); return pending; }, (message) => notices.push(message),
      async (id) => refreshed.push(id), () => [],
    );
    const sending = submit({ preventDefault() {}, currentTarget: {} });
    if (scenario === "switch-run") state.selectedRunId = "run-b";
    if (scenario === "edit-draft") views["run-a"].draft = "继续输入的新草稿";
    if (scenario === "failure") rejectRequest(new Error("服务暂不可用"));
    else resolveRequest({});
    await sending;
    assert.deepEqual(requests, ["/api/runs/run-a/messages"]);
    assert.equal(views["run-b"].draft, "另一个任务的草稿");
    assert.equal(views["run-a"].draft, scenario === "failure" ? "原草稿" : scenario === "edit-draft" ? "继续输入的新草稿" : "");
    assert.deepEqual(refreshed, ["success", "edit-draft"].includes(scenario) ? ["run-a"] : []);
    if (scenario === "failure") assert.deepEqual(notices, ["服务暂不可用"]);
  }
});

test("task composer requires exactly one @ recipient for new messages and accepts exact replies", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const submitSource = source.slice(source.indexOf("async function sendInstruction("), source.indexOf("function openTerminateModal("));
  for (const [content, replyToMessageId, recipientAgentId, notice] of [
    ["请处理", "", null, "新消息必须 @ 一位当前任务成员"],
    ["@经理 @研发 请处理", "", null, "新消息必须 @ 一位当前任务成员"],
    ["@研发 请处理", "", "developer", null],
    ["已确认", "question-1", null, null],
  ]) {
    const calls = [], notices = [];
    const state = { selectedRunId: "run-1", workspace: { run: { task: { archivedAt: null } } }, agents: [] };
    const view = { draft: content };
    const submit = new Function("state", "workspaceView", "FormData", "api", "toast", "loadWorkspace", "workspaceAgents", `${submitSource}; return sendInstruction;`)(
      state, () => view, class { get(key) { return key === "content" ? content : replyToMessageId; } },
      async (_path, options) => { calls.push(JSON.parse(options.body)); return {}; },
      (message) => notices.push(message), async () => {}, () => [{ id: "manager", name: "经理" }, { id: "developer", name: "研发" }],
    );
    await submit({ preventDefault() {}, currentTarget: {} });
    if (notice) { assert.deepEqual(calls, []); assert.deepEqual(notices, [notice]); }
    else { assert.equal(calls.length, 1); assert.equal(calls[0].recipientAgentId, recipientAgentId); assert.equal(calls[0].replyToMessageId, replyToMessageId || null); }
  }
});

test("a created Task remains actionable when its immediate Run launch is rejected or uncertain", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const runTaskSource = source.slice(source.indexOf("async function runTask(taskId"), source.indexOf("async function sendInstruction(event)"));
  const state = { selectedRunId: null, selectedAgentId: null, tasks: [], runs: [] };
  const notices = [], refreshes = [];
  let refreshedStatus = "backlog";
  let refreshAvailable = true;
  const runTask = new Function("api", "state", "toast", "refresh", "setView", "loadWorkspace", "runOfTask", `${runTaskSource}; return runTask;`)(
    async () => { throw new Error("项目经理不可用"); }, state,
    (message, isError) => notices.push({ message, isError }),
    async (options) => {
      refreshes.push(options);
      if (!refreshAvailable) return false;
      state.tasks = [{ id: "task-new", status: refreshedStatus }];
      state.runs = refreshedStatus === "backlog" ? [] : [{ taskId: "task-new", id: "run-new" }];
      return true;
    },
    () => {}, async () => {}, (taskId) => state.runs.find((run) => run.taskId === taskId),
  );

  await runTask("task-new", { taskCreated: true });
  assert.deepEqual(refreshes, [{ quiet: true }]);
  assert.deepEqual(notices, [{ message: "任务已创建，但未能启动 Run：项目经理不可用。任务已保留在任务中心，可再次启动。", isError: true }]);

  notices.length = 0;
  refreshedStatus = "running";
  await runTask("task-new", { taskCreated: true });
  assert.match(notices.at(-1).message, /启动响应未确认/);
  assert.equal(notices.at(-1).isError, true);

  notices.length = 0;
  refreshAvailable = false;
  await runTask("task-new", { taskCreated: true });
  assert.match(notices.at(-1).message, /无法重新读取任务中心/);
  assert.equal(notices.at(-1).isError, true);
});
test("plain text employee handoff reaches human acceptance on the manager decision", async () => {
  const root = await directory("agentforge-coordination-text-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
if (process.argv.includes("--json-schema")) throw new Error("task must not force an output schema");
const done = prompt.includes("EMPLOYEE_TEXT_HANDOFF");
const result = prompt.includes("任务级项目经理") ? JSON.stringify({summary:"经理安排",managerDecision:{nextNodeId:done?null:"requirements",nextAgentId:done?null:"agent_analyst",rationale:"按员工交接决定下一步"}}) : "EMPLOYEE_TEXT_HANDOFF";
console.log(JSON.stringify({type:"result",result}));
`);
    await chmod(executable, 0o755);
    const store = createStore(), base = fixtureTaskInput(store);
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const task = store.createTask({ ...base, workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
    const workspace = store.getRunWorkspace(run.id);
    assert.equal(workspace.run.status, "awaiting_acceptance");
    assert.equal(workspace.artifacts.length, 0);
    assert.ok(workspace.messages.some(item => item.content === "EMPLOYEE_TEXT_HANDOFF"));
    assert.equal(workspace.traces.some(item => item.type === "delivery_review" || item.status === "failed"), false);
    assert.ok(workspace.run.acceptanceRequest.traceId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prompt snapshot write failure does not block runtime or manager handoff", async () => {
  const root = await directory("agentforge-prompt-failure-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--json-schema")) throw new Error("unexpected output gate");
console.log(JSON.stringify({type:"result",result:JSON.stringify({summary:"PROVIDER_EXECUTED",managerDecision:{nextNodeId:null,rationale:"交接人类"}})}));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    const files = createRunFiles({ root: join(root, "audit") });
    const createTrace = store.createTrace.bind(store);
    store.createTrace = (...args) => {
      const trace = createTrace(...args);
      mkdirSync(join(files.traceDirectory(trace.runId, trace.id), "prompt-snapshot.json"), { recursive: true });
      return trace;
    };
    const task = store.createTask({ ...fixtureTaskInput(store), workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
    const workspace = store.getRunWorkspace(run.id);
    assert.equal(workspace.run.status, "awaiting_acceptance");
    assert.ok(workspace.messages.some(message => message.content === "PROVIDER_EXECUTED"));
    assert.equal(workspace.traces.some(trace => trace.status === "failed"), false);
    assert.equal(workspace.traces.some(trace => trace.promptRef), false);
    assert.ok(workspace.run.acceptanceRequest.traceId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a business Trace accepts files outside its declared Artifact paths", async () => {
  const root = await directory("agentforge-artifact-scope-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("你是任务级项目经理")) out.managerDecision = { nextNodeId: "requirements", rationale: "安排需求交付" };
else { mkdirSync("docs/not_requirements", { recursive: true }); writeFileSync("docs/not_requirements/outside.md", "wrong owner path"); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, title: "节点产物范围", workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id);
    assert.ok(workspace.traces.some((trace) => trace.type === "node" && trace.status === "completed"));
    assert.ok(workspace.artifacts.some((artifact) => artifact.name === "docs/not_requirements/outside.md"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manager work can create an auditable Artifact without a role permission gate", async () => {
  const root = await directory("agentforge-manager-write-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "requirements", findings: ["real artifacts present"] };
else if (prompt.includes("你是任务级项目经理")) {
  if (!prompt.includes("docs/testing/cross.md")) { mkdirSync("docs/requirements", { recursive: true }); writeFileSync("docs/requirements/manager.md", "manager work"); }
  out.managerDecision = { nextNodeId: prompt.includes("docs/testing/cross.md") ? null : "requirements", nextAgentId: prompt.includes("docs/testing/cross.md") ? null : "agent_analyst", rationale: "fixture" };
} else { mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/testing/cross.md", "cross-node work"); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore(), base = fixtureTaskInput(store);
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const task = store.createTask({ ...base, workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const artifacts = store.getRunWorkspace(run.id).artifacts;
    assert.ok(artifacts.some((item) => item.name === "docs/requirements/manager.md"));
    assert.ok(artifacts.some((item) => item.name === "docs/testing/cross.md"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a business Trace can change a sensitive file without exposing it as an Artifact", async () => {
  const root = await directory("agentforge-sensitive-delivery-");
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("你是任务级项目经理")) out.managerDecision = { nextNodeId: "requirements", rationale: "安排需求交付" };
else { mkdirSync("docs/requirements", { recursive: true }); writeFileSync("docs/requirements/delivery.md", "# Delivery\\n"); writeFileSync("docs/requirements/.env", "fixture-secret"); }
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) {
  const staff = JSON.parse((prompt.split("可咨询角色：")[1] || "[]").split(String.fromCharCode(10))[0]).filter(row=>row.type==="agent" && row.kind!=="manager");
  const node = out.managerDecision.nextNodeId, known = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[node] || "agent_analyst";
  out.managerDecision.nextAgentId = staff.find(row=>row.id===known)?.id || (["testing","architecture"].includes(node) ? staff.at(-1)?.id : staff[0]?.id);
}
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
    await chmod(executable, 0o755);
    const store = createStore();
    store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
    const base = fixtureTaskInput(store);
    const task = store.createTask({ ...base, title: "敏感文件不能成为交付", workspacePath: root, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    const workspace = store.getRunWorkspace(run.id);
    const trace = workspace.traces.find((item) => item.type === "node");
    const dispatch = workspace.dispatches.find((item) => item.id === trace.dispatchId);
    assert.equal(trace.status, "completed");
    assert.equal(dispatch.status, "done");
    assert.ok(workspace.artifacts.some((item) => item.name === "docs/requirements/delivery.md"));
    assert.doesNotMatch(JSON.stringify(workspace), /fixture-secret|\.env/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("task orchestration does not request Provider output-schema enforcement", async () => {
  const source = await readFile(new URL("../server/orchestrator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /outputSchema:|schemaPath,/);
});

test("Console folds consecutive legacy audit frames without retaining their content", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("function isCurrentRuntimeAudit"), source.indexOf("function renderToolCall"));
  const { summarizeHistoricalAuditEntries } = new Function(`${code}; return { summarizeHistoricalAuditEntries };`)();
  const entries = summarizeHistoricalAuditEntries([
    { type: "event", event: { id: "old-1", type: "runtime.event", timestamp: "2026-10-12T08:00:00.000Z", data: { text: "must remain hidden" } } },
    { type: "event", event: { id: "old-2", type: "runtime.event", timestamp: "2026-10-12T08:00:01.000Z", data: { text: "must remain hidden" } } },
    { type: "event", event: { id: "current", type: "runtime.event", timestamp: "2026-10-12T08:00:02.000Z", data: { auditVersion: 2, lifecycle: "started" } } },
    { type: "event", event: { id: "old-3", type: "runtime.event", timestamp: "2026-10-12T08:00:03.000Z", data: { text: "must remain hidden" } } },
    { type: "event", event: { id: "failure", type: "trace.failed", timestamp: "2026-10-12T08:00:04.000Z", data: { auditVersion: 2, failureKind: "provider" } } }
  ]);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { type: "historical-audit-summary", count: 2, firstTimestamp: "2026-10-12T08:00:00.000Z", lastTimestamp: "2026-10-12T08:00:01.000Z" });
  assert.equal(entries[1].event.id, "current");
  assert.deepEqual(entries[2], { type: "historical-audit-summary", count: 1, firstTimestamp: "2026-10-12T08:00:03.000Z", lastTimestamp: "2026-10-12T08:00:03.000Z" });
  assert.equal(entries[3].event.id, "failure");
  assert.doesNotMatch(JSON.stringify(entries), /must remain hidden/);
});

test("coordination JSON embedded in manager prose is delivered without rejecting the prose", () => {
  const raw = '先安排员工。\n```json\n{"summary":"派工","managerDecision":{"nextNodeId":"develop","nextAgentId":"worker"}}\n```';
  const output = parseEmployeeResponse(raw);
  assert.equal(output.managerDecision.nextNodeId, "develop");
  assert.equal(output.rawResponse, raw);
  assert.equal(parseEmployeeResponse("普通文字交接").summary, "普通文字交接");
  const envelope = { summary: '交接包含 {括号} 和 "引号"', managerDecision: { nextNodeId: 'develop', nextAgentId: 'worker', rationale: '根据真实交接派工' } };
  const unfenced = '范围已确认，下面提交协调决定。\n\n' + JSON.stringify(envelope);
  assert.equal(parseEmployeeResponse(unfenced).managerDecision.nextAgentId, 'worker');
  assert.equal(parseEmployeeResponse(unfenced).rawResponse, unfenced);
  assert.equal(parseEmployeeResponse(unfenced + '\n以上仅作示例。').managerDecision, null);
  assert.equal(parseEmployeeResponse(JSON.stringify(envelope) + '\n' + JSON.stringify(envelope)).managerDecision, null);
});
