// 设置页逻辑

const PROVIDER_CONFIG = {
  'claude-cli': {
    needsKey: false,
    models: [
      { value: 'sonnet', label: 'Sonnet（推荐，快）' },
      { value: 'opus', label: 'Opus（更强，稍慢）' },
      { value: 'haiku', label: 'Haiku（最快）' }
    ]
  },
  openai: {
    needsKey: true,
    keyHint: '在 platform.openai.com 获取',
    models: [
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini（推荐）' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
    ]
  },
  deepseek: {
    needsKey: true,
    keyHint: '在 platform.deepseek.com 获取',
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat（推荐）' },
      { value: 'deepseek-coder', label: 'DeepSeek Coder' }
    ]
  },
  ollama: {
    needsKey: false,
    models: [
      { value: 'qwen2.5:7b', label: 'Qwen 2.5 7B（推荐）' },
      { value: 'llama3.1:8b', label: 'Llama 3.1 8B' },
      { value: 'mistral:7b', label: 'Mistral 7B' }
    ]
  },
  custom: {
    needsKey: true,
    keyHint: '自定义 API Key',
    models: []
  }
};

class SettingsPage {
  constructor() {
    this.providerSelect = document.getElementById('provider');
    this.apikeyInput = document.getElementById('apikey');
    this.apikeyHint = document.getElementById('apikey-hint');
    this.modelSelect = document.getElementById('model');
    this.modelHint = document.getElementById('model-hint');
    this.ollamaUrlInput = document.getElementById('ollama-url');
    this.customBaseUrlInput = document.getElementById('custom-base-url');
    this.customModelInput = document.getElementById('custom-model');
    this.claudeBinInput = document.getElementById('claude-bin');
    this.btnSave = document.getElementById('btn-save');
    this.saveSuccess = document.getElementById('save-success');

    this.groupApikey = document.getElementById('group-apikey');
    this.groupOllama = document.getElementById('group-ollama');
    this.groupCustom = document.getElementById('group-custom');
    this.groupCustomModel = document.getElementById('group-custom-model');
    this.groupClaudeCli = document.getElementById('group-claude-cli');

    // TTS 朗读设置
    this.ttsProviderSelect = document.getElementById('tts-provider');
    this.ttsProviderHint = document.getElementById('tts-provider-hint');
    this.ttsVoiceSelect = document.getElementById('tts-voice');
    this.ttsVoiceHint = document.getElementById('tts-voice-hint');
    this.ttsRateInput = document.getElementById('tts-rate');
    this.ttsRateVal = document.getElementById('tts-rate-val');
    this.ttsPreviewBtn = document.getElementById('tts-preview');
    this.ttsPreviewHint = document.getElementById('tts-preview-hint');
    this._previewAudio = null; // 正在播放的 edge 试听音频

    this.bindEvents();
    this.loadSettings();
  }

  bindEvents() {
    this.providerSelect.addEventListener('change', () => this.onProviderChange());
    this.btnSave.addEventListener('click', () => this.save());

    // TTS
    this.ttsProviderSelect.addEventListener('change', () => this.onTtsProviderChange());
    this.ttsRateInput.addEventListener('input', () => this.updateRateLabel());
    this.ttsPreviewBtn.addEventListener('click', () => this.previewTts());
    // 某些平台 getVoices() 首次为空，voiceschanged 后才有 → 到齐再刷新
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        if (this.ttsProviderSelect.value === 'webspeech') this.populateTtsVoices('webspeech');
      };
      window.speechSynthesis.getVoices();   // 触发加载
    }
  }

  // ===== TTS 朗读设置 =====

  updateRateLabel() {
    this.ttsRateVal.textContent = Number(this.ttsRateInput.value).toFixed(1) + 'x';
  }

  loadTtsSettings() {
    const tts = (this.settings && this.settings.tts) || {};
    this.ttsProviderSelect.value = tts.provider === 'edge' ? 'edge' : 'webspeech';
    this.ttsRateInput.value = Number.isFinite(Number(tts.rate)) ? Number(tts.rate) : 1.0;
    this.updateRateLabel();
    this.onTtsProviderChange();
  }

  onTtsProviderChange() {
    const provider = this.ttsProviderSelect.value;
    this.ttsProviderHint.textContent = provider === 'edge'
      ? 'Microsoft Edge 神经语音，音质更自然；需联网，离线会自动回退系统语音。'
      : '系统内置语音，离线可用，随开随读。';
    this.populateTtsVoices(provider);
  }

  getEnglishSystemVoices() {
    if (!window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
  }

  // ===== 试听：用当前表单值（引擎/语音/语速）直接读一句样例，无需先保存 =====

  async previewTts() {
    const SAMPLE = 'This is a preview of the current voice and speed.';
    const provider = this.ttsProviderSelect.value === 'edge' ? 'edge' : 'webspeech';
    const rate = Number(this.ttsRateInput.value) || 1.0;
    const voice = this.ttsVoiceSelect.value;

    this.stopPreview();

    if (provider === 'edge') {
      this.ttsPreviewBtn.disabled = true;
      this.ttsPreviewBtn.textContent = '⏳ 合成中…';
      this.ttsPreviewHint.textContent = '首次试听需建立连接，慢网络下可能要等 5~12 秒；之后连接保温、秒级出声。';
      try {
        const res = await window.api.ttsSynth(SAMPLE, voice, rate);
        if (!res || !res.success) throw new Error((res && res.error) || 'synth failed');
        const audio = new Audio(res.dataUrl);
        this._previewAudio = audio;
        audio.onended = () => this.resetPreviewBtn();
        await audio.play();
        this.ttsPreviewBtn.disabled = false;
        this.ttsPreviewBtn.textContent = '🔊 再试一次';
        this.ttsPreviewHint.textContent = '正在播放 Edge 神经语音。连接已保温，再点无需重新等待。';
      } catch (e) {
        this.resetPreviewBtn();
        this.ttsPreviewHint.textContent = `⚠️ Edge 在线语音不可用（${e.message}），已改用系统语音试听。`;
        this.speakLocalPreview(SAMPLE, rate, '');
      }
      return;
    }

    this.speakLocalPreview(SAMPLE, rate, voice);
    this.ttsPreviewHint.textContent = '正在用系统语音播放。';
  }

  /** 本地 Web Speech 试听（也是 edge 失败时的回退） */
  speakLocalPreview(text, rate, voiceURI) {
    if (!window.speechSynthesis) {
      this.ttsPreviewHint.textContent = '⚠️ 当前环境不支持系统语音。';
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = rate;
    const chosen = window.TtsHelpers
      ? window.TtsHelpers.pickEnglishVoice(this.getEnglishSystemVoices(), voiceURI)
      : null;
    if (chosen) u.voice = chosen; // pickEnglishVoice 返回的就是真实 SpeechSynthesisVoice
    u.onend = () => this.resetPreviewBtn();
    speechSynthesis.speak(u);
  }

  /** 停掉进行中的试听（本地 + edge 音频），避免叠音 */
  stopPreview() {
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (_) {}
    if (this._previewAudio) {
      try { this._previewAudio.pause(); } catch (_) {}
      this._previewAudio = null;
    }
  }

  resetPreviewBtn() {
    this.ttsPreviewBtn.disabled = false;
    this.ttsPreviewBtn.textContent = '🔊 试听';
  }

  populateTtsVoices(provider) {
    const sel = this.ttsVoiceSelect;
    sel.innerHTML = '';
    const addOption = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    };
    const tts = (this.settings && this.settings.tts) || {};

    if (provider === 'edge') {
      const list = (window.TtsHelpers && window.TtsHelpers.EDGE_VOICES) || [];
      list.forEach(v => addOption(v.value, v.label));
      if (tts.edgeVoice) sel.value = tts.edgeVoice;
      this.ttsVoiceHint.textContent = '在线合成，需联网。';
      return;
    }

    const voices = this.getEnglishSystemVoices();
    if (voices.length === 0) {
      addOption('', '正在加载系统语音…');
      this.ttsVoiceHint.textContent = '若一直为空，说明系统未安装英文语音。';
      return;   // voiceschanged 到齐后会再次调用本函数
    }
    voices.forEach(v => addOption(v.voiceURI, `${v.name} (${v.lang})`));
    const chosen = window.TtsHelpers
      ? window.TtsHelpers.pickEnglishVoice(voices, tts.webspeechVoice)
      : null;
    if (chosen) sel.value = chosen.voiceURI;
    this.ttsVoiceHint.textContent = '系统内置英文语音（来自系统语音设置）。';
  }

  async loadSettings() {
    this.settings = await window.api.getSettings();

    this.providerSelect.value = this.settings.provider || 'claude-cli';

    // 先填充模型列表再加载字段值
    this.onProviderChange();

    // 加载 TTS 朗读设置
    this.loadTtsSettings();
  }

  /** 加载指定 provider 的配置到表单字段 */
  loadProviderFields(provider) {
    const providerConfig = this.settings?.providers?.[provider] || {};

    this.apikeyInput.value = providerConfig.apiKey || '';
    this.ollamaUrlInput.value = providerConfig.ollamaUrl || 'http://localhost:11434';
    this.customBaseUrlInput.value = providerConfig.baseUrl || '';
    this.customModelInput.value = providerConfig.customModel || '';
    this.claudeBinInput.value = providerConfig.binPath || '';

    // 设置模型下拉框（非 custom 模式）
    if (providerConfig.model && provider !== 'custom') {
      this.modelSelect.value = providerConfig.model;
    }
  }

  onProviderChange() {
    const provider = this.providerSelect.value;
    const config = PROVIDER_CONFIG[provider];

    // 显示/隐藏条件字段
    this.groupApikey.classList.toggle('visible', config.needsKey);
    this.groupOllama.classList.toggle('visible', provider === 'ollama');
    this.groupCustom.classList.toggle('visible', provider === 'custom');
    this.groupCustomModel.classList.toggle('visible', provider === 'custom');
    this.groupClaudeCli.classList.toggle('visible', provider === 'claude-cli');

    // 更新key提示
    if (config.keyHint) {
      this.apikeyHint.textContent = config.keyHint;
    }

    // 填充模型列表
    this.modelSelect.innerHTML = '';
    if (config.models.length > 0) {
      config.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        this.modelSelect.appendChild(opt);
      });
      this.modelSelect.parentElement.style.display = '';
    } else {
      this.modelSelect.parentElement.style.display = 'none';
    }

    // 切换后加载该 provider 保存的配置到表单字段
    this.loadProviderFields(provider);
  }

  async save() {
    const provider = this.providerSelect.value;

    // 隐藏上次的错误提示
    const errorEl = document.getElementById('connection-error');
    errorEl.classList.remove('show');
    errorEl.textContent = '';

    // 先获取完整 settings（包含所有 provider 的独立配置）
    const settings = await window.api.getSettings();

    // 只更新当前 provider 的配置
    settings.provider = provider;
    if (!settings.providers) {
      settings.providers = {};
    }

    if (provider === 'claude-cli') {
      // Claude 订阅：只需模型 + 可选二进制路径，无 key
      settings.providers[provider] = {
        model: this.modelSelect.value,
        binPath: this.claudeBinInput.value.trim()
      };
    } else if (provider === 'custom') {
      // custom 的模型名来自自定义输入框
      settings.providers[provider] = {
        apiKey: this.apikeyInput.value.trim(),
        model: this.customModelInput.value.trim(),
        ollamaUrl: this.ollamaUrlInput.value.trim(),
        baseUrl: this.customBaseUrlInput.value.trim(),
        customModel: this.customModelInput.value.trim()
      };
    } else {
      settings.providers[provider] = {
        apiKey: this.apikeyInput.value.trim(),
        model: this.modelSelect.value,
        ollamaUrl: this.ollamaUrlInput.value.trim(),
        baseUrl: this.customBaseUrlInput.value.trim(),
        customModel: ''
      };
    }

    // 持久化 TTS 朗读设置（保留另一 provider 已存的语音选择）
    settings.tts = settings.tts || {};
    const ttsProvider = this.ttsProviderSelect.value === 'edge' ? 'edge' : 'webspeech';
    settings.tts.provider = ttsProvider;
    settings.tts.rate = Number(this.ttsRateInput.value);
    settings.tts.lang = settings.tts.lang || 'en-US';
    if (ttsProvider === 'edge') {
      settings.tts.edgeVoice = this.ttsVoiceSelect.value;
    } else if (this.getEnglishSystemVoices().length > 0) {
      settings.tts.webspeechVoice = this.ttsVoiceSelect.value;
    }
    // else：系统语音还没加载完（下拉只有占位项），保留之前存的选择，别覆盖成 ''

    await window.api.saveSettings(settings);

    // 更新缓存，让下次切换 provider 时能看到最新值
    this.settings = settings;

    // 测试连通性
    this.btnSave.textContent = '⏳ 测试连接中...';
    this.btnSave.classList.add('loading');
    const result = await window.api.testLLMConnection(settings);

    if (result.success) {
      // 连接成功 → 显示保存成功并关闭
      this.btnSave.textContent = '保存设置';
      this.btnSave.classList.remove('loading');
      this.saveSuccess.classList.add('show');
      setTimeout(() => {
        window.close();
      }, 800);
    } else {
      // 连接失败 → 显示红色错误提示，不关闭
      this.btnSave.textContent = '保存设置';
      this.btnSave.classList.remove('loading');
      errorEl.textContent = `⚠️ 大模型测试连接失败，请核对后重试!`;
      errorEl.classList.add('show');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new SettingsPage();
});
