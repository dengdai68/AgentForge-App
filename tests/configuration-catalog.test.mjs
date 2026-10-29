import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createStore } from '../server/store.mjs';
import { createSqlitePersistence } from '../server/persistence.mjs';
import { createFixtureStore } from './fixture-store.mjs';

const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'af-catalog-contract-')); return { databasePath: join(root, 'state.sqlite'), workspaceRoot: root }; };

test('independent instances share a workspace root without same-millisecond task directory collisions', t => {
  const root = mkdtempSync(join(tmpdir(), 'af-shared-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `import {createCatalogFixtureStore} from './tests/fixture-store.mjs';
    Date.now=()=>1700000000000;
    const store=createCatalogFixtureStore({workspaceRoot:${JSON.stringify(root)},databasePath:${JSON.stringify(root)}+'/instance-'+process.pid+'.sqlite'});
    const task=store.createTask({title:'Independent task',objective:'Isolated path proof',teamId:store.listTeams()[0].id,workflowTemplateId:'software_delivery'});
    console.log(JSON.stringify({id:task.id,path:task.workspacePath}));store.close();`;
  const launch = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const a = launch(), b = launch();
  assert.match(a.id, /^task_[a-f0-9-]{36}$/);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.path, b.path);
  assert.equal(a.path, join(root, a.id)); assert.equal(b.path, join(root, b.id));
});

test('fresh catalogs are minimal, all examples can be deleted and stay deleted after restart', () => {
  const options = fixture(); let store = createStore(options);
  assert.equal(store.listAgents().length, 3);
  assert.equal(store.listWorkflowTemplates().length, 1);
  assert.deepEqual(store.listTeams(), []); assert.deepEqual(store.listTasks(), []); assert.deepEqual(store.listRuns(), []);
  for (const item of store.listAgents()) {
    assert.equal(Object.hasOwn(item, 'role'), false);
    store.updateAgent(item.id, { name: item.name + ' edited', status: 'inactive' });
    store.deleteAgent(item.id);
  }
  for (const item of store.listWorkflowTemplates()) store.deleteWorkflowTemplate(item.id);
  for (const item of store.listRuntimeProfiles()) store.deleteRuntimeProfile(item.id);
  assert.equal(store.snapshot().events.filter(item => item.type === 'configuration.agent_deleted').length, 3);
  store.close(); store = createStore(options);
  assert.deepEqual(store.listAgents(), []); assert.deepEqual(store.listTeams(), []);
  assert.deepEqual(store.listWorkflowTemplates(), []); assert.deepEqual(store.listRuntimeProfiles(), []);
  const worker = store.createAgent({ name: 'New worker' });
  assert.throws(() => store.createTeam({ name: 'No manager', memberAgentIds: [worker.id] }), /请选择可用的项目经理/);
  const manager = store.createAgent({ name: 'New manager', kind: 'manager' });
  assert.equal(store.createTeam({ name: 'New team', memberAgentIds: [worker.id], managerAgentId: manager.id }).managerAgentId, manager.id);
  store.close();
});

test('reference rejection is based on relationships, not example identity', () => {
  const store = createStore({ workspaceRoot: tmpdir() }), [manager, writer] = store.listAgents();
  const team = store.createTeam({ name: 'T', managerAgentId: manager.id, memberAgentIds: [writer.id] });
  assert.throws(() => store.deleteAgent(manager.id), /团队/);
  assert.throws(() => store.deleteAgent(writer.id), /团队/);
  assert.throws(() => store.updateAgent(manager.id, { kind: 'business' }), /团队/);
  store.deleteTeam(team.id); store.deleteAgent(manager.id);
  const chat = store.openCommunication({ kind: 'agent', targetId: writer.id });
  assert.ok(chat.id); assert.throws(() => store.deleteAgent(writer.id), /沟通历史/);
  assert.throws(() => store.deleteAgent('missing'), /不存在/);
  assert.throws(() => store.deleteTeam('missing'), /不存在/);
  assert.throws(() => store.deleteWorkflowTemplate('missing'), /不存在/);
  store.close();
});

test('system provenance gives no special protection; frozen tasks and group history do', () => {
  const store = createFixtureStore(), team = store.listTeams()[0], task = store.listTasks()[0];
  assert.throws(() => store.deleteTeam(team.id), /任务引用/);
  assert.throws(() => store.deleteWorkflowTemplate(task.workflowTemplateId), /冻结快照引用/);
  const original = store.getTask(task.id), manager = store.listAgents().find(item => item.kind === 'manager');
  store.updateAgent(manager.id, { systemPrompt: 'Edited', status: 'inactive' });
  assert.deepEqual(store.getTask(task.id), original);
  const taskCount = store.listTasks().length;
  assert.throws(() => store.createTask({ title: 'Unavailable manager', objective: 'No work may begin', teamId: team.id, workflowTemplateId: task.workflowTemplateId, workspacePath: tmpdir() }), /经理已停用/);
  assert.equal(store.listTasks().length, taskCount);
  const unused = store.listWorkflowTemplates().find(item => item.id === 'bug_fix');
  assert.equal(unused.system, true); store.deleteWorkflowTemplate(unused.id);
  assert.throws(() => store.createTeam({ name: 'Group', managerAgentId: manager.id, memberAgentIds: ['agent_analyst'] }), /项目经理/);
  store.updateAgent(manager.id, { status: 'active' });
  const extra = store.createTeam({ name: 'Group', managerAgentId: manager.id, memberAgentIds: ['agent_analyst'] });
  store.openCommunication({ kind: 'team', targetId: extra.id });
  assert.throws(() => store.deleteTeam(extra.id), /沟通历史/);
  store.close();
});

test('failed persistence rolls back catalog removal and its audit atomically', () => {
  const options = fixture(), store = createStore(options), database = new DatabaseSync(options.databasePath);
  const team = store.createTeam({ name: 'Disposable', memberAgentIds: ['agent_analyst'] });
  const before = store.snapshot();
  database.exec("CREATE TRIGGER reject_catalog BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT,'catalog save rejected'); END;");
  for (const command of [() => store.deleteTeam(team.id), () => store.deleteAgent('agent_tester'), () => store.deleteWorkflowTemplate('content_delivery'), () => store.deleteRuntimeProfile(store.listRuntimeProfiles().find(item => item.provider === 'codex').id)]) {
    assert.throws(command, /catalog save rejected/); assert.deepEqual(store.snapshot(), before);
  }
  database.exec('DROP TRIGGER reject_catalog'); store.deleteTeam(team.id);
  database.close(); store.close();
});

test('role migration changes only current employees, never frozen Task/Run or communication snapshots', () => {
  const options = fixture(), fixtureStore = createFixtureStore(options), task = fixtureStore.listTasks()[0], run = fixtureStore.createRun(task.id);
  const chat = fixtureStore.openCommunication({ kind: 'agent', targetId: 'agent_analyst' });
  fixtureStore.sendCommunication(chat.id, { content: 'Queued frozen input', clientRequestId: 'legacy-snapshot' });
  const state = fixtureStore.snapshot(); fixtureStore.close();
  state.agents[0].role = 'Legacy current label';
  state.tasks[0].memberSnapshots[0].role = 'Historical task label';
  state.runs[0].participants[0].role = 'Historical run label';
  state.communicationDeliveries[0].agentSnapshot.role = 'Historical queued label';
  const taskSnapshot = structuredClone(state.tasks[0]), runSnapshot = structuredClone(state.runs[0]);
  const persistence = createSqlitePersistence(options.databasePath); persistence.save(state); persistence.close();
  const store = createStore(options);
  assert.ok(store.listAgents().every(item => !Object.hasOwn(item, 'role')));
  assert.deepEqual(store.getTask(task.id), taskSnapshot); assert.deepEqual(store.getRun(run.id), runSnapshot);
  assert.deepEqual(store.snapshot().communicationDeliveries, state.communicationDeliveries);
  const worker = store.createAgent({ name: 'No label', role: 'ignored legacy input', description: 'Evidence-based editor' });
  assert.equal(Object.hasOwn(worker, 'role'), false);
  store.updateAgent(worker.id, { role: 'still ignored' });
  assert.equal(Object.hasOwn(store.listAgents().find(item => item.id === worker.id), 'role'), false);
  store.close();
});

test('current workflow writes reject obsolete staffing/repository parameters without mutation', () => {
  const store = createStore(fixture());
  const definition = {name:'Current workflow',nodes:[{id:'write',title:'Write',staffingGuidance:'An evidence-based editor'}]};
  const created = store.createWorkflowTemplate(definition);
  assert.ok(!Object.hasOwn(created.nodes[0], 'repositoryPath'));
  const before = store.snapshot();
  for (const key of ['ownerRole','repositoryPath','reuseOwnerFrom']) {
    const invalid = {...definition,nodes:[{...definition.nodes[0],[key]:'unsupported'}]};
    assert.throws(() => store.createWorkflowTemplate(invalid), /不接受/);
    assert.throws(() => store.updateWorkflowTemplate(created.id,invalid), /不接受/);
  }
  assert.deepEqual(store.snapshot(),before);
  store.updateWorkflowTemplate(created.id,{...definition,description:'Updated current definition'});
  assert.equal(store.listWorkflowTemplates().find(item=>item.id===created.id).description,'Updated current definition');
  store.close();
});
