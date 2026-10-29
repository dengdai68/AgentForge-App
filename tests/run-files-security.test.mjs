import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunFiles } from "../server/run-files.mjs";
import { createFixtureStore as createStore } from "./fixture-store.mjs";
import { executeRun } from "../server/orchestrator.mjs";
import { createRuntimeConfiguration } from "../server/runtime/configuration.mjs";

test("working downloads preserve complete bytes beyond preview size and retain file-read boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-download-"));
  try {
    const task = { workspacePath: root, workflowSnapshot: { nodes: [] } };
    const files = createRunFiles({ root: join(root, "audit") });
    await mkdir(join(root, "docs"));
    const bytes = Buffer.alloc(600 * 1024, 0xab);
    await writeFile(join(root, "docs/下载 '样例'.bin"), bytes);
    await writeFile(join(root, "docs/empty.txt"), "");
    for (const [path, expected] of [["docs/下载 '样例'.bin", bytes], ["docs/empty.txt", Buffer.alloc(0)]]) {
      const result = await files.readWorkingFile(task, path, { download: true });
      const chunks = [];
      for await (const chunk of result.content) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), expected);
      assert.equal(result.fileName, path.split("/").at(-1));
    }
    await assert.rejects(files.readWorkingFile(task, "docs/下载 '样例'.bin"), /预览上限/);
    await writeFile(join(root, "outside.txt"), "outside sentinel");
    const rootDownload=await files.readWorkingFile(task,'outside.txt',{download:true});for await(const chunk of rootDownload.content)assert.equal(chunk.toString(),'outside sentinel');
    await symlink(join(root, "outside.txt"), join(root, "docs/link.txt"));
    for (const path of ["../outside.txt", "docs/.env", "docs/link.txt", "docs/missing.txt", "docs",'.git/config','.agentforge/private.json']) {
      await assert.rejects(files.readWorkingFile(task, path, { download: true }));
    }
    await assert.rejects(files.readWorkingFile(task, "docs/empty.txt", { raw: true, download: true }), /不能同时/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("console content references cannot cross Run, Trace or actor boundaries", () => {
  const store = createStore(), run = store.createRun(store.listTasks()[0].id);
  const trace = store.createTrace(run.id, { agentId: run.manager.id, workflowNodeId: store.getRunTask(run.id).workflowSnapshot.nodes[0].id, type: 'manager' });
  const contentRef = { storagePath: `runs/${run.id}/traces/${trace.id}/content-11111111-1111-4111-8111-111111111111.json`, bytes: 30, sha256: 'a'.repeat(64) };
  const event = store.addEvent({ type: 'runtime.event', runId: run.id, actor: { id: run.manager.id }, message: 'summary', data: { auditVersion: 2, traceId: trace.id, contentRef } });
  assert.deepEqual(store.getConsoleContentReference(run.id, event.id), contentRef);
  assert.throws(() => store.getConsoleContentReference('other-run', event.id), /不存在/);
  const wrongActor = store.addEvent({ type: 'runtime.event', runId: run.id, actor: { id: 'other' }, message: 'summary', data: { auditVersion: 2, traceId: trace.id, contentRef } });
  assert.throws(() => store.getConsoleContentReference(run.id, wrongActor.id), /不存在/);
  const wrongPath = store.addEvent({ type: 'runtime.event', runId: run.id, actor: { id: run.manager.id }, message: 'summary', data: { auditVersion: 2, traceId: trace.id, contentRef: { ...contentRef, storagePath: 'runs/other/traces/other/content.json' } } });
  assert.throws(() => store.getConsoleContentReference(run.id, wrongPath.id), /关联无效/);
});

test("execution content is file-backed, private and rejects tampering or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-console-content-'));
  try {
    const files = createRunFiles({ root });
    const content = { version: 1, fields: { text: { text: 'actual output', truncated: false, redacted: false } } };
    const ref = await files.writeConsoleContent('run_test', 'trace_test', content);
    assert.deepEqual(await files.readConsoleContent(ref), content);
    assert.equal((await lstat(join(root, ref.storagePath))).mode & 0o777, 0o600);
    await writeFile(join(root, ref.storagePath), '{}');
    await assert.rejects(files.readConsoleContent(ref), /完整性/);
    await rm(join(root, ref.storagePath));
    const target = join(root, 'outside.json'); await writeFile(target, JSON.stringify(content));
    await symlink(target, join(root, ref.storagePath));
    await assert.rejects(files.readConsoleContent(ref), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dispatch prompt snapshots are per-Trace, integrity-bound and boundary-checked", async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-prompt-snapshot-'));
  try {
    const files = createRunFiles({ root });
    const store = createStore(), run = store.createRun(store.listTasks()[0].id);
    const trace = store.createTrace(run.id, { agentId: run.manager.id, workflowNodeId: store.getRunTask(run.id).workflowSnapshot.nodes[0].id, type: 'manager' });
    assert.throws(() => store.getTracePromptReference(run.id, trace.id), /不存在或当时未保存/);
    const snapshot = { version: 1, kind: 'prompt-snapshot', prompt: { text: '实际派发提示词', truncated: false, redacted: false } };
    const ref = await files.writePromptSnapshot(run.id, trace.id, snapshot);
    assert.equal((await lstat(join(root, ref.storagePath))).mode & 0o777, 0o600);
    assert.deepEqual(await files.readConsoleContent(ref), snapshot);
    const attached = store.attachTracePrompt(trace.id, ref);
    assert.deepEqual(attached.promptRef, ref);
    assert.deepEqual(store.getTracePromptReference(run.id, trace.id), ref);
    assert.throws(() => store.getTracePromptReference('other-run', trace.id), /不存在/);
    assert.throws(() => store.attachTracePrompt(trace.id, ref), /关联无效/);
    assert.throws(() => store.attachTracePrompt(store.createTrace(run.id, { agentId: run.manager.id, workflowNodeId: trace.workflowNodeId, type: 'manager' }).id, { ...ref, storagePath: `runs/${run.id}/traces/other/prompt-snapshot.json` }), /关联无效/);
    await assert.rejects(files.writePromptSnapshot(run.id, trace.id, snapshot));
    await writeFile(join(root, ref.storagePath), '{}');
    await assert.rejects(files.readConsoleContent(ref), /完整性/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace readiness marker rejects a symlink before it can overwrite an external file", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-ready-marker-"));
  try {
    const task = {
      id: "task_workspace_marker",
      workspaceManaged: true,
      workspacePath: join(root, "workspace"),
      repositoryMode: "agent",
      repositorySources: [],
      workflowSnapshot: { nodes: [] }
    };
    const files = createRunFiles({ root: join(root, "audit") });
    assert.deepEqual(await files.prepareRunWorkspace(task), []);

    const marker = join(task.workspacePath, ".agentforge", "workspace-ready.json");
    assert.equal(JSON.parse(await readFile(marker, "utf8")).taskId, task.id);
    const outside = join(root, "outside-marker.json");
    const original = JSON.stringify({ taskId: task.id, preparedAt: "outside sentinel" });
    await writeFile(outside, original);
    await rm(marker);
    await symlink(outside, marker);

    await assert.rejects(files.prepareRunWorkspace(task), /就绪标记不允许符号链接/);
    assert.equal(await readFile(outside, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace readers reject a Task root symlink before it reveals external files", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-workspace-root-link-"));
  try {
    const workspace = join(root, "workspace"), outside = join(root, "outside");
    await mkdir(join(outside, "docs"), { recursive: true });
    await mkdir(join(outside, "repos", "app", "src"), { recursive: true });
    await writeFile(join(outside, "docs", "outside.md"), "OUTSIDE_WORKSPACE_SENTINEL");
    await writeFile(join(outside, "repos", "app", "src", "outside.js"), "export const outside = true;\n");
    await symlink(outside, workspace);

    const files = createRunFiles({ root: join(root, "audit") });
    const task = { id: "task_workspace_root_link", workspacePath: workspace, repositoryMode: "agent", repositorySources: [{ path: "repos/app" }], workflowSnapshot: { nodes: [] } };

    await assert.rejects(files.listWorkingDirectory(task), /工作目录不允许读取符号链接/);
    await assert.rejects(files.readWorkingFile(task, "docs/outside.md"), /工作目录不允许读取符号链接/);
    await assert.rejects(files.listRepositoryTree(workspace, "repos/app"), /工作目录不允许读取符号链接/);
    assert.equal(await readFile(join(outside, "docs", "outside.md"), "utf8"), "OUTSIDE_WORKSPACE_SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private Git host tokens reach only their matching HTTPS clone helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-git-token-clone-"));
  const previousPath = process.env.PATH, previousCapture = process.env.GIT_CAPTURE_PATH;
  try {
    const bin = join(root, "bin"), capture = join(root, "git-capture.json"), fakeGit = join(bin, "git");
    await mkdir(bin);
    await writeFile(fakeGit, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const helperEntry = args.find((arg) => arg.startsWith("credential.helper=!"));
const credential = (host) => {
  if (!helperEntry) return "";
  const command = helperEntry.slice("credential.helper=".length + 1);
  return spawnSync("/bin/sh", ["-c", command + " get"], { input: "protocol=https\\nhost=" + host + "\\n\\n", encoding: "utf8", env: process.env }).stdout;
};
if (args.includes("clone")) {
  const target = args.at(-1);
  mkdirSync(target + "/.git", { recursive: true });
  writeFileSync(target + "/README.md", "fixture\\n");
  writeFileSync(process.env.GIT_CAPTURE_PATH, JSON.stringify({ args, github: credential("github.com"), gitlab: credential("gitlab.com"), foreign: credential("redirect.example") }));
} else if (args.includes("rev-parse")) console.log("0123456789012345678901234567890123456789");
else if (args.includes("config") && args.includes("remote.origin.url")) console.log(process.env.GIT_FAKE_ORIGIN || "");
`);
    await chmod(fakeGit, 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.GIT_CAPTURE_PATH = capture;
    const configuration = createRuntimeConfiguration(join(root, "runtime-config"));
    const githubToken = "GITHUB_PULL_TOKEN_SENTINEL", gitlabToken = "GITLAB_PULL_TOKEN_SENTINEL";
    await configuration.saveGitCredential("github", githubToken);
    await configuration.saveGitCredential("gitlab", gitlabToken);
    const prepare = async (id, url) => {
      process.env.GIT_FAKE_ORIGIN = url;
      const task = { id, workspaceManaged: true, workspacePath: join(root, id), repositoryMode: "agent", repositorySources: [{ path: "repos/app", url, ref: "main" }], workflowSnapshot: { nodes: [] } };
      const files = createRunFiles({ root: join(root, `${id}-audit`), resolveGitCredential: (repositoryUrl) => configuration.resolveGitCredential(repositoryUrl) });
      await files.prepareRunWorkspace(task);
      return { task, marker: await readFile(join(task.workspacePath, ".agentforge", "workspace-ready.json"), "utf8"), capture: JSON.parse(await readFile(capture, "utf8")) };
    };

    const github = await prepare("github-workspace", "https://github.com/acme/private.git");
    assert.equal(github.capture.github, "username=x-access-token\npassword=GITHUB_PULL_TOKEN_SENTINEL\n");
    assert.equal(github.capture.gitlab, "");
    assert.equal(github.capture.foreign, "");
    assert.ok(github.capture.args.includes("--no-recurse-submodules"));
    assert.doesNotMatch(JSON.stringify({ args: github.capture.args, marker: github.marker, task: github.task }), /GITHUB_PULL_TOKEN_SENTINEL|GITLAB_PULL_TOKEN_SENTINEL/);

    const gitlab = await prepare("gitlab-workspace", "https://gitlab.com/acme/private.git");
    assert.equal(gitlab.capture.github, "");
    assert.equal(gitlab.capture.gitlab, "username=oauth2\npassword=GITLAB_PULL_TOKEN_SENTINEL\n");
    assert.equal(gitlab.capture.foreign, "");
    assert.doesNotMatch(JSON.stringify({ args: gitlab.capture.args, marker: gitlab.marker, task: gitlab.task }), /GITHUB_PULL_TOKEN_SENTINEL|GITLAB_PULL_TOKEN_SENTINEL/);

    await configuration.removeGitCredential("github");
    const anonymous = await prepare("anonymous-workspace", "https://github.com/acme/public.git");
    assert.equal(anonymous.capture.github, "");
    assert.equal(anonymous.capture.args.some((arg) => arg.startsWith("credential.helper=!")), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.GIT_CAPTURE_PATH; else process.env.GIT_CAPTURE_PATH = previousCapture;
    delete process.env.GIT_FAKE_ORIGIN;
    await rm(root, { recursive: true, force: true });
  }
});

test("a managed workspace completes a fixture Run with a regular readiness marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-ready-marker-run-"));
  try {
    const executable = join(root, "provider.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const reviewCriteria = JSON.parse((prompt.split("任务验收标准：")[1] || "[]").split(String.fromCharCode(10))[0]);
const reviewEvidence = [...prompt.matchAll(/"id":"(artifact_[^"]+)"/g)].map((match) => match[1]).slice(0, 1);
const result = { kind: "node_result", summary: "fixture delivery", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "fixture input is sufficient", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) result.deliveryReview = { verdict: "pass", restartFromNodeId: "verify", findings: ["fixture evidence reviewed"] };
else if (prompt.includes("任务级项目经理")) result.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "verify", rationale: "fixture routes the remaining responsibility" };
else { mkdirSync("docs/verify", { recursive: true }); mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/verify/marker.md", "x".repeat(524289)); writeFileSync("docs/testing/review.md", "# Fixture test report"); }
if(result.managerDecision?.nextNodeId) result.managerDecision.nextAgentId=JSON.parse((prompt.split("可咨询角色：")[1]||"[]").split(String.fromCharCode(10))[0]).find(row=>row.type==="agent" && row.kind!=="manager")?.id;
console.log(JSON.stringify({ type: "result", result: JSON.stringify(result) }));
`);
    await chmod(executable, 0o755);

    const store = createStore({ workspaceRoot: join(root, "workspaces") });
    const verifier = store.createAgent({ name: "验证员工", role: "验证工程师", runtime: { provider: "claude-code", executable } });
    const team = store.createTeam({ name: "工作目录验证团队", memberAgentIds: [verifier.id] });
    const workflow = store.createWorkflowTemplate({ name: "工作目录验证", nodes: [{ id: "verify", title: "验证", staffingGuidance: "验证工程师", artifactPaths: ["docs/verify/", "docs/testing/"], dependsOn: [] }] });
    const task = store.createTask({ title: "工作目录标记运行", objective: "验证受管工作目录启动", teamId: team.id, workflowTemplateId: workflow.id, nodeAssignments: { verify: verifier.id }, managerRuntime: { provider: "claude-code", executable } });
    const run = store.createRun(task.id);

    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    assert.equal(store.getRun(run.id).status, "awaiting_acceptance");
    assert.ok(store.getRunWorkspace(run.id).artifacts.some((artifact) => artifact.name === "docs/verify/marker.md" && artifact.bytes === 524289));
    const marker = join(store.getRunTask(run.id).workspacePath, ".agentforge", "workspace-ready.json");
    assert.equal((await lstat(marker)).isFile(), true);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")).repositoryRevisions, []);
    store.confirmRunCompletion(run.id);
    assert.equal(store.getRun(run.id).status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
