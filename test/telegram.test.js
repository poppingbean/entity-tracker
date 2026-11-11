// The Telegram bot's pure parts (src/alerts/telegram.js): who a command is for, chats in parallel, the answers' text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandFor, byChat, safeMessage, whatIsMessage, auditMessage, COMMANDS } from '../src/alerts/telegram.js';

test('a command for another bot in the group is not ours; ours with or without our name', () => {
  assert.deepEqual(commandFor('/safe alice.near', 'safenear_bot'), { cmd: '/safe', ours: true });
  assert.deepEqual(commandFor('/watch@SafeNear_Bot THREE', 'safenear_bot'), { cmd: '/watch', ours: true });
  assert.deepEqual(commandFor('/watch@otherbot THREE', 'safenear_bot'), { cmd: '/watch', ours: false });
  assert.equal(commandFor('hello', 'safenear_bot'), null);
});

test('updates are grouped by chat, in order inside a chat', () => {
  const u = (id, chat, text) => ({ update_id: id, message: { chat: { id: chat }, text } });
  assert.deepEqual(byChat([u(1, 'a', '1'), u(2, 'b', '2'), u(3, 'a', '3'), { update_id: 4 }]).map((l) => l.map((m) => m.text)), [['1', '3'], ['2']]);
});

test('answers are escaped HTML under Telegram\'s limit, with the verdict first', () => {
  const m = safeMessage('x.near', { verdict: 'danger', headline: 'Part of a <hack>', points: [{ level: 'bad', text: 'a & b' }, { level: 'info', text: 'note' }], actions: ['Do not send'] });
  assert.match(m, /^🔴 <b>DANGER<\/b>: Part of a &lt;hack&gt;/);
  assert.match(m, /🔴 a &amp; b/);
  assert.ok(m.length < 4000);
  assert.match(whatIsMessage({ account: 'solver.near', is: 'a NEAR Intents solver', why: 'settles through intents.near', cases: [] }), /<b>a NEAR Intents solver<\/b>/);
  assert.match(auditMessage('x.near', { status: 'pending' }), /No audit yet/);
  assert.match(auditMessage('x.near', { status: 'ok', level: 'high', type: { label: 'Token' }, findings: [{ severity: 'high', title: 'Mints' }] }), /<b>HIGH<\/b>: Token/);
});

test('the command menu has every command the help lists', () => {
  const names = COMMANDS.map(([c]) => c);
  for (const c of ['safe', 'hack', 'hacks', 'whatis', 'audit', 'check', 'watch', 'unwatch', 'list', 'alerts', 'report', 'gatepass', 'help']) assert.ok(names.includes(c), c);
});
