// The AI system prompts (src/ai/prompts/*.md): every one loads, every include resolves, no {{slot}} is left unfilled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prompt, promptNames } from '../src/ai/prompts/index.js';

// the values each prompt needs (the code passes the real ones); prompts not listed need none
const VARS = {
  'audit-code-review': { roles: 'token, dex', powers: 'mint, pause' },
  'scanner-analyst': { timing: 10, decision: 'DECIDE', runupMcapUsd: '50,000' },
  'scanner-decision-buy': { buyNear: 1 },
  'scanner-decision-hold': { costNear: 1 },
  'untrusted-rule': { MARKER: '<<UNTRUSTED>>' },
};

test('every prompt loads with its values and leaves no slot unfilled', () => {
  const names = promptNames();
  assert.ok(names.length >= 20, `only ${names.length} prompts`);
  for (const name of names) {
    const text = prompt(name, VARS[name]);
    assert.ok(text.length > 50, `${name} is empty`);
    assert.doesNotMatch(text, /\{\{/, `${name} has an unfilled slot`);
    assert.doesNotMatch(text, /\r/, `${name} has CR line ends`);
  }
});

test('a missing value is an error, and includes are resolved', () => {
  assert.throws(() => prompt('scanner-decision-buy'), /no value for \{\{buyNear\}\}/);
  assert.ok(prompt('token-analyst').includes(prompt('token-analyst-standards')));
  assert.ok(prompt('untrusted-rule', { MARKER: 'XYZ' }).includes('XYZ'));
});
