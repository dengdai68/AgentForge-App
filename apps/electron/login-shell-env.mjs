import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, isAbsolute } from 'node:path';

const protectedKey = key => key === 'HOST' || key.startsWith('AGENTFORGE_') || key.startsWith('ELECTRON_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function capture(shell, args, environment, { timeoutMs, signal, maxBytes }) {
  return new Promise(resolve => {
    let child, timer, stdout = '', stdoutBytes = 0, stderrBytes = 0, reason, errorCode, settled = false;
    const finish = (code = null, exitSignal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ stdout, stdoutBytes, stderrBytes, code, exitSignal, reason, errorCode });
    };
    const stop = cause => {
      if (settled) return;
      reason ||= cause;
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      child?.stdout?.destroy(); child?.stderr?.destroy();
      finish();
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) { reason = 'cancelled'; finish(); return; }
    try {
      child = spawn(shell, args, { env: environment, cwd: environment.HOME || '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reason = 'spawn-error'; errorCode = error.code; finish(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes + stderrBytes > maxBytes) stop('output-limit');
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stdoutBytes + stderrBytes > maxBytes) stop('output-limit'); });
    for (const stream of [child.stdout, child.stderr]) stream.once('error', error => { errorCode = error.code; stop('stream-error'); });
    child.once('error', error => { reason ||= 'spawn-error'; errorCode = error.code; });
    child.once('close', finish);
  });
}

function mergeEnvironment(original, captured) {
  const result = { ...original, ...captured };
  for (const key of Object.keys(result).filter(protectedKey)) {
    if (Object.hasOwn(original, key)) result[key] = original[key];
    else delete result[key];
  }
  return result;
}

// Independent implementation of the login-shell capture pattern used by Paseo.
// Values stay in memory; the observer receives only an explicit diagnostic shape.
export async function loadLoginShellEnvironment({ environment = process.env, platform = process.platform, executable = process.execPath, accountShell = () => userInfo().shell, timeoutMs = 30000, maxBytes = 1024 * 1024, signal, onDiagnostic = () => {} } = {}) {
  const original = { ...environment }, started = performance.now();
  const report = fields => { try { onDiagnostic({ ...fields, durationMs: Math.round(performance.now() - started) }); } catch { /* Observability cannot alter startup. */ } };
  const fallback = reason => { report({ status: 'fallback', reason }); return original; };
  if (platform !== 'darwin') { report({ status: 'skipped', reason: 'platform' }); return original; }
  let shell = original.SHELL;
  if (!shell) { try { shell = accountShell(); } catch { /* Use the Mac default below. */ } }
  if (!shell || shell === '/bin/false') shell = '/bin/zsh';
  if (!isAbsolute(shell) || !['zsh', 'bash', 'sh', 'fish'].includes(basename(shell))) return fallback('unsupported-shell');
  if (!isAbsolute(executable)) return fallback('invalid-node-path');
  const mark = randomBytes(16).toString('hex');
  const begin = `AFENV_${mark}_BEGIN`, end = `AFENV_${mark}_END`;
  const code = `process.stdout.write(${JSON.stringify(begin)}+JSON.stringify(process.env)+${JSON.stringify(end)})`;
  const command = `${quote(executable)} -e ${quote(code)}`;
  const shellEnvironment = Object.fromEntries(Object.entries(original).filter(([key]) => !protectedKey(key)));
  // Use the host's Node, even without a global Node installation. Never hand
  // the shell the control plane's private bootstrap/settings variables.
  Object.assign(shellEnvironment, { SHELL: shell, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' });
  const attempts = [['interactive', ['-i', '-l', '-c']], ['login', ['-l', '-c']]];
  for (const [index, [attempt, args]] of attempts.entries()) {
    if (signal?.aborted) return fallback('cancelled');
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) break;
    const budget = Math.max(1, Math.floor(index === 0 ? remaining / 2 : remaining));
    const result = await capture(shell, [...args, command], shellEnvironment, { timeoutMs: budget, signal, maxBytes });
    let reason = result.reason || (result.exitSignal ? 'signal' : result.code !== 0 ? 'non-zero-exit' : null), captured;
    // A verbose startup hook may echo the capture command itself, including
    // both marker literals. Select an actual framed object, not the first text.
    const match = new RegExp(`${begin}(\\{[\\s\\S]*\\})${end}`).exec(result.stdout);
    if (!reason) {
      if (!match) reason = 'marker-missing';
      else {
        // A JSON parse Error can quote secret values. Never log that Error or
        // stdout/stderr, even on malformed or partially successful capture.
        try {
          captured = JSON.parse(match[1]);
          if (!captured || Array.isArray(captured) || typeof captured !== 'object' || Object.entries(captured).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) reason = 'invalid-environment';
        } catch { reason = 'invalid-json'; }
      }
    }
    report({ status: reason ? 'attempt-failed' : 'applied', shell, attempt, reason: reason || 'success', code: result.code, exitSignal: result.exitSignal, errorCode: result.errorCode, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
      ...(!reason ? { beforePath: original.PATH || '', afterPath: captured.PATH || '' } : {}) });
    if (!reason) return mergeEnvironment(original, captured);
    if (reason === 'cancelled') return fallback(reason);
  }
  return fallback('attempts-exhausted');
}
