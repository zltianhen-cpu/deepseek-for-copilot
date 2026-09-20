// 用途：宿主压缩只复用同一会话已发出的技能区，且不触碰历史消息。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  rememberFilteredSkills,
  applyRememberedSkills,
  clearRememberedSkillsForTest,
} = require('../out/provider/host-summary-skills.js');

const raw = 'prefix<skills>\n<skill>A</skill>\n<skill>B</skill>\n</skills>\n\n\n<agents>same</agents>';
const slim = 'prefix<skills>\n<skill>A</skill>\n</skills>\n\n<agents>same</agents>';
const msg = (content, role = 'system') => ({ role, content });
const arr = (text) => [{ type: 'text', text }];
const remember = (key = 'conversation-1', before = raw, after = slim) =>
  rememberFilteredSkills(key, [msg(before)], [msg(after)]);

const cases = [
  ['同链字符串复用', () => { assert.equal(remember(), true); const m = [msg(raw)]; assert.equal(applyRememberedSkills('conversation-1', m), true); assert.equal(m[0].content, slim); }],
  ['同链数组文本复用', () => { assert.equal(remember('a', arr(raw), arr(slim)), true); const m = [msg(arr(raw))]; assert.equal(applyRememberedSkills('a', m), true); assert.equal(m[0].content[0].text, slim); }],
  ['数组形态保持', () => { remember('a', arr(raw), arr(slim)); const m = [msg(arr(raw))]; applyRememberedSkills('a', m); assert.ok(Array.isArray(m[0].content)); }],
  ['后续消息不动', () => { remember(); const tail = [msg('history', 'user'), msg('answer', 'assistant')]; const m = [msg(raw), ...tail]; applyRememberedSkills('conversation-1', m); assert.equal(m.length, 3); assert.equal(m[1], tail[0]); assert.equal(m[2], tail[1]); }],
  ['另一会话拒绝', () => { remember(); const m = [msg(raw)]; assert.equal(applyRememberedSkills('other', m), false); assert.equal(m[0].content, raw); }],
  ['系统原文变动拒绝', () => { remember(); const m = [msg(raw + 'x')]; assert.equal(applyRememberedSkills('conversation-1', m), false); }],
  ['技能条目变动拒绝', () => { remember(); const m = [msg(raw.replace('B', 'C'))]; assert.equal(applyRememberedSkills('conversation-1', m), false); }],
  ['空钥匙不记', () => assert.equal(remember('', raw, slim), false)],
  ['空钥匙不取', () => { remember(); assert.equal(applyRememberedSkills('', [msg(raw)]), false); }],
  ['未见常规轮不取', () => assert.equal(applyRememberedSkills('conversation-1', [msg(raw)]), false)],
  ['重载后无快照拒绝', () => { remember(); clearRememberedSkillsForTest(); assert.equal(applyRememberedSkills('conversation-1', [msg(raw)]), false); }],
  ['无技能容器不记', () => assert.equal(remember('a', 'plain', 'changed'), false)],
  ['未瘦身不记', () => assert.equal(remember('a', raw, raw), false)],
  ['角色不一致不记', () => assert.equal(rememberFilteredSkills('a', [msg(raw, 'user')], [msg(slim)]), false)],
  ['角色不一致不取', () => { remember(); assert.equal(applyRememberedSkills('conversation-1', [msg(raw, 'user')]), false); }],
  ['宿主 user 头可复用', () => { assert.equal(rememberFilteredSkills('a', [msg(raw, 'user')], [msg(slim, 'user')]), true); const m = [msg(raw, 'user')]; assert.equal(applyRememberedSkills('a', m), true); assert.equal(m[0].content, slim); }],
  ['前缀变动不记', () => assert.equal(remember('a', raw, 'changed' + slim), false)],
  ['尾部指令变动不记', () => assert.equal(remember('a', raw, slim.replace('same', 'changed')), false)],
  ['多技能容器不记', () => assert.equal(remember('a', raw + '<skills>x</skills>', slim), false)],
  ['多文本段不记', () => assert.equal(remember('a', arr(raw).concat(arr('x')), arr(slim)), false)],
  ['非文本段不记', () => assert.equal(remember('a', [{ type: 'image_url', image_url: 'x' }], arr(slim)), false)],
  ['只容许空行收敛', () => assert.equal(remember('a', raw, slim), true)],
  ['内容字符改动不借用空行规则', () => assert.equal(remember('a', raw, slim.replace('same', 'other')), false)],
];
for (const [name, run] of cases) test(name, () => { clearRememberedSkillsForTest(); run(); });
