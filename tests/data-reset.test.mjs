import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDataReset } from "../server/data-reset.mjs";
import { createStore } from "../server/store.mjs";
import { createAuth } from "../server/auth.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "af-reset-owned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, "state.sqlite"), authDatabasePath: join(root, "auth.sqlite"), runFilesRoot: join(root, "records"), runtimeConfigRoot: join(root, "private"), logDirectory: join(root, "logs") };
  for (const path of [join(options.runFilesRoot, "runs"), options.runtimeConfigRoot, options.logDirectory]) await mkdir(path, { recursive: true });
  return { root, options, reset: createDataReset(options) };
}

test("factory reset erases instance files, closes derived history, and recovers an interrupted committed reset", async t => {
  const { root, options, reset } = await fixture(t);
  let store = createStore({ databasePath: options.databasePath, workspaceRoot: join(root, "work") });
  let auth = createAuth({ databasePath: options.authDatabasePath });
  const installationId = store.getBootstrap().installationId;
  assert.deepEqual(store.listTasks(), [], "fresh installs must not create a sample Task or cwd binding");
  const employee = store.createAgent({ name: "Reset-only private employee", role: "核验" });
  store.openCommunication({ kind: "agent", targetId: employee.id });
  store.historyQuery(employee.id, "list_sessions", {});
  await auth.setAdministrator("fixture-admin", "Fixture-only-reset-2847");
  await writeFile(join(options.runtimeConfigRoot, "git-credentials.json"), "fixture-private-token");
  await mkdir(join(options.runtimeConfigRoot,"installed-plugins/plugin-fixture/plugin"),{recursive:true});
  await writeFile(join(options.runtimeConfigRoot,"installed-plugins/plugin-fixture/plugin/SKILL.md"),"owned installed plugin");
  const log = join(options.logDirectory, "2026-10-19T01-02-03-001Z-123-aabbccdd-0.jsonl");
  await writeFile(log, "fixture diagnostic content");
  const workspace = join(root, "work", "task_fixture", "run_fixture");
  await mkdir(join(workspace, ".agentforge"), { recursive: true });
  await writeFile(join(workspace, ".agentforge", "workspace-ready.json"), JSON.stringify({ taskId: "task_fixture" }));
  await writeFile(join(workspace, "delivery.txt"), "fixture delivery");
  const outside = join(root, "work", "task_fixture", "keep.txt");
  await writeFile(outside, "external sibling must survive");
  await reset.begin([{ taskId: "task_fixture", runId: "run_fixture", path: workspace }]);
  store.close(); auth.close();
  // Simulate interruption after one target was removed but before cleanup finished.
  await rm(options.databasePath);
  assert.equal(await createDataReset(options).recover(), true);
  for (const path of [workspace, log, options.authDatabasePath, `${options.databasePath}.history.sqlite`, options.runtimeConfigRoot, options.runFilesRoot]) await assert.rejects(access(path), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "external sibling must survive");
  assert.equal(await reset.recover(), false);
  store = createStore({ databasePath: options.databasePath, workspaceRoot: join(root, "work") });
  auth = createAuth({ databasePath: options.authDatabasePath });
  try {
    assert.notEqual(store.getBootstrap().installationId, installationId);
    assert.equal(store.listAgents().some(item => item.id === employee.id), false);
    assert.deepEqual(store.listTasks(), [], "reset must not recreate the portal sample");
    assert.deepEqual(store.listCommunications(), []);
    assert.equal(auth.configured(), false);
  } finally { store.close(); auth.close(); }
});

test("reset handles actual UUID Task workspaces without deleting siblings and still rejects traversal", async t => {
  const { root, options, reset } = await fixture(t);
  const store = createStore({ databasePath: options.databasePath, workspaceRoot: join(root, "work") });
  const agents = store.listAgents(), manager = agents.find(item => item.kind === "manager");
  const team = store.createTeam({ name: "Reset identity proof", managerAgentId: manager.id, memberAgentIds: [agents.find(item => item.kind === "business").id] });
  const task = store.createTask({ title: "UUID reset", objective: "Only isolated data", teamId: team.id, workflowTemplateId: store.listWorkflowTemplates()[0].id });
  const run = store.createRun(task.id);
  assert.match(task.id, /^task_[a-f0-9-]{36}$/);
  const workspace = run.workspacePath;
  await mkdir(join(workspace, ".agentforge"), { recursive: true });
  await writeFile(join(workspace, ".agentforge", "workspace-ready.json"), JSON.stringify({ taskId: task.id }));
  const sibling = join(root, "work", "external.txt"); await writeFile(sibling, "preserved");
  await assert.rejects(reset.begin([{ taskId: task.id + "/../", runId: run.id, path: workspace }]), /归属无效/);
  await reset.begin([{ taskId: task.id, runId: run.id, path: workspace }]);
  store.close();
  assert.equal(await reset.recover(), true);
  await assert.rejects(access(workspace), { code: "ENOENT" });
  assert.equal(await readFile(sibling, "utf8"), "preserved");
});

test("reset rejects linked roots, foreign root contents and invalid managed ownership before deleting anything", async t => {
  const { root, options, reset } = await fixture(t);
  await writeFile(options.databasePath, "metadata sentinel");
  await writeFile(join(options.runtimeConfigRoot, "personal-notes.txt"), "foreign sentinel");
  await assert.rejects(reset.begin([]), /非 AgentForge/);
  assert.equal(await readFile(options.databasePath, "utf8"), "metadata sentinel");
  await rm(join(options.runtimeConfigRoot, "personal-notes.txt"));
  const linked = join(root, "linked");
  await symlink(options.runtimeConfigRoot, linked);
  await assert.rejects(createDataReset({ ...options, runtimeConfigRoot: linked }).begin([]), /链接不安全/);
  await assert.rejects(reset.begin([{ taskId: "task_wrong", runId: "run_wrong", path: root }]), /归属无效/);
  await assert.rejects(createDataReset({ ...options, runtimeConfigRoot: root, protectedPaths: [root] }).begin([]), /受保护/);
  await assert.rejects(access(`${options.databasePath}.reset.json`), { code: "ENOENT" });
  assert.equal(await readFile(options.databasePath, "utf8"), "metadata sentinel");
});

test("an interrupted uncommitted reset never erases live data", async t => {
  const { options, reset } = await fixture(t);
  await writeFile(options.databasePath, "live metadata sentinel");
  await writeFile(`${options.databasePath}.reset.json.pending`, '{"unfinished":');
  assert.equal(await reset.recover(), false);
  assert.equal(await readFile(options.databasePath, "utf8"), "live metadata sentinel");
  await assert.rejects(access(`${options.databasePath}.reset.json.pending`), { code: "ENOENT" });
});

test("Store rejects clearing a live Run and exposes only confirmed managed workspace identities", t => {
  const store = createStore();
  t.after(() => store.close());
  const worker = store.listAgents().find(employee => employee.kind !== "manager");
  const manager = store.listAgents().find(employee => employee.kind === "manager");
  const team = store.createTeam({ name: "Disposable reset team", memberAgentIds: [worker.id], managerAgentId: manager.id });
  const task = store.createTask({ teamId: team.id, workflowTemplateId: store.listWorkflowTemplates()[0].id, title: "Disposable reset eligibility", objective: "fixture", workspacePath: tmpdir() });
  const run = store.createRun(task.id);
  assert.throws(() => store.prepareDataReset(), /停止正在执行/);
  store.cancelRun(run.id, "fixture test only");
  assert.deepEqual(store.prepareDataReset(), [], "a user-provided project directory is never a reset deletion target");
});
