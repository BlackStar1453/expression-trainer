const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { initASR, feedAudio, stopRecognition } = require('./lib/asr');
const { loadLexicon, analyzeText } = require('./lib/lexicon');
const { sendFeedback, sendReport, testConnection, sendCorrection, sendTranslation } = require('./lib/ai-feedback');
const storage = require('./lib/storage');
const { diffWords } = require('./lib/diff');
const claudeCli = require('./lib/claude-cli');
const tts = require('./lib/tts');
const { DEFAULT_TTS } = require('./lib/tts-helpers');
const { DEFAULT_ASR } = require('./lib/sentence-buffer');

// 覆盖应用显示名称（菜单栏、Dock、任务栏、窗口标题）
app.setName('英语表达训练');

let mainWindow;
let settingsWindow;
let promptEditorWindow;
let asrReady = false;

// Custom prompt 文件路径
function getCustomPromptPath() {
  return path.join(app.getPath('userData'), 'custom-prompt.json');
}

function loadCustomPrompt() {
  const p = getCustomPromptPath();
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) { return null; }
  }
  return null;
}

function saveCustomPrompt(data) {
  fs.writeFileSync(getCustomPromptPath(), JSON.stringify(data, null, 2));
}

// 各 Provider 的默认配置
const DEFAULT_PROVIDER_CONFIGS = {
  'claude-cli': { model: 'sonnet', binPath: '' },
  openai: { apiKey: '', model: 'gpt-4o-mini' },
  deepseek: { apiKey: '', model: 'deepseek-chat' },
  ollama: { ollamaUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
  custom: { apiKey: '', baseUrl: '', model: '' }
};

// 设置文件路径
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const settingsPath = getSettingsPath();
  if (fs.existsSync(settingsPath)) {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // 兼容旧版扁平结构 → 迁移到 per-provider 结构
    if (!raw.providers) {
      const migrated = {
        provider: raw.provider || 'deepseek',
        providers: {
          openai: { ...DEFAULT_PROVIDER_CONFIGS.openai },
          deepseek: { ...DEFAULT_PROVIDER_CONFIGS.deepseek },
          ollama: { ...DEFAULT_PROVIDER_CONFIGS.ollama },
          custom: { ...DEFAULT_PROVIDER_CONFIGS.custom }
        }
      };
      // 将旧字段迁移到对应 provider
      const p = migrated.provider;
      if (raw.apiKey) migrated.providers[p].apiKey = raw.apiKey;
      if (raw.model) migrated.providers[p].model = raw.model;
      if (raw.ollamaUrl) migrated.providers.ollama.ollamaUrl = raw.ollamaUrl;
      if (raw.customEndpoint) migrated.providers.custom.baseUrl = raw.customEndpoint;
      if (raw.customModel) migrated.providers.custom.model = raw.customModel;
      ensureTtsDefaults(migrated);
      ensureAsrDefaults(migrated);
      saveSettings(migrated);
      return migrated;
    }
    // 确保每个 provider 都有完整的默认字段
    for (const key of Object.keys(DEFAULT_PROVIDER_CONFIGS)) {
      if (!raw.providers[key]) {
        raw.providers[key] = { ...DEFAULT_PROVIDER_CONFIGS[key] };
      } else {
        raw.providers[key] = { ...DEFAULT_PROVIDER_CONFIGS[key], ...raw.providers[key] };
      }
    }
    return ensureAsrDefaults(ensureTtsDefaults(raw));
  }
  return ensureAsrDefaults(ensureTtsDefaults({
    provider: 'claude-cli',
    providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDER_CONFIGS))
  }));
}

function saveSettings(settings) {
  const settingsPath = getSettingsPath();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/** Ensure the TTS block exists with sane defaults (provider 'webspeech'). */
function ensureTtsDefaults(settings) {
  settings.tts = { ...DEFAULT_TTS, ...(settings.tts || {}) };
  return settings;
}

/** Ensure the ASR block exists（断句停顿容忍度等，issue #5）. */
function ensureAsrDefaults(settings) {
  settings.asr = { ...DEFAULT_ASR, ...(settings.asr || {}) };
  return settings;
}

/** 获取当前选中 provider 的配置 */
function getCurrentProviderSettings(settings) {
  const config = settings.providers[settings.provider];
  return config || DEFAULT_PROVIDER_CONFIGS[settings.provider] || {};
}

/** LLM 预热（与 TTS warmup 同思路）：claude-cli 引擎下提前 spawn 常驻进程并
 *  跑一轮微型 ping，把 ~10s 冷启动移出用户路径。已暖时是 no-op，失败静默。 */
function warmClaudeIfActive() {
  try {
    const settings = loadSettings();
    if (settings.provider !== 'claude-cli') return;
    const cfg = getCurrentProviderSettings(settings);
    claudeCli.warmup({ model: cfg.model, binPath: cfg.binPath })
      .then((ok) => { if (ok) console.log('[LLM] claude 常驻进程预热完成'); });
  } catch { /* 预热失败不影响正常使用 */ }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#000000',
    title: '英语表达训练',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setFullScreenable(true);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createPromptEditorWindow() {
  if (promptEditorWindow) {
    promptEditorWindow.focus();
    return;
  }

  promptEditorWindow = new BrowserWindow({
    width: 720,
    height: 700,
    resizable: true,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  promptEditorWindow.loadFile(path.join(__dirname, 'src', 'prompt-editor.html'));

  promptEditorWindow.on('closed', () => {
    promptEditorWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 680,
    resizable: false,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    parent: mainWindow,
    modal: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// App lifecycle
app.whenReady().then(() => {
  // macOS 需要显式创建应用菜单，否则菜单栏显示默认的 "Electron"
  // Windows/Linux 上此菜单同样适用，macOS 专属角色（hide/hideOthers）会自动生效
  const appMenuTemplate = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate));

  // 加载词库
  loadLexicon();

  // 初始化学习数据存储
  storage.initStorage(path.join(app.getPath('userData'), 'learning-data'));

  createMainWindow();

  // 启动即预热 LLM 常驻进程（第一张纠错/学习卡不再付 ~10s 冷启动）
  warmClaudeIfActive();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 退出时关掉常驻 claude 子进程
app.on('before-quit', () => {
  claudeCli.shutdown();
  tts.shutdown(); // 关掉常驻 Edge TTS 连接
});

// IPC Handlers

// 设置相关
ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('save-settings', (event, settings) => {
  saveSettings(settings);
  // 设置变更（如换模型）后立即按新配置预热，避免下一句真请求付冷启动
  warmClaudeIfActive();
  return { success: true };
});

ipcMain.handle('open-settings', () => {
  createSettingsWindow();
});

// Prompt编辑器相关
ipcMain.handle('open-prompt-editor', () => {
  createPromptEditorWindow();
});

ipcMain.handle('get-custom-prompt', () => {
  return loadCustomPrompt();
});

ipcMain.handle('save-custom-prompt', (event, data) => {
  saveCustomPrompt(data);
  return { success: true };
});

ipcMain.handle('close-current-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// 语音识别相关 - Web Audio方案
// mode: 'A'（说英语，用英文 zipformer）| 'B'（说中文，用中英双语 paraformer）
ipcMain.handle('init-asr', async (event, mode) => {
  try {
    await initASR(mode);
    asrReady = true;
    // 开始录制 = 马上会有句子送 LLM：顺手预热（已暖时是 no-op）
    warmClaudeIfActive();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 接收渲染进程发来的音频数据
ipcMain.handle('feed-audio', (event, samplesArray) => {
  if (!asrReady) return null;
  const samples = new Float32Array(samplesArray);
  const result = feedAudio(samples);
  return result; // { text, isFinal } or null
});

ipcMain.handle('stop-asr', () => {
  const finalText = stopRecognition();
  asrReady = false;
  return { success: true, finalText };
});

// LLM 连通性测试
ipcMain.handle('test-llm-connection', async (event, settings) => {
  const providerConfig = getCurrentProviderSettings(settings);
  return await testConnection({ ...settings, ...providerConfig });
});

// 词库分析
ipcMain.handle('analyze-text', (event, text) => {
  return analyzeText(text);
});

// 文件保存
ipcMain.handle('save-file', async (event, content, filename) => {
  const { dialog } = require('electron');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存报告',
    defaultPath: path.join(app.getPath('desktop'), filename),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });

  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  }
  return { success: false };
});

// AI反馈（传入customPrompt）
ipcMain.handle('get-realtime-feedback', async (event, text) => {
  const settings = loadSettings();
  const providerConfig = getCurrentProviderSettings(settings);
  const customPrompt = loadCustomPrompt();
  try {
    const feedback = await sendFeedback(text, { ...settings, ...providerConfig }, customPrompt);
    return { success: true, feedback };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 学习数据存储
ipcMain.handle('save-session', (event, session) => {
  try {
    const paths = storage.saveSession(session);
    return { success: true, ...paths };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-tags', () => {
  return storage.loadTags();
});

// Mode B 跟读：本地词级 diff（离线，不调 AI）
ipcMain.handle('diff-words', (event, { target, spoken }) => {
  return diffWords(target, spoken);
});

// TTS v2 'edge' provider：主进程合成 mp3，返回 data URL 供渲染进程 <audio> 播放。
// 有超时护栏；失败时渲染进程回退到离线 Web Speech（'webspeech' 完全不走这里）。
ipcMain.handle('tts-synth', async (event, { text, voice, rate }) => {
  try {
    const buf = await tts.synthEdge(text, { voice, rate });
    const dataUrl = 'data:audio/mpeg;base64,' + buf.toString('base64');
    return { success: true, dataUrl };
  } catch (error) {
    // 打进主进程日志：edge 失败原因否则不可见（渲染层只静默回退），排查全靠它
    console.warn('[TTS] edge 合成失败，渲染层将回退本地语音:', error.message);
    return { success: false, error: error.message };
  }
});

// TTS 连接预热：应用启动/开始录制时提前建好 Edge 连接（离线失败属预期，不报错）
ipcMain.handle('tts-warmup', async (event, { voice } = {}) => {
  const ok = await tts.warmup(voice);
  if (ok) console.log('[TTS] edge 连接预热完成');
  return { success: ok };
});

// Mode A: 按句纠错（结构化返回 + 标签）
ipcMain.handle('get-sentence-correction', async (event, { sentence, existingTags }) => {
  const settings = loadSettings();
  const providerConfig = getCurrentProviderSettings(settings);
  try {
    // v2（issue #5）：sentence 实为断续口语合并段；LLM 断句后返回逐句数组，null = 解析失败
    const corrections = await sendCorrection(sentence, { ...settings, ...providerConfig }, existingTags || []);
    if (!corrections) return { success: false, error: 'AI 返回无法解析' };
    return { success: true, corrections };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Mode B: 中译英学习卡（结构化返回 + 标签）
ipcMain.handle('get-translation', async (event, { sentence, existingTags }) => {
  const settings = loadSettings();
  const providerConfig = getCurrentProviderSettings(settings);
  try {
    // v2（issue #5）：LLM 断句后一句一卡，返回数组；null = 解析失败/无可用卡
    const cards = await sendTranslation(sentence, { ...settings, ...providerConfig }, existingTags || []);
    if (!cards) return { success: false, error: 'AI 返回无法解析' };
    return { success: true, cards };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-final-report', async (event, { fullText, stats, corrections }) => {
  const settings = loadSettings();
  const providerConfig = getCurrentProviderSettings(settings);
  const customPrompt = loadCustomPrompt();
  try {
    const report = await sendReport(fullText, stats, { ...settings, ...providerConfig }, customPrompt, corrections || []);
    return { success: true, report };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
