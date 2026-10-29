import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPassword } from '../cli/password.mjs';
import { execute as executeCommand, run as runCommand } from '../cli/main.mjs';

const origin = 'http://127.0.0.1:51983', instanceId = '11111111-2222-4333-8444-555555555555';
const endpointRoot = await mkdtemp(join(tmpdir(), 'af-password-endpoint-')), endpointFile = join(endpointRoot, 'endpoint.json');
await writeFile(endpointFile, JSON.stringify({ origin, instanceId }), { mode: 0o600 });
after(() => rm(endpointRoot, { recursive: true, force: true }));
function connected(command, args, options = {}) {
  if (!args.includes('--session-file')) return command(args, options);
  return command([...args, '--endpoint-file', endpointFile], { ...options, fetcher: async (url, init) => url === origin + '/api/health'
    ? new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId })) : options.fetcher(url, init) });
}
const execute = (args, options) => connected(executeCommand, args, options);
const run = (args, options) => connected(runCommand, args, options);

function terminal(raw = false) {
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  input.isTTY = true; input.isRaw = raw;
  input.setRawMode = value => { input.isRaw = value; return input; };
  let display = ''; output.on('data', chunk => { display += chunk; });
  return { input, output, signals, display: () => display };
}

test('hidden terminal password supports editing, emits only fixed prompt, and restores previous raw mode', async () => {
  for (const previous of [false, true]) {
    const tty = terminal(previous), promise = readPassword(tty);
    assert.equal(tty.input.isRaw, true);
    tty.input.write('synthetic-secret-123X\x7f4\r');
    assert.equal(await promise, 'synthetic-secret-1234');
    assert.equal(tty.display(), '请输入密码：\n');
    assert.equal(tty.input.isRaw, previous); assert.equal(tty.input.isPaused(), true);
    assert.equal(tty.signals.listenerCount('SIGINT'), 0);
  }
});

test('Ctrl+C, EOF and process interrupt cancel without retaining keypress listeners or raw mode', async () => {
  for (const action of [tty => tty.input.write('partial-secret\x03'), tty => tty.input.write('\x04'), tty => tty.signals.emit('SIGINT')]) {
    const tty = terminal(), promise = readPassword(tty);
    action(tty);
    await assert.rejects(promise, error => error.code === 'CANCELLED' && error.exitCode === 130);
    assert.equal(tty.input.isRaw, false); assert.equal(tty.signals.listenerCount('SIGINT'), 0);
    assert.equal(tty.input.listenerCount('keypress'), 0);
    assert.equal(tty.display(), '请输入密码：\n');
  }
});

test('hidden Unicode input supports clear, cursor movement, home/end and forward deletion without rendering', async () => {
  const tty = terminal(), promise = readPassword(tty);
  tty.input.write('discard\x15密碼-1234567890');
  tty.input.write('\x01A\x05Z\x1b[D\x1b[3~\x1b[H\x1b[C\x7f\x1b[F\r');
  assert.equal(await promise, '密碼-1234567890');
  assert.equal(tty.display(), '请输入密码：\n'); assert.equal(tty.input.isRaw, false);
});

test('unsupported terminals, input errors, oversized paste and output failure fail closed without echo', async () => {
  for (const mode of ['unsupported', 'raw-failed', 'read-error', 'oversized', 'output-error']) {
    const tty = terminal();
    if (mode === 'unsupported') tty.input.isTTY = false;
    if (mode === 'raw-failed') tty.input.setRawMode = () => { throw new Error('private diagnostic'); };
    if (mode === 'output-error') tty.output.write = () => { throw new Error('private diagnostic'); };
    const promise = readPassword(tty);
    if (mode === 'read-error') tty.input.emit('error', new Error('private diagnostic'));
    if (mode === 'oversized') tty.input.write('SYNTHETIC_SECRET'.repeat(300));
    await assert.rejects(promise, error => error.code === 'USAGE' && !error.message.includes('private diagnostic'));
    assert.equal(tty.input.isRaw, false);
    assert.doesNotMatch(tty.display(), /SYNTHETIC_SECRET|private diagnostic/);
  }
});

test('interactive login uses existing HTTP auth/session and keeps passwords out of output and session files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-hidden-login-')), sessionFile = join(root, 'private/session.json');
  const tty = terminal(), password = 'synthetic-login-secret', cookie = 'agentforge_session=' + 'b'.repeat(64);
  const fetcher = async (url, options) => {
    assert.ok(url.startsWith(origin + '/api/auth/'));
    if (url.endsWith('/login')) {
      assert.equal(tty.input.isRaw, false, 'restore terminal before network request');
      assert.deepEqual(JSON.parse(options.body), { username: 'operator', password });
      return new Response(JSON.stringify({ username: 'operator', expiresAt: Date.now() + 100000 }), { headers: { 'set-cookie': cookie + '; Path=/' } });
    }
    assert.equal(options.headers.Cookie, cookie);
    return new Response(JSON.stringify({ username: 'operator' }));
  };
  let stdout = '', errors = '';
  const promise = run(['auth', 'login', '--username', 'operator', '--session-file', sessionFile, '--json'], { stdin: tty.input, stderr: tty.output, fetcher, write: value => { stdout += value; }, writeError: value => { errors += value; } });
  tty.input.write(password + '\r');
  assert.equal(await promise, 0); assert.equal(JSON.parse(stdout).data.username, 'operator');
  assert.equal(errors, ''); assert.equal(tty.display(), '请输入密码：\n');
  assert.ok(!stdout.includes(password) && !stdout.includes(cookie));
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(sessionFile, 'utf8')).includes(password));
  assert.equal((await execute(['auth', 'status', '--session-file', sessionFile], { fetcher })).username, 'operator');
  await execute(['auth', 'logout', '--session-file', sessionFile], { fetcher });
  await assert.rejects(stat(sessionFile), { code: 'ENOENT' });
});

test('cancel, invalid input and rejected authentication never save a session or echo the password', async () => {
  for (const value of ['partial\x03', '\x04', '\r', 'short\r', 'x'.repeat(129) + '\r', 'synthetic-wrong-password\r']) {
    const root = await mkdtemp(join(tmpdir(), 'af-cancel-login-')), sessionFile = join(root, 'session.json'), tty = terminal();
    let calls = 0, stdout = '', stderr = '';
    const promise = run(['auth', 'login', '--username', 'operator', '--session-file', sessionFile], { stdin: tty.input, stderr: tty.output, fetcher: async () => { calls++; return new Response('{"error":"invalid"}', { status: 401 }); }, write: value => { stdout += value; }, writeError: value => { stderr += value; } });
    tty.input.write(value);
    const code = await promise;
    assert.equal(code, value.includes('\x03') || value === '\x04' ? 130 : value.startsWith('synthetic-wrong') ? 3 : 2);
    assert.equal(calls, code === 3 ? 1 : 0); assert.equal(stdout, ''); assert.equal(tty.input.isRaw, false);
    assert.doesNotMatch(stderr + tty.display(), /synthetic-wrong-password|partial|short/);
    await assert.rejects(stat(sessionFile), { code: 'ENOENT' });
  }
});

test('noninteractive input requires explicit pipe mode; explicit pipe flag does not start a terminal prompt', async () => {
  let calls = 0; const fetcher = () => { calls++; assert.fail('invalid input must not request authentication'); };
  await assert.rejects(execute(['auth', 'login', '--username', 'operator'], { stdin: new PassThrough(), fetcher }), /非交互登录需要/);
  const tty = terminal();
  await assert.rejects(execute(['auth', 'login', '--username', 'operator', '--password-stdin'], { stdin: tty.input, stderr: tty.output, fetcher }), /需要管道输入/);
  await assert.rejects(execute(['auth', 'login'], { stdin: tty.input, stderr: tty.output, fetcher }), /--username/);
  assert.equal(tty.display(), ''); assert.equal(tty.input.isRaw, false); assert.equal(calls, 0);
});
