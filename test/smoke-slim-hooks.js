// Purpose: verify the compiled provider wires the bundled skill filter and that
// slash-command identity restoration runs before the low-block early return.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const compiled = path.join(root, 'out', 'provider', 'chat-hooks.js');
const filterPath = path.join(root, 'resources', 'hooks', 'skill_filter.js');

assert.ok(fs.existsSync(compiled), 'compiled chat-hooks.js is missing');
assert.ok(fs.readFileSync(compiled, 'utf8').includes('skill_filter.js'),
  'compiled provider does not load skill_filter.js');
assert.ok(fs.existsSync(filterPath), 'bundled skill_filter.js is missing');

const filter = require(filterPath);
const raw = '<userRequest>\n'
  + '<attachment id="prompt:SKILL.md" filePath="/tmp/work/skills/sample-sync/SKILL.md">\n'
  + 'Follow instructions in #prompt:SKILL.md\n'
  + '</attachment>\n</userRequest>';
const messages = [{ role: 'user', content: raw }];
const result = filter.filterOpenAIMessages(messages, { requestKind: 'test' });

assert.strictEqual(result.reason, 'below-threshold', 'fixture must exercise the early-return path');
assert.strictEqual(result.namesRestored, 1, 'slash skill identity was not restored');
assert.ok(messages[0].content.includes('（用户点名技能：sample-sync）'),
  'outbound user message still lacks the selected skill name');

console.log('✅ 钩子集成测试通过：编译入口已接线，提前返回前已写回斜杠技能名');
