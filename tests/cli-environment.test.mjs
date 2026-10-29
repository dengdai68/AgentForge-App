import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { cliEnvironment } from '../server/runtime/cli-environment.mjs';

const exec = promisify(execFile);
const thinPath = '/usr/bin:/bin:/usr/sbin:/sbin';

test('Mac CLI fallback preserves explicit PATH priority and private environment boundaries', () => {
  const environment = { PATH: '/custom/bin:/usr/bin', ELECTRON_RUN_AS_NODE: '1', AGENTFORGE_BOOTSTRAP_TOKEN: 'private', KEEP: 'yes' };
  const result = cliEnvironment('/custom/nvm/bin/claude', { EXTRA: 'yes', ELECTRON_RUN_AS_NODE: '1' }, { environment, platform: 'darwin', homeDirectory: '/fixture/home' });
  assert.equal(result.PATH, '/custom/bin:/usr/bin:/custom/nvm/bin:/fixture/home/.local/bin:/fixture/home/.npm-global/bin:/fixture/home/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin');
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.AGENTFORGE_BOOTSTRAP_TOKEN, undefined);
  assert.equal(result.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(result.KEEP, 'yes'); assert.equal(result.EXTRA, 'yes');
  assert.equal(environment.PATH, '/custom/bin:/usr/bin');
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(cliEnvironment('claude', {}, { environment: {}, platform: 'darwin', homeDirectory: '/fixture' }).PATH.startsWith('/fixture/.local/bin:'), true);
  assert.equal(cliEnvironment('./claude', {}, { environment: { PATH: thinPath }, platform: 'darwin', homeDirectory: '/fixture' }).PATH.split(':').includes('.'), false);
  assert.equal(cliEnvironment('claude', {}, { environment, platform: 'linux' }).PATH, environment.PATH);
});

test('real processes find a user-installed CLI and its Node interpreter without a shell', async () => {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data/cli-path-test-'));
  const bin = join(root, '.local/bin'); await mkdir(bin, { recursive: true });
  const command = 'agentforge-path-fixture';
  await writeFile(join(bin, command), '#!/usr/bin/env node\nconsole.log("CLI_NODE_OK");\n', { mode: 0o700 });
  await symlink(process.execPath, join(bin, 'node'));
  await assert.rejects(exec(command, [], { env: { ...process.env, PATH: thinPath } }), error => error.code === 'ENOENT');
  const env = cliEnvironment(command, {}, { environment: { ...process.env, PATH: thinPath }, platform: 'darwin', homeDirectory: root });
  assert.equal((await exec(command, [], { env })).stdout.trim(), 'CLI_NODE_OK');
  // Nonstandard installs (e.g. nvm) work when the administrator supplies the CLI path.
  const custom = join(root, 'custom-node-version/bin'); await mkdir(custom, { recursive: true });
  const cli = join(custom, command);
  await writeFile(cli, '#!/usr/bin/env node\nconsole.log("CUSTOM_NODE_OK");\n', { mode: 0o700 });
  await symlink(process.execPath, join(custom, 'node'));
  assert.equal((await exec(cli, [], { env: cliEnvironment(cli, {}, { environment: { ...process.env, PATH: thinPath }, platform: 'darwin', homeDirectory: root }) })).stdout.trim(), 'CUSTOM_NODE_OK');
  await assert.rejects(exec(join(root, 'missing', command), [], { env }), error => error.code === 'ENOENT');
  await assert.rejects(exec(command, [], { env, cwd: join(root, 'missing-cwd') }), error => error.code === 'ENOENT');
});

test('Mac Claude/Codex invocations and Codex probes share the repaired GUI environment', { skip: process.platform !== 'darwin' }, async () => {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data/cli-adapter-test-'));
  const bin = join(root, '.local/bin'); await mkdir(bin, { recursive: true });
  const cli = join(bin, 'agentforge-adapter-fixture');
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(cli, `#!/usr/bin/env node
if (process.env.ELECTRON_RUN_AS_NODE || process.env.AGENTFORGE_BOOTSTRAP_TOKEN) throw new Error('bootstrap leaked');
if (process.argv.includes('features')) console.log('skip_host_skill_discovery stable true');
else if (process.argv.includes('list')) console.log('[]');
else {
 console.log(JSON.stringify({type:'result',structured_output:{status:'ok'}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"status":"ok"}'}}));
}
`, { mode: 0o700 });
  const moduleUrl = new URL('../server/runtime/local-cli.mjs', import.meta.url).href;
  const extensionsUrl = new URL('../server/runtime/extensions.mjs', import.meta.url).href;
  await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { runClaudeCodeCli, runCodexCli } from ${JSON.stringify(moduleUrl)};
    import { codexMarketArgs } from ${JSON.stringify(extensionsUrl)};
    const runtime = {executable:'agentforge-adapter-fixture',skillPaths:[]};
    for (const invoke of [runClaudeCodeCli,runCodexCli]) {
      const result = await invoke({runtime,workspacePath:${JSON.stringify(root)},traceDirectory:${JSON.stringify(root)},finalPath:${JSON.stringify(join(root, 'final'))},schemaPath:'unused-schema',outputSchema:{},prompt:'fixture',runId:'path-test',onEvent:async()=>{}});
      assert.deepEqual(JSON.parse(result.finalText), {status:'ok'});
      await assert.rejects(invoke({runtime:{...runtime,executable:${JSON.stringify(join(root, 'missing-cli'))}},workspacePath:${JSON.stringify(root)},traceDirectory:${JSON.stringify(root)},prompt:'fixture',runId:'missing-path-test',onEvent:async()=>{}}), /ENOENT/);
    }
    assert.ok((await codexMarketArgs(runtime,{},${JSON.stringify(root)})).includes('features.skip_host_skill_discovery=true'));
  `], { env: { ...process.env, HOME: root, PATH: thinPath, ELECTRON_RUN_AS_NODE: '1', AGENTFORGE_BOOTSTRAP_TOKEN: 'fixture-secret', AGENTFORGE_LOG_DIR: join(root, 'logs') }, timeout: 30000 });
});
