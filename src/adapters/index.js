'use strict';
// Danh bạ adapter. Thêm loại mới: viết một class theo giao diện trong base.js rồi đăng ký ở TYPES.
const { CliAdapter } = require('./cli');
const { GeminiApiAdapter, OpenAICompatAdapter } = require('./http');
const { MockAdapter } = require('./mock');

const TYPES = {
  cli: CliAdapter,
  'gemini-api': GeminiApiAdapter,
  'openai-compat': OpenAICompatAdapter,
  mock: MockAdapter,
};

function buildAdapters(agentConfigs) {
  const list = [];
  for (const cfg of agentConfigs || []) {
    if (cfg.disabled) continue;
    const Cls = TYPES[cfg.type];
    if (!Cls) throw new Error(`Loại adapter không hỗ trợ: ${cfg.type} (agent ${cfg.id})`);
    if (!/^[a-z0-9_-]{1,40}$/i.test(cfg.id || '')) throw new Error(`ID agent không hợp lệ: ${cfg.id}`);
    list.push(new Cls(cfg));
  }
  return list;
}

module.exports = { buildAdapters, TYPES };
