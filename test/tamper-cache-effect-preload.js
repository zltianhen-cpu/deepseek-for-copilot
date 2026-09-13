// 用途：外审 R2 失效注入。不改源码/安装目录，只在 require.cache 里把过滤器和准备函数换掉。
'use strict';
const Module = require('module');
const path = require('path');

const compiledRoot = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
const orig = Module._load;
Module._load = function (id, ...args) {
  if (id === 'vscode') {
    return {
      env: { language: 'en' },
      version: 'tamper',
      window: { createOutputChannel: () => ({ info() {}, error() {}, debug() {}, warn() {}, appendLine() {} }) },
      workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }),
      },
      Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
      LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
      LanguageModelTextPart: class LanguageModelTextPart { constructor(value) { this.value = value; } },
      LanguageModelDataPart: class LanguageModelDataPart { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } },
      LanguageModelThinkingPart: class LanguageModelThinkingPart { constructor(value) { this.value = value; } },
      LanguageModelToolCallPart: class LanguageModelToolCallPart {
        constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
      },
      LanguageModelToolResultPart: class LanguageModelToolResultPart {
        constructor(callId, content) { this.callId = callId; this.content = content; }
      },
    };
  }
  return orig.call(this, id, ...args);
};

const hooks = require(path.join(compiledRoot, 'out/provider/chat-hooks.js'));
const req = require(path.join(compiledRoot, 'out/provider/request.js'));
if (process.env.TAMPER_FILTER === '1') hooks.applyMessageFilter = async () => {};
if (process.env.TAMPER_PREPARE === '1') {
  req.prepareChatRequest = () => { throw new Error('BROKEN PREPARE'); };
}

// 流式客户端失效注入，仅作用于当前测试进程。
if (process.env.TAMPER_STREAM === '1') {
  require(path.join(compiledRoot, 'out/client/core.js')).DeepSeekClient.prototype.streamChatCompletion = async () => {
    throw new Error('AUDIT_STREAM_BROKEN');
  };
}

// 改坏实际序列化输出，验证固定字节合同能拦截。
if (process.env.TAMPER_WIRE) {
  const json = require(path.join(compiledRoot, 'out/json.js'));
  const stringify = json.safeStringify;
  json.safeStringify = (value) => {
    const raw = stringify(value);
    if (!value || !value.stream || !Array.isArray(value.messages)) return raw;
    const changed = JSON.parse(raw);
    if (process.env.TAMPER_WIRE === 'options') delete changed.stream_options;
    if (process.env.TAMPER_WIRE === 'history') changed.messages[0].content = 'AUDIT_HISTORY_CHANGED';
    return JSON.stringify(changed);
  };
}
