import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

export const maxBytes = 1024 * 1024;
export class CliError extends Error {
  constructor(code, message, hint, exitCode = 2, status) { super(message); Object.assign(this, { code, hint, exitCode, ...(status ? { status } : {}) }); }
}
export const usage = (message, hint = '在原命令后加 --help 查看参数；完整字段示例可用 agentforge schema agents 查看。') => new CliError('USAGE', message, hint);

export async function readBounded(stream, limit = maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) { stream.destroy?.(); throw usage('输入超过大小上限', '配置JSON最多1MiB，密码最多128字符；不要传完整仓库或日志。'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function readInput(path, stdin) {
  if (!path) throw usage('写命令需要 --file JSON文件 或 --file -');
  let body;
  try {
    if (path === '-') {
      if (stdin.isTTY) throw usage('--file - 需要管道输入JSON，不在终端等待输入');
      body = await readBounded(stdin);
    } else {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw usage('配置输入必须是常规文件');
        body = await readBounded(file.createReadStream({ autoClose: false }));
      } finally { await file.close(); }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw usage('无法读取配置文件', '检查 --file 路径、读取权限和文件类型；不跟随文件符号链接。');
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw usage('配置必须是有效JSON对象', '使用 schema 的 example；不要传 Markdown 围栏、数组、截断JSON或注释。输入原文不会回显。'); }
}

export function validateInput(value, schema, path = 'input', partial = false) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) throw usage(`${path} 类型应为 ${types.join('|')}`);
  if(typeof value==='number' && (schema.minimum!==undefined && value<schema.minimum || schema.maximum!==undefined && value>schema.maximum))throw usage(`${path} 必须介于 ${schema.minimum}–${schema.maximum}`);
  if (schema.enum && !schema.enum.includes(value)) throw usage(`${path} 必须是 ${schema.enum.join(' / ')}`);
  if (typeof value === 'string' && (schema.maxLength && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value))) throw usage(`${path} 不符合长度或格式约束`);
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) throw usage(`${path} 至少需要 ${schema.minItems} 项`);
    value.forEach((item, index) => validateInput(item, schema.items, `${path}[${index}]`));
  } else if (type === 'object') {
    if(schema.minProperties && Object.keys(value).length<schema.minProperties)throw usage(`${path} 至少提供 ${schema.minProperties} 个字段`);
    if (!partial) for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw usage(`${path}.${key} 必填`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw usage(`${path} 包含未知字段`, '对照 schema 的 properties 修正字段；不会静默忽略或回显字段内容。');
      validateInput(item, schema.properties[key], `${path}.${key}`);
    }
  }
}

function privateStat(info) {
  return (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
}
export function defaultEndpointFile(home = homedir()) { return join(home, '.agentforge', 'desktop', 'desktop-endpoint.json'); }
export async function resolveEndpoint(endpointFile = defaultEndpointFile(), fetcher = fetch) {
  if (!isAbsolute(endpointFile)) throw usage('--endpoint-file 必须是绝对路径');
  let file;
  try {
    const parent = await lstat(dirname(endpointFile));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !privateStat(parent)) throw new Error('unsafe directory');
    file = await open(endpointFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || !privateStat(info) || info.size > 1024) throw new Error('unsafe file');
    const { origin, instanceId } = JSON.parse(await readBounded(file.createReadStream({ autoClose: false }), 1024));
    if (!/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(origin) || new URL(origin).port > 65535 || !/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error('invalid endpoint');
    const response = await fetcher(`${origin}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    if (!response.ok || health.service !== 'agentforge-control-plane' || health.instanceId !== instanceId) throw new Error('stale endpoint');
    return origin;
  } catch {
    throw new CliError('CLIENT_UNAVAILABLE', '客户端未运行，或连接文件已过期/不安全', '先打开 AgentForge 客户端；CLI 只连接客户端，不会改连其他服务。', 5);
  } finally { await file?.close(); }
}
export function createClient({ endpointFile, sessionFile = join(homedir(), '.agentforge', 'cli-session.json'), fetcher = fetch } = {}) {
  if (!isAbsolute(sessionFile)) throw usage('--session-file 必须是绝对路径');
  sessionFile = resolve(sessionFile);
  let origin, connection;
  // Resolve once, after command validation, before reading or sending a session.
  const connect = () => connection ||= resolveEndpoint(endpointFile, fetcher).then(value => { origin = value; });
  async function checkParent(create = false) {
    if (create) await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(sessionFile));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !privateStat(parent)) throw new CliError('SESSION_FILE', '会话目录必须由本用户拥有且仅本用户可访问', '选择专用0700目录，不要用共享目录或符号链接。', 3);
  }
  async function readSession(optional = false) {
    await connect();
    let file;
    try {
      await checkParent();
      file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || !privateStat(info) || info.size > 4096) throw new Error('unsafe');
      const saved = JSON.parse(await readBounded(file.createReadStream({ autoClose: false }), 4096));
      if (saved.origin !== origin || !/^agentforge_session=[a-f0-9]{64}$/.test(saved.cookie) || (saved.expiresAt !== null && (!Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()))) throw new Error('invalid');
      return saved;
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      if (error instanceof CliError && error.code === 'SESSION_FILE') throw error;
      throw new CliError('AUTH_REQUIRED', 'CLI会话不存在、已过期或文件不可安全读取', '运行 agentforge auth login --username 你的用户名，按提示隐藏输入密码；脚本显式 --password-stdin，不读取浏览器cookie或认证数据库。', 3);
    } finally { await file?.close(); }
  }
  async function request(path, { method = 'GET', body, cookie, authenticated = true, timeoutMs = 120000 } = {}) {
    await connect();
    const session = cookie === undefined && authenticated ? await readSession() : null;
    let response, value;
    try {
      response = await fetcher(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie || session ? { Cookie: cookie || session.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      value = JSON.parse(await readBounded(response.body, 16 * maxBytes));
    } catch {
      throw new CliError('CONNECTION_UNCERTAIN', '客户端服务未连接、超时或响应无法确认', method === 'GET' ? '确认 AgentForge 客户端正在运行，再查询；不自动切换实例。' : '写操作可能已经提交：先list/get核验再决定重试；不自动重发。', 5);
    }
    if (!response.ok) {
      const authFailure = response.status === 401 || response.status === 403;
      throw new CliError(authFailure ? 'AUTH_REQUIRED' : 'SERVER_REJECTED', String(value?.error || `HTTP ${response.status}`).slice(0, 800), authFailure ? '重新登录CLI；会话独立于客户端，重置后旧会话失效。' : '检查字段、引用ID、Provider兼容性或被引用限制；先get/list核验，不重复创建。', authFailure ? 3 : 4, response.status);
    }
    return { value, response };
  }
  async function saveSession(saved) {
    await checkParent(true);
    try { const current = await lstat(sessionFile); if (!current.isFile() || !privateStat(current)) throw new Error('unsafe'); }
    catch (error) { if (error.code !== 'ENOENT') throw new CliError('SESSION_FILE', '拒绝覆盖不安全的会话文件', '选择本用户专用0600常规文件；不覆盖符号链接或其他用户文件。', 3); }
    const temporary = `${sessionFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(saved)); } finally { await file.close(); }
      await rename(temporary, sessionFile);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  return {
    request: async (path, options) => (await request(path, options)).value,
    async login(username, password) {
      let previous;
      try { previous = await readSession(true); } catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; }
      const { value, response } = await request('/api/auth/login', { method: 'POST', body: { username, password }, authenticated: false, cookie: previous?.cookie });
      const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)agentforge_session=[a-f0-9]{64}(?=;)/)?.[0]?.replace(/^,\s*/, '');
      if (!cookie || (value.expiresAt !== null && !Number.isFinite(value.expiresAt))) throw new CliError('AUTH_REQUIRED', '登录响应缺少有效会话', '确认目标实例仍在运行，不使用代理或手工cookie。', 3);
      try { await saveSession({ origin, cookie, expiresAt: value.expiresAt }); }
      catch { await request('/api/auth/logout', { method: 'POST', body: {}, authenticated: false, cookie }).catch(() => {}); throw new CliError('SESSION_FILE', '登录后无法安全保存CLI会话，已尝试撤销新会话', '选择本用户专用0700目录和0600文件，并检查磁盘空间。', 3); }
      return { username: value.username, expiresAt: value.expiresAt, sessionFile };
    },
    async logout() {
      const session = await readSession();
      await request('/api/auth/logout', { method: 'POST', body: {}, cookie: session.cookie });
      await unlink(sessionFile);
      return { loggedOut: true };
    }
  };
}
