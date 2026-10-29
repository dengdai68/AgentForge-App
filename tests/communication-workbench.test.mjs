import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCatalogFixtureStore } from './fixture-store.mjs';
import { createRunFiles } from '../server/run-files.mjs';
import { createCommunicationService } from '../server/communication.mjs';
import { executionContent } from '../server/runtime/local-cli.mjs';
import { extensionAvatarColor } from '../web/marketplace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'af-communication-workbench-'));
  const options = { databasePath: join(root, 'state.sqlite') }, store = createCatalogFixtureStore(options), files = createRunFiles({ root: join(root, 'files') });
  const chat = store.openCommunication({ kind: 'agent', targetId: 'agent_analyst' });
  const other = store.openCommunication({ kind: 'agent', targetId: 'agent_designer' });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, store, files, chat, other };
}
test('attachment ownership, duplicate filenames, attachment-only send and idempotency persist without binary metadata', async t => {
  const { root, store, files, chat, other, options } = await fixture(t);
  const create = async value => store.registerCommunicationAttachment(chat.id, await files.writeCommunicationAttachment(chat.id, '材料<&>.md', Buffer.from(value)));
  const a = await create('first'), b = await create('second');
  assert.notEqual(a.path, b.path);
  assert.deepEqual(await files.readCommunicationAttachment(chat.id, a), Buffer.from('first'));
  assert.equal((await stat(join(files.communicationPath(chat.id), a.path))).mode & 0o777, 0o600);
  assert.throws(() => store.getCommunicationAttachment(other.id, a.id), /不属于/);
  assert.throws(() => store.sendCommunication(other.id, { attachmentIds: [a.id], clientRequestId: 'cross-chat' }), /不属于/);
  const input = { attachmentIds: [a.id, b.id], clientRequestId: 'attachment-only-proof' };
  const message = store.sendCommunication(chat.id, input);
  assert.equal(message.content, ''); assert.equal(message.attachments.length, 2);
  assert.deepEqual(store.sendCommunication(chat.id, input), message);
  assert.throws(() => store.sendCommunication(chat.id, { ...input, attachmentIds: [b.id] }), /另一条消息/);
  assert.equal(store.getCommunication(chat.id).conversation.unreadCount, 0);
  const delivery = store.claimCommunication(chat.id);
  assert.deepEqual(store.communicationContext(chat.id, delivery.id).message.attachments, [a, b]);
  store.failCommunication(chat.id, delivery.id, 'controlled failure');
  assert.equal(store.getCommunication(chat.id).conversation.unreadCount, 0, 'failed outgoing delivery is not incoming unread');
  const persisted = JSON.stringify(store.snapshot()); assert.ok(!persisted.includes('"first"') && !persisted.includes('"second"'));
  const reopened = createCatalogFixtureStore(options);
  try { assert.deepEqual(reopened.getCommunicationAttachment(chat.id, a.id), a); assert.equal(reopened.getCommunication(chat.id).messages[0].attachments.length, 2); }
  finally { reopened.close(); }
});
test('attachment files reject invalid paths, links, oversize and tampering while preserving exact empty/binary bytes', async t => {
  const { root, files, chat } = await fixture(t);
  for (const name of ['../escape', '/absolute', 'a\\b', '', '.', '..', 'bad\0file']) await assert.rejects(files.writeCommunicationAttachment(chat.id, name, Buffer.from('x')), /文件名/);
  await assert.rejects(files.writeCommunicationAttachment('../other', 'x', Buffer.from('x')), /ID/);
  await assert.rejects(files.writeCommunicationAttachment(chat.id, 'large', Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MiB/);
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 32, 13, 10])]) {
    const record = await files.writeCommunicationAttachment(chat.id, 'binary.dat', bytes);
    assert.deepEqual(await files.readCommunicationAttachment(chat.id, record), bytes);
    await writeFile(join(files.communicationPath(chat.id), record.path), Buffer.alloc(bytes.length, 17));
    if (bytes.length) await assert.rejects(files.readCommunicationAttachment(chat.id, record), /完整性/);
  }
  const record = await files.writeCommunicationAttachment(chat.id, 'link.txt', Buffer.from('owned'));
  const path = join(files.communicationPath(chat.id), record.path), outside = join(root, 'outside');
  await writeFile(outside, 'private outside'); await rm(path); await symlink(outside, path);
  await assert.rejects(files.readCommunicationAttachment(chat.id, record), /符号链接/);
  const linked = 'chat_' + randomUUID(); await symlink(root, join(files.root, 'communications', linked));
  await assert.rejects(files.writeCommunicationAttachment(linked, 'no.txt', Buffer.from('x')), /符号链接/);
  assert.equal(await readFile(outside, 'utf8'), 'private outside');
});
test('communication console owns bounded attempts and private content without leaking session transport into audits', async t => {
  const { store, files, chat, other } = await fixture(t);
  const record = store.registerCommunicationAttachment(chat.id, await files.writeCommunicationAttachment(chat.id, 'proof.txt', Buffer.from('attachment proof')));
  const calls = [];
  const service = createCommunicationService(store, { root: join(files.root, 'communications'), files, invoke: async input => {
    calls.push(input);
    assert.ok(input.prompt.includes(join(files.communicationPath(chat.id), record.path)));
    await input.onEvent({ providerEventType: 'system', message: 'Provider initialized', data: { sessionId: input.session.sessionId, auditVersion: 2, subtype: 'init' } });
    await input.onEvent({ providerEventType: 'assistant', message: 'public text', data: { auditVersion: 2, presentation: 'text' }, content: executionContent({ text: 'private-file-runtime-text' }) });
    await input.onEvent({ providerEventType: 'tool', message: 'tool', data: { auditVersion: 2, presentation: 'tool', toolName: 'Bash', toolUseId: 'call' }, content: executionContent({ input: { command: 'wc -c proof.txt' } }) });
    return { finalText: JSON.stringify({ reply: '已核对', handoffToAgentId: null }) };
  } });
  for (let index = 0; index < 2; index++) {
    store.sendCommunication(chat.id, { content: '查看附件', attachmentIds: [record.id], clientRequestId: 'console-proof-' + index });
    await service.kick(chat.id);
  }
  assert.equal(calls.length, 2); assert.equal(calls[1].session.resume, true);
  const consolePage = store.getCommunicationConsole(chat.id, { agentId: 'agent_analyst', limit: 3 });
  assert.equal(consolePage.events.length, 3); assert.equal(consolePage.hasMore, true);
  const older = store.getCommunicationConsole(chat.id, { agentId: 'agent_analyst', limit: 3, before: consolePage.nextBefore });
  assert.ok(older.events.every(row => !consolePage.events.some(other => row.id === other.id)));
  assert.equal(consolePage.traces.length, 2);
  assert.deepEqual(consolePage.traces.map(row => row.sessionMode), ['create', 'resume']);
  assert.ok(consolePage.traces.every(row => row.providerSessionId === calls[0].session.sessionId && row.promptRef && row.status === 'completed'));
  const all = store.getCommunicationConsole(chat.id, { agentId: 'agent_analyst', limit: 200 });
  const text = all.events.find(row => row.data.presentation === 'text');
  const reference = store.getCommunicationContentReference(chat.id, text.id);
  assert.equal((await files.readConsoleContent(reference)).fields.text.text, 'private-file-runtime-text');
  assert.throws(() => store.getCommunicationContentReference(other.id, text.id), /不存在|不属于/);
  assert.throws(() => store.getCommunicationConsole(chat.id, { agentId: 'agent_designer' }), /不属于/);
  const prompt = await files.readConsoleContent(store.getCommunicationContentReference(chat.id, all.traces[0].id, { prompt: true }));
  assert.match(prompt.prompt.text, /会话主目录/);
  const events = store.getCommunicationEvents(chat.id, store.getCommunication(chat.id).deliveries[0].id).items;
  assert.doesNotMatch(JSON.stringify(events), /sessionId|session_id|private-file-runtime-text/);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /private-file-runtime-text/);
  const tampered = join(files.root, reference.storagePath); await writeFile(tampered, '{}');
  await assert.rejects(files.readConsoleContent(reference), /完整性/);
  assert.equal(store.getCommunication(other.id).conversation.unreadCount, 0);
});
test('market avatars reuse a deterministic employee palette without encoding execution state', () => {
  const colors = new Set();
  for (let index = 0; index < 30; index++) { const color = extensionAvatarColor('entry-' + index); assert.ok(['violet', 'cyan', 'amber', 'blue', 'green'].includes(color)); colors.add(color); assert.equal(color, extensionAvatarColor('entry-' + index)); }
  assert.equal(colors.size, 5);
});
