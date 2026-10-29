import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCliInstallation } from '../apps/electron/cli-installation.mjs';

const execute = promisify(execFile);
async function fixture(shell = '/bin/zsh', options = {}) {
  await fs.mkdir('.data', { recursive: true });
  const root = await fs.mkdtemp(resolve('.data/cli-install-'));
  const home = join(root, "user's home $safe"), launcher = join(root, "Agent's Forge.app/Contents/Resources/cli/agentforge");
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(resolve(launcher, '..'), { recursive: true });
  await fs.writeFile(launcher, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
  return { root, home, launcher, command: join(home, '.local/bin/agentforge'), installer: createCliInstallation({ home, launcher, shell, ...options }) };
}
test('CLI installs idempotently with quoted paths; fresh zsh/bash login and interactive shells find the command', async () => {
  for (const shell of ['/bin/zsh', '/bin/bash'].filter(existsSync)) {
    const f = await fixture(shell), rc = join(f.home, shell.endsWith('zsh') ? '.zshrc' : '.bashrc');
    await fs.writeFile(rc, '# keep my config\r\nexport KEEP_ME=yes\r\n', { mode: 0o600 });
    assert.equal((await f.installer.status()).installed, false);
    assert.equal((await f.installer.install()).installed, true);
    const first = await fs.readFile(rc, 'utf8');
    assert.ok(first.startsWith('# keep my config\r\nexport KEEP_ME=yes\r\n'));
    assert.equal((await fs.stat(rc)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.command)).mode & 0o777, 0o755);
    await f.installer.install(); assert.equal(await fs.readFile(rc, 'utf8'), first);
    for (const args of [['-ilc', 'agentforge help'], ['-ic', 'agentforge help']]) {
      // Functional discovery, not a performance benchmark; same 30s budget as host shell capture.
      const result = await execute(shell, args, { env: { HOME: f.home, ZDOTDIR: f.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }, timeout: 30000 });
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    }
    const relocated = f.launcher.replace("Agent's Forge.app", 'Moved.app');
    await fs.mkdir(resolve(relocated, '..'), { recursive: true }); await fs.copyFile(f.launcher, relocated);
    const moved = createCliInstallation({ home: f.home, launcher: relocated, shell });
    assert.equal((await moved.status()).installed, false); assert.equal((await moved.install()).installed, true);
    assert.match(await fs.readFile(f.command, 'utf8'), /Moved.app/);
  }
});
test('CLI refuses foreign/empty commands, link targets, malformed profiles and unsafe modes without overwriting', async () => {
  for (const kind of ['foreign', 'empty', 'link', 'dangling', 'hardlink', 'directory-link', 'profile-link', 'readonly', 'writable', 'markers', 'oversize', 'binary']) {
    const f = await fixture(); await fs.mkdir(join(f.home, '.local/bin'), { recursive: true });
    const rc = join(f.home, '.zshrc'), outside = join(f.root, 'untouched');
    await fs.writeFile(outside, 'preserve');
    if (kind === 'foreign' || kind === 'empty') await fs.writeFile(f.command, kind === 'empty' ? '' : 'other command');
    if (kind === 'link' || kind === 'dangling') await fs.symlink(kind === 'link' ? outside : join(f.root, 'missing'), f.command);
    if (kind === 'hardlink') await fs.link(outside, f.command);
    if (kind === 'directory-link') { await fs.rmdir(join(f.home, '.local/bin')); await fs.symlink(f.root, join(f.home, '.local/bin')); }
    if (kind === 'profile-link') await fs.symlink(outside, rc);
    if (kind === 'readonly' || kind === 'writable') { await fs.writeFile(rc, '# existing'); await fs.chmod(rc, kind === 'readonly' ? 0o400 : 0o666); }
    if (kind === 'markers') await fs.writeFile(rc, '# >>> AgentForge CLI PATH >>>\n# incomplete');
    if (kind === 'oversize') await fs.writeFile(rc, 'x'.repeat(262145));
    if (kind === 'binary') await fs.writeFile(rc, Buffer.from([0xff, 0xfe]));
    assert.equal((await f.installer.status()).canInstall, false, kind);
    await assert.rejects(f.installer.install(), undefined, kind);
    assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
    await assert.rejects(fs.access(join(f.home, '.zprofile')), /ENOENT/);
  }
});
test('CLI chooses existing bash login profile and declines unsupported custom Shell configuration', async () => {
  const f = await fixture('/bin/bash'); await fs.writeFile(join(f.home, '.bash_login'), '# login');
  await fs.symlink('/irrelevant/missing', join(f.home, '.profile'));
  const status = await f.installer.install(); assert.ok(status.profilePaths.includes(join(f.home, '.bash_login')));
  await assert.rejects(fs.access(join(f.home, '.bash_profile')), /ENOENT/);
  for (const options of [{ shell: '/bin/fish' }, { shell: '/bin/zsh', zdotdir: '/custom' }]) {
    const other = createCliInstallation({ home: f.home, launcher: f.launcher, ...options });
    assert.equal((await other.status()).canInstall, false); await assert.rejects(other.install(), { code: 'CLI_SHELL' });
  }
  await fs.chmod(f.command, 0o644); assert.equal((await f.installer.status()).installed, false);
});
test('CLI preserves requested file modes under restrictive umask and rechecks confirmed bash file selection', async () => {
  const f = await fixture('/bin/bash'), previous = process.umask(0o077);
  try {
    const status = await f.installer.status();
    await fs.writeFile(join(f.home, '.bash_login'), '# appeared while confirming');
    await assert.rejects(f.installer.install(status.profilePaths), { code: 'CLI_CHANGED' });
    await assert.rejects(fs.access(f.command), /ENOENT/);
    assert.equal((await f.installer.install()).installed, true);
    assert.equal((await fs.stat(f.command)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(join(f.home, '.bash_login'))).mode & 0o777, 0o600);
  } finally { process.umask(previous); }
});
test('CLI rolls back committed content after a write failure and preserves concurrent edits', async () => {
  const f = await fixture(), rc = join(f.home, '.zshrc'); await fs.writeFile(rc, '# original', { mode: 0o600 });
  const broken = createCliInstallation({ home: f.home, launcher: f.launcher, fileSystem: { ...fs, rename: async (from, to) => {
    if (to === rc) throw Object.assign(new Error('fixture failure'), { code: 'EIO' }); return fs.rename(from, to);
  } } });
  await assert.rejects(broken.install(), { code: 'EIO' });
  assert.equal(await fs.readFile(rc, 'utf8'), '# original');
  for (const path of [f.command, join(f.home, '.zprofile')]) await assert.rejects(fs.access(path), /ENOENT/);
  let reads = 0;
  const concurrent = createCliInstallation({ home: f.home, launcher: f.launcher, fileSystem: { ...fs, open: async (path, flags) => {
    if (path === rc && ++reads === 2) await fs.writeFile(rc, '# user edited'); return fs.open(path, flags);
  } } });
  await assert.rejects(concurrent.install(), { code: 'CLI_CHANGED' });
  assert.equal(await fs.readFile(rc, 'utf8'), '# user edited');
  await assert.rejects(fs.access(f.command), /ENOENT/);
});
