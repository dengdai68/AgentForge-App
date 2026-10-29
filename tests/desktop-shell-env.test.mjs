import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadLoginShellEnvironment } from '../apps/electron/login-shell-env.mjs';

const hasZsh = existsSync('/bin/zsh');
const thinPath = '/usr/bin:/bin:/usr/sbin:/sbin';
async function fixture() {
  await mkdir(resolve('.data'), { recursive: true });
  const root = await mkdtemp(resolve('.data/desktop-shell-env-'));
  const environment = { ...process.env, HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', PATH: thinPath };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return { root, environment };
}

test('non-Mac and unsupported shells keep inherited values without executing profiles', async () => {
  const environment = { SHELL: 'not-an-absolute-shell', PATH: thinPath, MARKER: 'preserve' }, rows = [];
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'win32', onDiagnostic: row => rows.push(row) }), environment);
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', onDiagnostic: row => rows.push(row) }), environment);
  assert.deepEqual(rows.map(row => row.reason), ['platform', 'unsupported-shell']);
});

test('real zsh exports reach an arbitrarily installed CLI; noise and private environment stay out of diagnostics', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(), rows = [];
  const bin = join(root, "user's custom tools"); await mkdir(bin);
  const node = join(bin, 'capture-node'); await symlink(process.execPath, node);
  const cli = join(bin, 'agentforge-shell-only-cli');
  await writeFile(cli, `#!${process.execPath}\nif(process.env.AF_SHELL_PRIVATE!=='fixture-private-value')process.exit(9); console.log('CLI_ENV_OK');\n`, { mode: 0o700 });
  await writeFile(join(root, '.zprofile'), "export AF_PROFILE_LOADED=yes\n");
  await writeFile(join(root, '.zshrc'), `[[ -z "$AGENTFORGE_BOOTSTRAP_TOKEN" ]] || exit 93\nprint -r -- "$ZSH_EXECUTION_STRING"\nprint -r -- 'welcome fixture-private-value'\nprint -r -- 'stderr fixture-private-value' >&2\nexport PATH=${JSON.stringify(bin)}:$PATH\nexport AF_SHELL_PRIVATE=fixture-private-value\nexport HOST=evil\nexport AGENTFORGE_DB_PATH=/wrong\nexport AGENTFORGE_BOOTSTRAP_TOKEN=wrong\nexport ELECTRON_RUN_AS_NODE=wrong\nexport NODE_PATH=/wrong\n`);
  const input = { ...environment, AGENTFORGE_DB_PATH: '/original', AGENTFORGE_BOOTSTRAP_TOKEN: 'original-private' };
  const result = await loadLoginShellEnvironment({ environment: input, executable: node, platform: 'darwin', onDiagnostic: row => rows.push(row) });
  assert.equal(result.AF_PROFILE_LOADED, 'yes'); assert.equal(result.AF_SHELL_PRIVATE, 'fixture-private-value');
  assert.equal(result.AGENTFORGE_DB_PATH, '/original'); assert.equal(result.AGENTFORGE_BOOTSTRAP_TOKEN, 'original-private');
  assert.equal(result.HOST, input.HOST); assert.equal(result.ELECTRON_RUN_AS_NODE, input.ELECTRON_RUN_AS_NODE); assert.equal(result.NODE_PATH, undefined);
  assert.equal(input.PATH, thinPath, 'do not mutate the parent environment');
  assert.equal((await promisify(execFile)('agentforge-shell-only-cli', [], { env: result })).stdout.trim(), 'CLI_ENV_OK');
  assert.equal(rows.length, 1); assert.equal(rows[0].attempt, 'interactive'); assert.equal(rows[0].status, 'applied');
  assert.doesNotMatch(JSON.stringify(rows), /fixture-private-value|original-private|welcome|stderr fixture/);
});

test('interactive failure uses the login fallback without pretending zshrc was loaded', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(), rows = [];
  await writeFile(join(root, '.zprofile'), 'export AF_LOGIN_FALLBACK=yes\n');
  await writeFile(join(root, '.zshrc'), 'export AF_PARTIAL_MUST_NOT_APPLY=yes\nexit 42\n');
  const result = await loadLoginShellEnvironment({ environment, platform: 'darwin', onDiagnostic: row => rows.push(row) });
  assert.equal(result.AF_LOGIN_FALLBACK, 'yes'); assert.equal(result.AF_PARTIAL_MUST_NOT_APPLY, undefined);
  assert.deepEqual(rows.map(row => [row.status, row.attempt, row.reason]), [['attempt-failed', 'interactive', 'non-zero-exit'], ['applied', 'login', 'success']]);
  assert.equal(rows[0].code, 42);
});

test('shell startup failure and missing shell never apply partial values or log raw output', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(), rows = [];
  await writeFile(join(root, '.zshenv'), 'print -r -- "PRIVATE_RAW_VALUE"\nprint -r -- "PRIVATE_RAW_VALUE" >&2\nexport AF_PARTIAL=yes\nexit 7\n');
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', onDiagnostic: row => rows.push(row) }), environment);
  assert.deepEqual(rows.map(row => row.status), ['attempt-failed', 'attempt-failed', 'fallback']);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_RAW_VALUE|AF_PARTIAL/);
  const missingRows = [];
  assert.deepEqual(await loadLoginShellEnvironment({ environment: { ...environment, SHELL: join(root, 'missing/zsh') }, platform: 'darwin', onDiagnostic: row => missingRows.push(row) }), { ...environment, SHELL: join(root, 'missing/zsh') });
  assert.ok(missingRows.some(row => row.reason === 'spawn-error' && row.errorCode === 'ENOENT'));
});

test('timeout and cancellation stop the capture process group and never apply partial output', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(), rows = [];
  await writeFile(join(root, '.zshenv'), 'export AF_PARTIAL=yes\n/bin/sleep 2\nprint late > "$HOME/late-marker"\n');
  const started = Date.now();
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', timeoutMs: 300, onDiagnostic: row => rows.push(row) }), environment);
  assert.ok(Date.now() - started < 1800);
  assert.ok(rows.some(row => row.reason === 'timeout'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try { assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', signal: controller.signal, timeoutMs: 5000 }), environment); }
  finally { clearTimeout(timer); }
  await new Promise(done => setTimeout(done, 2100));
  assert.equal(existsSync(join(root, 'late-marker')), false, 'no orphan shell may continue after timeout/quit');
});

test('output limits and malformed environment JSON retain the original environment without revealing values', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(), rows = [];
  await writeFile(join(root, '.zshenv'), 'repeat 1000 print -r -- "PRIVATE_BANNER_PRIVATE_BANNER"\n');
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', maxBytes: 128, onDiagnostic: row => rows.push(row) }), environment);
  assert.ok(rows.some(row => row.reason === 'output-limit')); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_BANNER/);
  await writeFile(join(root, '.zshenv'), '');
  const fake = join(root, 'capture');
  await writeFile(fake, `#!${process.execPath}\nconst code=process.argv.at(-1), begin=code.match(/AFENV_[a-f0-9]+_BEGIN/)[0], end=code.match(/AFENV_[a-f0-9]+_END/)[0];process.stdout.write(begin+'{"secret":"PRIVATE_JSON_VALUE",}'+end);\n`, { mode: 0o700 });
  rows.length = 0;
  assert.deepEqual(await loadLoginShellEnvironment({ environment, platform: 'darwin', executable: fake, onDiagnostic: row => rows.push(row) }), environment);
  assert.ok(rows.some(row => row.reason === 'invalid-json')); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_JSON_VALUE|SyntaxError/);
});

test('account-shell fallback and a broken diagnostic observer do not change successful capture', { skip: !hasZsh }, async () => {
  const { root, environment } = await fixture(); delete environment.SHELL;
  await writeFile(join(root, '.zshrc'), 'export AF_ACCOUNT_SHELL=yes\n');
  const result = await loadLoginShellEnvironment({ environment, platform: 'darwin', accountShell: () => '/bin/zsh', onDiagnostic: () => { throw new Error('observer'); } });
  assert.equal(result.AF_ACCOUNT_SHELL, 'yes');
  const source = await readFile(new URL('../apps/electron/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!child \|\| !await health\(controlOrigin, childInstanceId\)\) await startControlPlane\(\)/);
  assert.match(source, /shellEnvironment \|\|= loadLoginShellEnvironment/);
  assert.ok(source.indexOf('const inherited = await shellEnvironment') < source.indexOf('const bootstrapToken = randomBytes'));
  assert.match(source, /if \(quitting\) return/);
  assert.match(source, /shellEnvironmentAbort.abort\(\)/);
});
