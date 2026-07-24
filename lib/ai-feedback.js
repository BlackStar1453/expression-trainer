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
 * Parse the model's correction response into a validated object.
 * Tolerates ```json fences, surrounding prose, and malformed output.
 * @param {string} raw
 * @returns {{hasError: boolean, original?, corrected?, explanation?, tags?: string[]}}
 */
function parseCorrectionResponse(raw) {
  if (!raw || typeof raw !== 'string') return { hasError: false };

  // Strip code fences and pull out the first {...} block
  let text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { hasError: false };

  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { hasError: false };
  }

  if (!obj || obj.hasError !== true) return { hasError: false };

  return {
    hasError: true,
    original: String(obj.original || '').trim(),
    corrected: String(obj.corrected || '').trim(),
    explanation: String(obj.explanation || '').trim(),
    tags: Array.isArray(obj.tags)
      ? obj.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 3)
      : []
  };
}

/**
 * Mode A — request a correction for one finished English sentence.
 * @param {string} sentence
 * @param {Object} settings   provider config (endpoint/apiKey/model resolved)
 * @param {string[]} existingTags  tags seen this session (for reuse)
 */
async function sendCorrection(sentence, settings, existingTags = []) {
  const prompt = getCorrectionPrompt(sentence, existingTags);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  const result = await callModel(settings, messages, 400);
  return parseCorrectionResponse(result);
}

/**
 * Parse the model's translation response into a validated learning card.
 * Tolerates fences / surrounding prose / malformed output.
 * @param {string} raw
 * @param {string} [fallbackZh]  original Chinese, used if the model omits zh
 * @returns {{zh: string, en: string, note: string, tags: string[]}|null}
 */
function parseTranslationResponse(raw, fallbackZh = '') {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const en = String(obj.en || '').trim();
  if (!en) return null; // an English translation is the whole point

  return {
    zh: String(obj.zh || fallbackZh || '').trim(),
    en,
    note: String(obj.note || '').trim(),
    tags: Array.isArray(obj.tags)
      ? obj.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 3)
      : []
  };
}

/**
 * Mode B — translate one Chinese sentence into an idiomatic English card.
 * @param {string} sentence
 * @param {Object} settings
 * @param {string[]} existingTags
 */
async function sendTranslation(sentence, settings, existingTags = []) {
  const prompt = getTranslationPrompt(sentence, existingTags);

  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ];

  const result = await callModel(settings, messages, 500);
  return parseTranslationResponse(result, sentence);
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
  sendCorrection, parseCorrectionResponse,
  sendTranslation, parseTranslationResponse
};
