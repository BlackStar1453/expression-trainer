// 渲染进程 TTS 控制器 —— 全应用唯一的朗读入口 window.tts.speak(text, opts)
//
// v1 provider 'webspeech'：SpeechSynthesis，零依赖、离线、可打断、可重复。
// v2 provider 'edge'：请求主进程用 Edge 神经语音合成 mp3（data URL）→ <audio> 播放；
//   合成失败（网络/超时）时回退到 Web Speech，并弹一个不打断的轻提示。
//
// 依赖：window.TtsHelpers（../lib/tts-helpers.js，纯函数）+ window.api.ttsSynth / getSettings。
// XSS 说明：本文件只朗读文本、从不把文本注入 HTML；🔊 按钮由 app.js 用 addEventListener 挂载。

class TtsController {
  constructor() {
    this.audio = null;          // 当前播放中的 HTMLAudioElement（edge）
    this.settings = null;       // resolveTtsSettings 结果
    this._noticeTimer = null;
    this._gen = 0;              // 单调递增的“朗读代”，用于打断在途 edge 合成，避免叠音
    this._cache = new Map();    // edge 音频缓存：`voice|rate|text` → dataUrl（插入序，超限淘汰最旧）
    this._inflight = new Map(); // 在途合成去重：同 key 的预合成与点击共用一个 Promise
    this._loadSettings();
    // 设置窗口保存后主窗口重新获得焦点 → 刷新一次，免重启即可生效
    window.addEventListener('focus', () => this._loadSettings());
    // 有些平台 getVoices() 首次为空，voiceschanged 后才有列表——预热一下
    if (window.speechSynthesis) {
      try { window.speechSynthesis.getVoices(); } catch (_) {}
    }
  }

  async _loadSettings() {
    const H = window.TtsHelpers;
    try {
      const raw = await window.api.getSettings();
      this.settings = H.resolveTtsSettings(raw);
    } catch (_) {
      this.settings = H.resolveTtsSettings({});
    }
    // edge 引擎：顺手预热连接（活连接是瞬时 no-op；换语音后会预建新连接）
    this.warmup();
    return this.settings;
  }

  reloadSettings() { return this._loadSettings(); }

  /** 预热 Edge 连接（fire-and-forget；仅 edge 引擎下生效，失败静默） */
  warmup() {
    const s = this.settings;
    if (!s || s.provider !== 'edge') return;
    if (window.api.ttsWarmup) {
      window.api.ttsWarmup(s.voice).catch(() => {});
    }
  }

  /** 供设置页/调试用：当前可选的英文 Web Speech 语音 */
  getEnglishVoices() {
    if (!window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
  }

  /** 打断当前朗读（Web Speech + edge <audio> 都停），并作废任何在途 edge 合成 */
  stop() {
    this._gen++;   // 作废在途合成：其回调发现代号变了就不再播放
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
    if (this.audio) {
      try { this.audio.pause(); } catch (_) {}
      this.audio.src = '';
      this.audio = null;
    }
  }

  /**
   * 朗读一段文本。可打断（先 stop 再说）、非阻塞。
   * @param {string} text
   * @param {{lang?:string, rate?:number}} [opts]
   */
  async speak(text, opts = {}) {
    const H = window.TtsHelpers;
    const clean = H.normalizeSpeakText(text);
    if (!clean) return;

    if (!this.settings) await this._loadSettings();
    const s = this.settings || H.resolveTtsSettings({});
    const rate = opts.rate != null ? opts.rate : s.rate;
    const lang = opts.lang || s.lang || 'en-US';

    this.stop();          // 打断任何正在进行的朗读，避免叠音
    const gen = this._gen; // 本次朗读的代号（stop 后捕获）

    if (s.provider === 'edge') {
      const ok = await this._speakEdge(clean, s.voice, rate, gen);
      if (ok) return;
      if (gen !== this._gen) return;   // 已被更新的一次朗读接管，别再回退
      // 网络/超时失败 → 轻提示 + 回退 Web Speech
      this._notice('🔈 在线语音不可用，已用本地语音朗读');
      this._speakWeb(clean, s.voice, rate, lang);
      return;
    }

    this._speakWeb(clean, s.voice, rate, lang);
  }

  _speakWeb(text, preferredVoice, rate, lang) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    // Web Speech rate 合法区间 0.1–10；我们的 rate 已在 0.5–2.0
    u.rate = Math.min(10, Math.max(0.1, Number(rate) || 1));
    const chosen = window.TtsHelpers.pickEnglishVoice(window.speechSynthesis.getVoices(), preferredVoice);
    if (chosen) { u.voice = chosen; u.lang = chosen.lang || lang; }
    window.speechSynthesis.speak(u);
  }

  /**
   * 预合成：卡片一出现就在后台合成音频进缓存，用户点 🔊 时即点即播。
   * 只在 edge 引擎下生效（webspeech 本地即时无需预热）；失败静默——
   * 点击时会再试并走既有回退路径。fire-and-forget，不阻塞调用方。
   */
  prefetch(text) {
    (async () => {
      const H = window.TtsHelpers;
      const clean = H.normalizeSpeakText(text);
      if (!clean) return;
      if (!this.settings) await this._loadSettings();
      const s = this.settings;
      if (!s || s.provider !== 'edge') return;
      try { await this._synthCached(clean, s.voice, s.rate); } catch (_) { /* 点击时再回退 */ }
    })();
  }

  /** 合成并缓存（在途去重）：命中缓存立即返回 dataUrl */
  _synthCached(text, voice, rate) {
    const key = `${voice}|${rate}|${text}`;
    if (this._cache.has(key)) return Promise.resolve(this._cache.get(key));
    if (this._inflight.has(key)) return this._inflight.get(key);

    const p = (async () => {
      const res = await window.api.ttsSynth(text, voice, rate);
      if (!res || !res.success || !res.dataUrl) {
        throw new Error((res && res.error) || 'edge synth failed');
      }
      // 简单容量上限：Map 保持插入序，超限淘汰最旧（每条 mp3 base64 约 20-50KB）
      if (this._cache.size >= 120) {
        this._cache.delete(this._cache.keys().next().value);
      }
      this._cache.set(key, res.dataUrl);
      return res.dataUrl;
    })();
    this._inflight.set(key, p);
    p.finally(() => this._inflight.delete(key));
    return p;
  }

  /** @returns {Promise<boolean>} 是否已处理（true=已播放或已被更新的朗读接管；false=失败需回退） */
  async _speakEdge(text, voice, rate, gen) {
    try {
      const dataUrl = await this._synthCached(text, voice, rate); // 预合成命中时零等待
      if (gen !== this._gen) return true;   // 合成期间被打断，交给更新的朗读，不再播放/回退
      const audio = new Audio(dataUrl);
      this.audio = audio;
      await audio.play();   // 若被浏览器策略拒绝会 reject → 回退
      return true;
    } catch (_) {
      return gen !== this._gen; // 被打断则视为已处理；否则交给调用方回退
    }
  }

  // 右下角一个 3s 自动消失的轻提示（不打断用户操作）
  _notice(msg) {
    let el = document.getElementById('tts-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tts-notice';
      el.className = 'tts-notice';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }
}

window.tts = new TtsController();
