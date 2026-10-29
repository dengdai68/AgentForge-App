import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const begin = '# >>> AgentForge CLI PATH >>>', end = '# <<< AgentForge CLI PATH <<<';
const launcherMark = '# AgentForge managed CLI launcher v1';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const failure = (code, message) => Object.assign(new Error(message), { code });
const owned = info => !process.getuid || info.uid === process.getuid();
const safe = info => owned(info) && !(info.mode & 0o022);
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b);

// Only host-derived home/launcher/shell; never accept renderer paths or content.
export function createCliInstallation({ home, launcher, shell = '/bin/zsh', zdotdir, fileSystem = fs }) {
  if (![home, launcher, shell].every(value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value)) || resolve(home) === '/') throw failure('CLI_LOCATION', 'CLI 安装位置无效');
  home = resolve(home);
  const bin = join(home, '.local/bin'), commandPath = join(bin, 'agentforge');
  const wrapper = Buffer.from(`#!/bin/sh\n${launcherMark}\nexec ${quote(launcher)} "$@"\n`);
  const family = basename(shell);
  const supported = ['zsh', 'bash'].includes(family) && (!zdotdir || resolve(zdotdir) === home);
  async function directories(create = false) {
    for (const path of [home, join(home, '.local'), bin]) {
      let info;
      try { info = await fileSystem.lstat(path); }
      catch (error) {
        if (error.code !== 'ENOENT' || path === home) throw error;
        if (!create) continue;
        try { await fileSystem.mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        info = await fileSystem.lstat(path);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !safe(info)) throw failure('CLI_DIRECTORY', '安装目录是链接、非本用户所有或可被其他用户写入；请手工处理');
    }
  }
  async function read(path) {
    let file;
    try {
      file = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || !safe(info) || !(info.mode & 0o200) || info.size > 256 * 1024) throw failure('CLI_FILE', '安装目标必须是本用户可写的常规文本文件，不能为链接/多硬链接、异常权限或超过256KiB');
      const bytes = await file.readFile();
      if (bytes.length > 256 * 1024 || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw failure('CLI_FILE', '安装目标不是受支持的有界 UTF-8 文本文件');
      return { path, bytes, mode: info.mode & 0o777 };
    } catch (error) {
      if (error.code === 'ENOENT') return { path, bytes: null, mode: path === commandPath ? 0o755 : 0o644 };
      if (error.code === 'ELOOP') throw failure('CLI_FILE', '安装目标是符号链接，请手工处理；不会跟随或覆盖');
      throw error;
    } finally { await file?.close(); }
  }
  function pathContent(bytes) {
    const previous = bytes?.toString('utf8') || '', newline = previous.includes('\r\n') ? '\r\n' : '\n';
    // Shell syntax requires LF even when untouched user content contains CRLF.
    const block = `${begin}\ncase ":\${PATH-}:" in\n  *${quote(':' + bin + ':')}*) ;;\n  *) export PATH=${quote(bin)}"\${PATH:+:$PATH}" ;;\nesac\n${end}\n`;
    if (previous.includes(begin) || previous.includes(end)) {
      if (previous.split(begin).length !== 2 || previous.split(end).length !== 2) throw failure('CLI_MARKERS', 'PATH 标记块重复或不完整，请先手工修复；其他配置未覆盖');
      const pattern = /^# >>> AgentForge CLI PATH >>>\r?\n[\s\S]*?^# <<< AgentForge CLI PATH <<<(?:\r?\n|$)/m;
      if (!pattern.test(previous)) throw failure('CLI_MARKERS', 'PATH 标记块不完整，请先手工修复');
      return Buffer.from(previous.replace(pattern, () => block));
    }
    return Buffer.from(previous + (previous && !previous.endsWith('\n') ? newline : '') + block);
  }
  async function plan() {
    if (!supported) throw failure('CLI_SHELL', '自动安装仅支持默认目录的 zsh/bash；自定义 ZDOTDIR 或其他 Shell 请手工加入 ~/.local/bin');
    await directories();
    await fileSystem.access(launcher, constants.X_OK);
    const command = await read(commandPath), text = command.bytes?.toString('utf8');
    // Strictly recognize our own complete forwarding script, not a marker alone.
    if (command.bytes !== null && !/^#!\/bin\/sh\n# AgentForge managed CLI launcher v1\nexec '(?:[^'\n]|'\\'')*\/Contents\/Resources\/cli\/agentforge' "\$@"\n$/.test(text)) throw failure('CLI_CONFLICT', '已有非 AgentForge 的 agentforge 命令；不会覆盖，请先自行确认和处理');
    if (command.bytes !== null && !(command.mode & 0o100)) throw failure('CLI_FILE', '已有受管命令缺少本用户执行权限；请先检查并恢复执行权限，再重试');
    let profiles;
    if (family === 'zsh') profiles = [await read(join(home, '.zprofile')), await read(join(home, '.zshrc'))];
    else {
      let login;
      for (const name of ['.bash_profile', '.bash_login', '.profile']) {
        const item = await read(join(home, name));
        if (!login) login = item;
        if (item.bytes !== null) { login = item; break; }
      }
      profiles = [login, await read(join(home, '.bashrc'))];
    }
    const changes = [{ ...command, next: wrapper }, ...profiles.map(item => ({ ...item, next: pathContent(item.bytes) }))];
    return { changes, profilePaths: profiles.map(item => item.path) };
  }
  async function status() {
    try {
      const result = await plan();
      return { supported: true, canInstall: true, installed: result.changes.every(item => same(item.bytes, item.next)), commandPath, profilePaths: result.profilePaths, shell: family, message: '' };
    } catch (error) {
      return { supported, canInstall: false, installed: false, commandPath, profilePaths: [], shell: family, code: error.code || 'CLI_UNAVAILABLE', message: error.code?.startsWith('CLI_') ? error.message : '无法读取安装位置或包内 CLI；请检查权限与应用位置，不会使用 sudo' };
    }
  }
  async function replace(snapshot, next) {
    await directories();
    const current = await read(snapshot.path);
    if (!same(current.bytes, snapshot.bytes) || current.mode !== snapshot.mode) throw failure('CLI_CHANGED', '安装文件在操作期间发生变化；已停止，请检查后重试');
    if (next === null) { await fileSystem.unlink(snapshot.path); return; }
    const temporary = join(dirname(snapshot.path), `.agentforge-cli-${randomUUID()}.tmp`);
    try {
      await fileSystem.writeFile(temporary, next, { mode: snapshot.mode, flag: 'wx' });
      await fileSystem.chmod(temporary, snapshot.mode);
      // New files are never renamed over a competing, newly created command.
      if (current.bytes === null) { await fileSystem.link(temporary, snapshot.path); }
      else { await fileSystem.rename(temporary, snapshot.path); }
    } finally { await fileSystem.unlink(temporary).catch(() => {}); }
  }
  return {
    status,
    async install(expectedProfilePaths) {
      const { changes, profilePaths } = await plan(), committed = [];
      if (expectedProfilePaths && JSON.stringify(profilePaths) !== JSON.stringify(expectedProfilePaths)) throw failure('CLI_CHANGED', 'Shell 配置文件选择在确认后发生变化；请重新检查并确认');
      await directories(true);
      try {
        for (const change of changes.filter(item => !same(item.bytes, item.next))) { await replace(change, change.next); committed.push(change); }
      } catch (error) {
        let rollbackIncomplete = false;
        for (const item of committed.reverse()) {
          try { await replace({ ...item, bytes: item.next }, item.bytes); } catch { rollbackIncomplete = true; }
        }
        if (rollbackIncomplete) throw failure('CLI_PARTIAL', '安装未完成，部分受管文件未能回滚（可能有并发编辑）；请检查后重试，不会覆盖他人修改');
        throw error;
      }
      return status();
    }
  };
}
