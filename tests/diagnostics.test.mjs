import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, stat, symlink, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDiagnosticLog, defaultDiagnosticRoot, diagnostic, diagnosticRedactor, instanceDiagnosticDirectory, withDiagnosticContext } from "../server/diagnostics.mjs";
import { runClaudeCodeCli, runCodexCli } from "../server/runtime/local-cli.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { diagnoseLaunch } from "../server/runtime/launch-diagnostics.mjs";

test('launch diagnosis separates missing CLI, cwd, permissions and env interpreter without running anything', async () => {
  const { root } = await fixture();
  const bin = join(root, 'bin'); await mkdir(bin);
  const missing = await diagnoseLaunch({ command: 'af-no-such-cli', cwd: root, searchPath: bin, provider: 'Claude Code' });
  assert.equal(missing.workingDirectory.usable, true);
  assert.equal(missing.candidates.length, 1);
  assert.equal(missing.candidates[0].exists, false);
  assert.match(missing.problems.join(' '), /未找到 CLI/);
  assert.match(missing.nextSteps.join(' '), /command -v claude/);
  const cli = join(bin, 'fixture');
  await writeFile(cli, '#!/usr/bin/env node\nthrow new Error("MUST_NOT_RUN");\n', { mode: 0o700 });
  const interpreter = await diagnoseLaunch({ command: 'fixture', cwd: root, searchPath: bin, provider: 'Codex' });
  assert.equal(interpreter.candidates[0].usable, true);
  assert.equal(interpreter.interpreter.command, 'node');
  assert.equal(interpreter.interpreter.usable, false);
  assert.match(interpreter.problems.join(' '), /解释器不可用/);
  const cwd = await diagnoseLaunch({ command: cli, cwd: join(root, 'missing-cwd'), searchPath: bin, provider: 'Claude Code' });
  assert.equal(cwd.workingDirectory.exists, false);
  assert.match(cwd.problems.join(' '), /工作目录不存在/);
  await writeFile(join(bin, 'no-permission'), '#!/bin/sh\n', { mode: 0o600 });
  const denied = await diagnoseLaunch({ command: 'no-permission', cwd: root, searchPath: bin, provider: 'Claude Code' });
  assert.equal(denied.candidates[0].executable, false);
  assert.match(denied.problems.join(' '), /无执行权限/);
  await symlink(process.execPath, join(bin, 'node'));
  const repaired = await diagnoseLaunch({ command: 'fixture', cwd: root, searchPath: bin, provider: 'Codex' });
  assert.equal(repaired.interpreter.usable, true);
  assert.deepEqual(repaired.problems, []);
});

async function fixture() {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data/diagnostics-test-'));
  return { root, logger: createDiagnosticLog({ directory: join(root, 'logs') }) };
}

test('diagnostic directories are stable per instance and separate disposable profiles', () => {
  const first = instanceDiagnosticDirectory('/private/fixture-one/agentforge.sqlite');
  assert.equal(first, instanceDiagnosticDirectory('/private/fixture-one/agentforge.sqlite'));
  assert.notEqual(first, instanceDiagnosticDirectory('/private/fixture-two/agentforge.sqlite'));
  assert.doesNotMatch(first, /fixture-one|agentforge\.sqlite/);
  assert.ok(first.startsWith(defaultDiagnosticRoot() + '/'), 'default diagnostics live under ~/.agentforge/logs');
  assert.equal(defaultDiagnosticRoot('/fixture-home'), '/fixture-home/.agentforge/logs');
});

test('diagnostics preserve original error stack, cause, errno and complete long text', async () => {
  const { root, logger } = await fixture();
  const error = Object.assign(new Error('custom CLI failure: DNS diagnostic', { cause: new Error('underlying TLS detail') }), { code: 'CUSTOM', errno: -2, syscall: 'spawn cli' });
  logger.write('failure', { error, text: 'x'.repeat(20000) + 'TAIL' });
  const row = JSON.parse(await readFile(logger.status().filePath, 'utf8'));
  assert.equal(row.error.message, error.message);
  assert.equal(row.error.stack, error.stack);
  assert.equal(row.error.cause.message, error.cause.message);
  assert.equal(row.error.errno, -2);
  assert.equal(row.text.length, 20004);
  assert.equal((await stat(logger.status().filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'logs'))).mode & 0o777, 0o700);
});

test('credential/prompt redaction preserves diagnostic wording, including error objects', () => {
  const clean = diagnosticRedactor({ secrets: ['UNLABELLED_PRIVATE_VALUE'], prompt: 'This is the complete private prompt.' });
  const result = clean({ error: new Error('DNS failed UNLABELLED_PRIVATE_VALUE'), text: 'Bearer some-secret https://user:pass@example.com token=abc This is the complete private prompt.', apiKey: 'another-secret', signature: 'hidden' });
  assert.match(result.error.message, /DNS failed/);
  assert.doesNotMatch(JSON.stringify(result), /UNLABELLED_PRIVATE_VALUE|some-secret|user:pass|token=abc|complete private prompt|another-secret|hidden/);
  assert.equal(clean({ type: 'redacted_thinking', data: 'ENCRYPTED_PRIVATE_VALUE' }).data, '[REDACTED]');
  assert.equal(clean('-----BEGIN PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]');
  assert.equal(clean('opaque-key-body'), '[REDACTED PRIVATE KEY]');
  assert.equal(clean('-----END PRIVATE KEY-----'), '[REDACTED PRIVATE KEY]');
  assert.equal(clean('ordinary error detail'), 'ordinary error detail');
});

test('concurrent invocation correlation does not leak between employees', async () => {
  const { logger } = await fixture();
  await Promise.all(['a', 'b'].map(agentId => withDiagnosticContext({ agentId }, async () => {
    await new Promise(done => setTimeout(done, agentId === 'a' ? 10 : 1));
    diagnostic('probe', { expected: agentId });
  }, { logger })));
  const rows = (await readFile(logger.status().filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.agentId, row.expected);
});

test('rotation and new process-like logger preserve old files; invalid target reports failure', async () => {
  const { root } = await fixture(), directory = join(root, 'rotation');
  const first = createDiagnosticLog({ directory, maxBytes: 1 });
  first.write('first'); const old = first.status().filePath;
  first.write('second');
  createDiagnosticLog({ directory }).write('restart');
  assert.equal((await readdir(directory)).length, 3);
  assert.match(await readFile(old, 'utf8'), /first/);
  await symlink(directory, join(root, 'link'));
  const invalid = createDiagnosticLog({ directory: join(root, 'link') });
  assert.equal(invalid.write('must-not-write'), false);
  assert.equal(invalid.status().available, false);
  assert.equal((await readdir(directory)).length, 3);
});

test('fatal process exception is written without swallowing the process failure', async () => {
  const { root } = await fixture(), directory = join(root, 'fatal');
  const moduleUrl = new URL('../server/diagnostics.mjs', import.meta.url).href;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {installProcessDiagnostics} from ${JSON.stringify(moduleUrl)}; installProcessDiagnostics('probe'); throw new Error('ORIGINAL_FATAL_DIAGNOSTIC');`], { env: { ...process.env, AGENTFORGE_LOG_DIR: directory } }), error => error.code === 1);
  const rows = (await readFile(join(directory, (await readdir(directory))[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.event === 'process.uncaught' && row.error.message === 'ORIGINAL_FATAL_DIAGNOSTIC' && row.error.stack.includes('Error: ORIGINAL_FATAL_DIAGNOSTIC')));
  assert.ok(rows.some(row => row.event === 'process.exit' && row.code === 1));
});

test('real child failures retain stdout, stderr tail, exit code and ENOENT before audit mapping', async () => {
  const { root, logger } = await fixture();
  const executable = join(root, 'provider');
  await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes("features")){console.log("skip_host_skill_discovery stable false");process.exit(0);}if(process.argv.includes("mcp")&&process.argv.includes("list")){console.log("[]");process.exit(0);}\nconsole.error('detailed custom failure ' + 'x'.repeat(16000) + ' END_DIAGNOSTIC');\nconsole.log(JSON.stringify({type:'error', message:'original provider error UNIQUE_PROVIDER_DETAIL'}));\nprocess.exitCode=7;\n`, { mode: 0o700 });
  for (const invoke of [runClaudeCodeCli, runCodexCli]) {
    await withDiagnosticContext({ agentId: 'probe', deliveryId: 'delivery' }, async () => {
      const input = { runtime: { executable, provider: 'fixture' }, workspacePath: root, traceDirectory: root, finalPath: join(root, 'missing-final'), schemaPath: join(root, 'schema.json'), outputSchema: {}, prompt: 'private prompt', runId: 'probe', onEvent: async () => {} };
      await assert.rejects(invoke(input));
      await assert.rejects(invoke({ ...input, runtime: { ...input.runtime, executable: join(root, 'missing-cli') } }));
    }, { logger });
  }
  const rows = (await readFile(logger.status().filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.event === 'provider.exit' && row.code === 7).length, 2);
  assert.ok(rows.some(row => row.event === 'provider.stderr' && row.text.endsWith('END_DIAGNOSTIC') && row.text.length > 16000));
  assert.ok(rows.some(row => row.event === 'provider.stdout' && row.frame.message.includes('UNIQUE_PROVIDER_DETAIL')));
  assert.ok(rows.some(row => row.event === 'provider.spawn_error' && row.error.code === 'ENOENT' && row.error.stack.includes('missing-cli')));
  const launch = rows.filter(row => row.event === 'provider.launch_diagnostic');
  assert.equal(launch.length, 2);
  assert.ok(launch.every(row => row.candidates[0].exists === false && row.workingDirectory.usable && row.nextSteps.length));
  assert.ok(rows.every(row => row.agentId === 'probe' && row.deliveryId === 'delivery'));
});

test('npm test entry pins diagnostics to a disposable fixture and strips inherited instance variables', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.test, 'node scripts/run-tests.mjs', 'npm test must go through the isolating runner');
  const runner = await readFile(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /AGENTFORGE_LOG_DIR \|\|=/, 'runner pins a disposable log directory');
  for (const name of ['AGENTFORGE_DB_PATH', 'AGENTFORGE_AUTH_DB_PATH', 'AGENTFORGE_RUN_FILES_ROOT', 'AGENTFORGE_RUNTIME_CONFIG_ROOT', 'AGENTFORGE_WORKSPACE_ROOT', 'AGENTFORGE_DESKTOP_DATA_ROOT', 'AGENTFORGE_BOOTSTRAP_TOKEN']) {
    assert.ok(runner.includes(`"${name}"`), `runner strips inherited ${name}`);
  }
});

test('test entry isolates fixture Git commands from a hook caller worktree', async () => {
  const { testEnvironment } = await import('../scripts/run-tests.mjs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import('node:fs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'af-hook-isolation-')));
  try {
    const caller = join(root, 'caller'), fixture = join(root, 'fixture');
    mkdirSync(caller); mkdirSync(fixture);
    const env = testEnvironment({ ...process.env, AGENTFORGE_LOG_DIR: join(root, 'logs') });
    for (const repo of [caller, fixture]) execFileSync('git', ['-C', repo, 'init', '--quiet'], { env });
    const hook = { ...env, GIT_DIR: join(caller, '.git'), GIT_WORK_TREE: caller, GIT_INDEX_FILE: join(caller, '.git', 'index') };
    const isolated = testEnvironment(hook);
    assert.equal(execFileSync('git', ['-C', fixture, 'rev-parse', '--show-toplevel'], { env: isolated, encoding: 'utf8' }).trim(), fixture);
    execFileSync('git', ['-C', fixture, 'config', 'fixture.marker', 'isolated'], { env: isolated });
    assert.throws(() => execFileSync('git', ['-C', caller, 'config', '--get', 'fixture.marker'], { env, stdio: 'pipe' }));
    assert.equal(hook.GIT_DIR, join(caller, '.git'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
