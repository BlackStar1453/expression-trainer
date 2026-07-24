const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  // Prompt编辑器
  openPromptEditor: () => ipcRenderer.invoke('open-prompt-editor'),
  getCustomPrompt: () => ipcRenderer.invoke('get-custom-prompt'),
  saveCustomPrompt: (data) => ipcRenderer.invoke('save-custom-prompt', data),
  closeWindow: () => ipcRenderer.invoke('close-current-window'),

  // 语音识别 - 使用 Web Audio 方案（mode: 'A' 说英语 | 'B' 说中文）
  initASR: (mode) => ipcRenderer.invoke('init-asr', mode),
  feedAudio: (samples) => ipcRenderer.invoke('feed-audio', Array.from(samples)),
  stopASR: () => ipcRenderer.invoke('stop-asr'),
  onASRResult: (callback) => {
    ipcRenderer.on('asr-result', (event, data) => callback(data));
  },
  removeASRListener: () => {
    ipcRenderer.removeAllListeners('asr-result');
  },

  // 词库分析
  analyzeText: (text) => ipcRenderer.invoke('analyze-text', text),

  // AI反馈
  getRealtimeFeedback: (text) => ipcRenderer.invoke('get-realtime-feedback', text),
  getSentenceCorrection: (sentence, existingTags) => ipcRenderer.invoke('get-sentence-correction', { sentence, existingTags }),
  getTranslation: (sentence, existingTags) => ipcRenderer.invoke('get-translation', { sentence, existingTags }),
  getFinalReport: (data) => ipcRenderer.invoke('get-final-report', data),
  testLLMConnection: (settings) => ipcRenderer.invoke('test-llm-connection', settings),

  // 文件保存
  saveFile: (content, filename) => ipcRenderer.invoke('save-file', content, filename),

  // 学习数据存储
  saveSession: (session) => ipcRenderer.invoke('save-session', session),
  getTags: () => ipcRenderer.invoke('get-tags'),

  // Mode B 跟读词级 diff
  diffWords: (target, spoken) => ipcRenderer.invoke('diff-words', { target, spoken }),

  // TTS 'edge' provider：主进程合成 → { success, dataUrl } 或 { success:false, error }
  ttsSynth: (text, voice, rate) => ipcRenderer.invoke('tts-synth', { text, voice, rate }),
  ttsWarmup: (voice) => ipcRenderer.invoke('tts-warmup', { voice }),
});
