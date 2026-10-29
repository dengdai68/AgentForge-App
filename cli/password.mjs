import { emitKeypressEvents } from 'node:readline';
import { CliError, usage } from './client.mjs';

// Raw mode disables terminal echo; keypress decoding works even with TERM=dumb.
// Never render the edited value or add it to readline/shell history.
export function readPassword({ input = process.stdin, output = process.stderr, signals = process } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(usage('当前终端无法隐藏密码输入', '请在交互终端登录，或用 --password-stdin 安全传入密码。'));
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const characters = [];
    let settled = false, prompted = false, bytes = 0, cursor = 0;
    const cancelled = () => finish(new CliError('CANCELLED', '已取消登录', '未提交认证请求，未保存会话。', 130));
    const failed = () => finish(usage('无法读取隐藏密码输入', '请检查终端，或用 --password-stdin 安全传入密码。'));
    const bounded = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 4096) finish(usage('密码输入超过大小上限', '密码应为一行10–128字符；请重新登录。')); };
    function keypress(value, key = {}) {
      if (settled) return;
      if (key.ctrl && ['c', 'd'].includes(key.name)) return cancelled();
      if (['return', 'enter'].includes(key.name)) return finish(null, characters.join(''));
      if (key.name === 'backspace') { if (cursor) characters.splice(--cursor, 1); return; }
      if (key.name === 'delete') { characters.splice(cursor, 1); return; }
      if (key.name === 'left') { cursor = Math.max(0, cursor - 1); return; }
      if (key.name === 'right') { cursor = Math.min(characters.length, cursor + 1); return; }
      if (key.name === 'home' || key.ctrl && key.name === 'a') { cursor = 0; return; }
      if (key.name === 'end' || key.ctrl && key.name === 'e') { cursor = characters.length; return; }
      if (key.ctrl && key.name === 'u') { characters.length = 0; cursor = 0; return; }
      if (!value || key.ctrl || key.meta || /[\x00-\x1f\x7f]/.test(value)) return;
      const inserted = Array.from(value); characters.splice(cursor, 0, ...inserted); cursor += inserted.length;
      if (characters.join('').length > 128) finish(usage('密码输入超过长度上限', '密码应为一行10–128字符；请重新登录。'));
    }
    function finish(error, value) {
      if (settled) return;
      settled = true;
      input.off('data', bounded); input.off('keypress', keypress); input.off('error', failed);
      input.off('end', cancelled); input.off('close', cancelled); signals.off('SIGINT', cancelled);
      try { input.setRawMode(wasRaw); }
      catch { error ||= usage('无法恢复终端输入模式', '未提交认证请求；请重新打开终端后重试。'); }
      input.pause(); characters.length = 0;
      if (prompted) { try { output.write('\n'); } catch { /* Do not replace the read outcome. */ } }
      if (error) reject(error); else resolve(value);
    }
    try {
      input.setRawMode(true);
      if (!input.isRaw) throw new Error('raw mode unavailable');
      input.on('data', bounded); input.once('error', failed); signals.once('SIGINT', cancelled);
      input.once('end', cancelled); input.once('close', cancelled);
      emitKeypressEvents(input); input.on('keypress', keypress);
      output.write('请输入密码：'); prompted = true;
    } catch { failed(); }
  });
}
