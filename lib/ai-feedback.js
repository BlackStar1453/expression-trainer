/**
 * AI反馈模块 - 支持多后端
 * 支持 DeepSeek / OpenAI / Ollama / 自定义 OpenAI 兼容接口
 */

const { getRealtimePrompt, getReportPrompt, getCorrectionPrompt, getTranslationPrompt } = require('./prompts');
const claudeCli = require('./claude-cli');

// 各后端的 API 配置
const PROVIDER_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions'
};

/**
 * 发送请求到 OpenAI 兼容接口
 */
async function callAPI(endpoint, apiKey, model, messages, maxTokens = 200) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API 请求失败 (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * 获取endpoint和配置
 */
function getProviderConfig(settings) {
  const { provider, apiKey, model, ollamaUrl, baseUrl, customModel } = settings;

  switch (provider) {
    case 'openai':
      return {
        endpoint: PROVIDER_ENDPOINTS.openai,
        apiKey,
        model: model || 'gpt-4o-mini'
      };
    case 'deepseek':
      return {
        endpoint: PROVIDER_ENDPOINTS.deepseek,
        apiKey,
        model: model || 'deepseek-chat'
      };
    case 'ollama':
      return {
        endpoint: `${ollamaUrl || 'http://localhost:11434'}/v1/chat/completions`,
        apiKey: 'ollama', // Ollama 不需要真实key但接口需要这个字段
        model: model || 'qwen2.5:7b'
      };
    case 'custom':
      // 用户输入 BASE URL，自动追加 /chat/completions
      const base = (baseUrl || '').replace(/\/+$/, '');
      const endpoint = base ? `${base}/chat/completions` : '';
      return {
        endpoint,
        apiKey: apiKey || '',
        model: customModel || model || ''
      };
    case 'claude-cli':
      // handled by callModel via the persistent subprocess; no endpoint/key
      return { provider: 'claude-cli', model: model || 'sonnet' };
    default:
      throw new Error(`未知的 provider: ${provider}`);
  }
}

/**
 * Route a chat request to the configured provider and return raw model text.
 * - claude-cli: persistent `claude` subprocess (uses subscription, no API key)
 * - others: OpenAI-compatible HTTP endpoint
 */
async function callModel(settings, messages, maxTokens = 200) {
  if (settings.provider === 'claude-cli') {
    const system = (messages.find(m => m.role === 'system') || {}).content || '';
    const user = (messages.find(m => m.role === 'user') || {}).content || '';
    return claudeCli.ask(system, user, { model: settings.model || 'sonnet', binPath: settings.binPath });
  }
  const config = getProviderConfig(settings);
  return callAPI(config.endpoint, config.apiKey, config.model, messages, maxTokens);
}

/**
 * 发送实时反馈请求
 * @param {string} text - 当前累积文本
 * @param {Object} settings - 用户设置
 * @returns {string} 反馈HTML
 */
async function sendFeedback(text, settings, customPrompt) {
  const prompt = getRealtimePrompt(text, null, customPrompt);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  return callModel(settings, messages, 150);
}

/**
 * 发送结束报告请求
 * @param {string} fullText - 完整文本
 * @param {Object} stats - 统计数据
 * @param {Object} settings - 用户设置
 * @returns {string} 报告文本
 */
async function sendReport(fullText, stats, settings, customPrompt, corrections = []) {
  const prompt = getReportPrompt(fullText, stats, corrections, customPrompt);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  return callModel(settings, messages, 8192);
}

/**
 * Pull the outermost JSON value ({...} or [...]) out of a model reply.
 * Tolerates ```json fences and surrounding prose. Returns parsed value or null.
 */
function extractJsonBlock(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (firstBrace === -1 && firstBracket === -1) return null;

  let start, closeCh;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket; closeCh = ']';
  } else {
    start = firstBrace; closeCh = '}';
  }
  const end = text.lastIndexOf(closeCh);
  if (end === -1 || end < start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanTags(tags) {
  return Array.isArray(tags)
    ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 3)
    : [];
}

/**
 * Parse the model's batch-correction response（issue #5 v2：输入是断续口语合并段，
 * LLM 负责语义断句）into a validated per-sentence array.
 * 容错：fence / 闲话 / 裸数组 / 旧版单对象。
 * @param {string} raw
 * @param {string} [fallbackOriginal]  合并段原文，模型漏 original 时兜底
 * @returns {Array<{original, hasError, corrected, explanation, tags}>|null}
 *   null = 无法解析（调用方按失败处理）；[] = 模型明确说没有可纠内容
 */
function parseCorrectionBatchResponse(raw, fallbackOriginal = '') {
  const obj = extractJsonBlock(raw);
  if (!obj) return null;

  let list;
  if (Array.isArray(obj)) list = obj;
  else if (Array.isArray(obj.sentences)) list = obj.sentences;
  else if ('hasError' in obj) list = [obj];   // 旧版单对象兼容
  else return null;

  return list
    .filter(s => s && typeof s === 'object')
    .map(s => {
      const corrected = String(s.corrected || '').trim();
      // hasError 但给不出修正句 → 没有可展示内容，降级为无错
      const hasError = s.hasError === true && !!corrected;
      return {
        original: String(s.original || '').trim() || String(fallbackOriginal || '').trim(),
        hasError,
        corrected: hasError ? corrected : '',
        explanation: hasError ? String(s.explanation || '').trim() : '',
        tags: hasError ? cleanTags(s.tags) : []
      };
    });
}

/**
 * Mode A — request corrections for one committed utterance（可能含多句，LLM 断句）.
 * @param {string} utterance   合并后的断续口语段
 * @param {Object} settings   provider config (endpoint/apiKey/model resolved)
 * @param {string[]} existingTags  tags seen this session (for reuse)
 * @returns {Array|null}  per-sentence corrections；null = 解析失败
 */
async function sendCorrection(utterance, settings, existingTags = []) {
  const prompt = getCorrectionPrompt(utterance, existingTags);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  // 批次可能含多句，预算比单句版放宽
  const result = await callModel(settings, messages, 1200);
  return parseCorrectionBatchResponse(result, utterance);
}

/**
 * Parse the model's batch-translation response into validated learning cards.
 * 容错：fence / 闲话 / 裸数组 / 旧版单对象。缺 en 的卡直接丢弃。
 * @param {string} raw
 * @param {string} [fallbackZh]  合并段中文原文（仅单卡时兜底 zh）
 * @returns {Array<{zh, en, note, tags}>|null}  null = 解析失败或没有可用卡
 */
function parseTranslationBatchResponse(raw, fallbackZh = '') {
  const obj = extractJsonBlock(raw);
  if (!obj) return null;

  let list;
  if (Array.isArray(obj)) list = obj;
  else if (Array.isArray(obj.cards)) list = obj.cards;
  else if (obj.en) list = [obj];   // 旧版单对象兼容
  else return null;

  const cards = list
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      zh: String(c.zh || '').trim(),
      en: String(c.en || '').trim(),
      note: String(c.note || '').trim(),
      tags: cleanTags(c.tags)
    }))
    .filter(c => c.en);   // an English translation is the whole point

  if (cards.length === 0) return null;
  if (cards.length === 1 && !cards[0].zh) cards[0].zh = String(fallbackZh || '').trim();
  return cards;
}

/**
 * Mode B — translate one committed Chinese utterance（可能含多句，LLM 断句）.
 * @param {string} utterance
 * @param {Object} settings
 * @param {string[]} existingTags
 * @returns {Array|null}  learning cards；null = 解析失败
 */
async function sendTranslation(utterance, settings, existingTags = []) {
  const prompt = getTranslationPrompt(utterance, existingTags);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  const result = await callModel(settings, messages, 1500);
  return parseTranslationBatchResponse(result, utterance);
}

/**
 * 将AI返回的纯文本反馈格式化为HTML
 */
function formatFeedback(text) {
  // 简单处理：检测是否包含建议标记
  let html = text
    .replace(/→/g, '<span class="suggestion"> → </span>')
    .replace(/⚠️/g, '<span class="issue">⚠️</span>')
    .replace(/✓/g, '<span class="suggestion">✓</span>')
    .replace(/\n/g, '<br>');

  return html;
}

/**
 * 测试 LLM 连通性
 * 发送一条极简请求验证配置是否可用
 */
async function testConnection(settings) {
  // Claude 订阅（CLI）：不走 HTTP，直接 ping 一次子进程
  if (settings.provider === 'claude-cli') {
    try {
      const r = await claudeCli.ask('Reply with exactly: OK', 'ping', {
        model: settings.model || 'sonnet',
        binPath: settings.binPath
      });
      return (r && r.trim().length > 0)
        ? { success: true }
        : { success: false, error: 'claude 无响应（请确认已登录 Claude Code）' };
    } catch (e) {
      return { success: false, error: `claude CLI 调用失败: ${e.message}` };
    }
  }

  const config = getProviderConfig(settings);
  if (!config.endpoint) {
    return { success: false, error: '端点地址未配置' };
  }

  const messages = [
    { role: 'user', content: 'OK' }
  ];

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: 2,
        temperature: 0
      })
    });

    if (!response.ok) {
      const error = await response.text().catch(() => '未知错误');
      return { success: false, error: `API 请求失败 (${response.status}): ${error}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: `连接失败: ${error.message}` };
  }
}

module.exports = {
  sendFeedback, sendReport, testConnection,
  sendCorrection, parseCorrectionBatchResponse,
  sendTranslation, parseTranslationBatchResponse
};
