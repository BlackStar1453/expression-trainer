// 英语表达训练 · Mode A (speak English → local highlight + AI corrections)

class ExpressionTrainer {
  constructor() {
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = null;
    this.pausedTime = 0;
    this.pauseStart = null;
    this.timerInterval = null;
    this.fullText = '';
    this.sentences = [];
    this.stats = { fillers: 0, hedges: 0, vagueWords: 0, totalWords: 0, duration: 0 };
    this.lastFeedbackText = '';
    this.lastReport = '';
    // 模式：'A' 说英语纠错 | 'B' 说中文学地道英文
    this.mode = 'A';
    // Mode A: 本场累积的纠错卡片 + 生长式标签集（供报告与存储用）
    this.corrections = [];
    this.sessionTags = new Set();
    // Mode B: 本场累积的中译英学习卡片 + 跟读状态
    this.bcards = [];
    this.shadowingEntry = null;   // 正在跟读的卡片
    this.shadowBtn = null;        // 对应的跟读按钮
    // 历史标签注册表（跨会话复用，注入纠错 prompt 让 AI 优先复用旧标签）
    this.registryTags = [];
    if (window.api.getTags) {
      window.api.getTags().then(tags => { this.registryTags = tags || []; });
    }

    this.initElements();
    this.bindEvents();
  }

  initElements() {
    this.btnStart = document.getElementById('btn-start');
    this.btnPaste = document.getElementById('btn-paste');
    this.btnPause = document.getElementById('btn-pause');
    this.btnResume = document.getElementById('btn-resume');
    this.btnStop = document.getElementById('btn-stop');
    this.btnReport = document.getElementById('btn-report');
    this.btnSettings = document.getElementById('btn-settings');
    this.btnCloseReport = document.getElementById('btn-close-report');
    this.btnClosePaste = document.getElementById('btn-close-paste');
    this.btnAnalyzePaste = document.getElementById('btn-analyze-paste');
    this.btnCopyText = document.getElementById('btn-copy-text');
    this.btnSaveText = document.getElementById('btn-save-text');
    this.btnClear = document.getElementById('btn-clear');
    this.btnCopyReport = document.getElementById('btn-copy-report');
    this.pasteModal = document.getElementById('paste-modal');
    this.pasteTextarea = document.getElementById('paste-textarea');
    this.timer = document.getElementById('timer');
    this.subtitleScroll = document.getElementById('subtitle-scroll');
    this.subtitleContainer = document.getElementById('subtitle-container');
    this.feedbackContent = document.getElementById('feedback-content');
    this.reportModal = document.getElementById('report-modal');
    this.reportBody = document.getElementById('report-body');
    this.statFillers = document.getElementById('stat-fillers');
    this.statHedges = document.getElementById('stat-hedges');
    this.statVague = document.getElementById('stat-vague');
    this.statDensity = document.getElementById('stat-density');
    this.modeABtn = document.getElementById('mode-a');
    this.modeBBtn = document.getElementById('mode-b');
    this.rightPanelTitle = document.getElementById('right-panel-title');
    this.startLabel = this.btnStart.querySelector('.btn-label');
  }

  bindEvents() {
    this.btnStart.addEventListener('click', () => this.startRecording());
    this.btnPaste.addEventListener('click', () => this.openPasteModal());
    this.btnPause.addEventListener('click', () => this.pauseRecording());
    this.btnResume.addEventListener('click', () => this.resumeRecording());
    this.btnStop.addEventListener('click', () => this.stopRecording());
    this.btnReport.addEventListener('click', () => this.generateReport());
    this.btnSettings.addEventListener('click', () => window.api.openSettings());
    document.getElementById('btn-prompt-editor').addEventListener('click', () => window.api.openPromptEditor());
    this.btnCloseReport.addEventListener('click', () => this.reportModal.classList.add('hidden'));
    this.btnCopyReport.addEventListener('click', () => {
      const reportText = this.reportBody.innerText;
      navigator.clipboard.writeText(reportText).then(() => {
        this.btnCopyReport.textContent = '✅ 已复制';
        setTimeout(() => { this.btnCopyReport.textContent = '📋 复制全文'; }, 2000);
      });
    });
    this.btnClosePaste.addEventListener('click', () => this.pasteModal.classList.add('hidden'));
    this.btnAnalyzePaste.addEventListener('click', () => this.analyzePastedText());
    this.btnCopyText.addEventListener('click', () => this.copyOriginalText());
    this.btnSaveText.addEventListener('click', () => this.saveOriginalText());
    this.btnClear.addEventListener('click', () => this.clearAll());
    this.modeABtn.addEventListener('click', () => this.switchMode('A'));
    this.modeBBtn.addEventListener('click', () => this.switchMode('B'));
  }

  // ===== 模式切换 =====

  switchMode(mode) {
    if (mode === this.mode) return;
    if (this.isRecording) {
      this.showError('录制中不能切换模式，请先结束');
      return;
    }
    this.mode = mode;
    this.modeABtn.classList.toggle('active', mode === 'A');
    this.modeBBtn.classList.toggle('active', mode === 'B');
    this.rightPanelTitle.textContent = mode === 'A' ? '✏️ 纠错卡片' : '📖 学习卡片';
    if (this.startLabel) this.startLabel.textContent = mode === 'A' ? '开始录制' : '说中文';
    // 切模式清空当前会话内容
    this.clearAll();
  }

  // ===== 录制控制 =====

  async startRecording() {
    // 按当前模式选择识别模型：Mode A 用英文模型，Mode B 用中英双语模型
    const initResult = await window.api.initASR(this.mode);
    if (!initResult.success) {
      this.showError(`语音识别启动失败: ${initResult.error}`);
      return;
    }

    // 开始录制 = 马上会出卡片：顺手预热 TTS 连接（说完第一句时连接已就绪）
    if (window.tts && window.tts.warmup) window.tts.warmup();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(stream);
      this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.audioProcessor.onaudioprocess = async (e) => {
        if (!this.isRecording || this.isPaused) return;
        const samples = e.inputBuffer.getChannelData(0);
        const result = await window.api.feedAudio(samples);
        if (result) this.handleASRResult(result);
      };
      source.connect(this.audioProcessor);
      this.audioProcessor.connect(this.audioContext.destination);
      this.mediaStream = stream;
    } catch (err) {
      this.showError(`麦克风访问失败: ${err.message}`);
      return;
    }

    this.isRecording = true;
    this.isPaused = false;
    this.startTime = Date.now();
    this.pausedTime = 0;
    this.fullText = '';
    this.sentences = [];
    this.resetStats();
    this.subtitleContainer.innerHTML = '';

    // UI
    this.btnStart.classList.add('hidden');
    this.btnPause.classList.remove('hidden');
    this.btnStop.classList.remove('hidden');
    this.btnReport.classList.add('hidden');
    this.btnResume.classList.add('hidden');
    this.timer.classList.add('active');

    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  pauseRecording() {
    this.isPaused = true;
    this.pauseStart = Date.now();
    this.btnPause.classList.add('hidden');
    this.btnResume.classList.remove('hidden');
    this.timer.classList.remove('active');
  }

  resumeRecording() {
    this.isPaused = false;
    this.pausedTime += Date.now() - this.pauseStart;
    this.pauseStart = null;
    this.btnResume.classList.add('hidden');
    this.btnPause.classList.remove('hidden');
    this.timer.classList.add('active');
  }

  async stopRecording() {
    this.disarmShadow();
    if (this.audioProcessor) { this.audioProcessor.disconnect(); this.audioProcessor = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    await window.api.stopASR();
    this.isRecording = false;
    this.isPaused = false;

    clearInterval(this.timerInterval);
    let totalPaused = this.pausedTime;
    if (this.pauseStart) totalPaused += Date.now() - this.pauseStart;
    this.stats.duration = Math.floor((Date.now() - this.startTime - totalPaused) / 1000);

    // UI：显示生成报告按钮，可翻阅字幕
    this.btnStop.classList.add('hidden');
    this.btnPause.classList.add('hidden');
    this.btnResume.classList.add('hidden');
    this.btnStart.classList.remove('hidden');
    this.timer.classList.remove('active');

    const hasContent = this.fullText.trim() || this.bcards.length > 0;
    if (hasContent) {
      this.btnClear.classList.remove('hidden');
      if (this.mode === 'A') {
        this.btnReport.classList.remove('hidden');
        this.btnCopyText.classList.remove('hidden');
        this.btnSaveText.classList.remove('hidden');
      }
      this.saveCurrentSession();   // 自动存档为 JSON + MD + 更新索引/标签
    }
  }

  // ===== ASR结果处理 =====

  handleASRResult({ text, isFinal }) {
    if (isFinal) {
      this.sentences.push(text);
      if (this.mode === 'A') {
        // 英文按空格拼接，避免句子粘连
        this.fullText += (this.fullText ? ' ' : '') + text;
        this.analyzeCurrentSentence(text);   // 本地词库层：驱动统计 + 高亮
        this.requestCorrection(text);        // AI 层：按句纠错卡片
      } else {
        this.handleModeBSentence(text);      // Mode B：说中文 → 翻译/跟读
      }
    }
    this.renderSubtitle(text, isFinal);
  }

  renderSubtitle(currentText, isFinal) {
    const follow = this._isNearBottom(this.subtitleScroll);
    if (isFinal) {
      // 移除interim
      const interim = this.subtitleContainer.querySelector('.interim-line');
      if (interim) interim.remove();

      // 旧行变灰
      this.subtitleContainer.querySelectorAll('.subtitle-line:not(.old)').forEach(el => {
        el.classList.add('old');
      });

      // 新行
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      line.innerHTML = this.highlightText(currentText);
      this.subtitleContainer.appendChild(line);
    } else {
      let interim = this.subtitleContainer.querySelector('.interim-line');
      if (!interim) {
        interim = document.createElement('div');
        interim.className = 'subtitle-line interim-line';
        this.subtitleContainer.appendChild(interim);
      }
      interim.textContent = currentText;
    }

    // 自动滚到底（仅当用户本就在底部附近，回看时不打断）
    if (follow) this.subtitleScroll.scrollTop = this.subtitleScroll.scrollHeight;
  }

  highlightText(text) {
    // NOTE(tech-debt): these word lists are duplicated from data/english-lexicon.json.
    // Should be unified via an IPC (get-lexicon) so highlighting & stats share one source.
    // Known limitation: pure string matching flags "like"/"actually" even when used
    // legitimately (verb / adverb). Mode A's AI layer makes the precise call.
    let result = text;

    // Vague (green) — multi-word phrases first so "very good" isn't split into "good"
    const vagueWords = ['very good','a lot','good','bad','nice','big','small','happy','sad','important','interesting','beautiful','difficult','easy'];
    const vagueRe = new RegExp(`(?<![A-Za-z])(${vagueWords.join('|')})(?![A-Za-z])`, 'gi');
    result = result.replace(vagueRe, '<span class="vague">$1</span>');

    // Fillers (orange)
    const fillers = ['you know','i mean','kind of','sort of','um','uh','er','erm','hmm','like','basically','actually','literally'];
    const fillerRe = new RegExp(`(?<![A-Za-z])(${fillers.join('|')})(?![A-Za-z])`, 'gi');
    result = result.replace(fillerRe, '<span class="filler">$1</span>');

    // Hedges (yellow)
    const hedges = ['i think','i guess','i suppose','i feel like','more or less','maybe','perhaps','probably','possibly','somewhat','not sure','might be'];
    const hedgeRe = new RegExp(`(?<![A-Za-z])(${hedges.join('|')})(?![A-Za-z])`, 'gi');
    result = result.replace(hedgeRe, '<span class="hedge">$1</span>');

    return result;
  }

  // ===== 分析 =====

  async analyzeCurrentSentence(text) {
    // 本地词库层：只更新左栏统计（右栏保留给 AI 纠错卡，字幕区已有实时高亮）
    const analysis = await window.api.analyzeText(text);
    if (analysis) {
      this.stats.fillers += analysis.fillers.length;
      this.stats.hedges += analysis.hedges.length;
      this.stats.vagueWords += analysis.vagueWords.length;
      this.stats.totalWords += analysis.totalWords;
      this.updateStatsDisplay();
    }
  }

  // ===== Mode A：按句 AI 纠错卡片 =====

  async requestCorrection(sentence) {
    if (!sentence || !sentence.trim()) return;
    const existingTags = [...new Set([...this.registryTags, ...this.sessionTags])];

    // 句子送出即出现占位卡（转圈 + 原句），AI 回来后原位收尾——LLM 等待可见化
    const pending = this._insertPendingCard(sentence, '正在纠错…');
    let result = null;
    try {
      result = await window.api.getSentenceCorrection(sentence, existingTags);
    } catch (_) { /* 下面统一走失败收尾 */ }
    if (!result || !result.success) {
      this._resolvePendingCard(pending, '⚠️ 纠错失败，已跳过', false);
      return;
    }

    const c = result.correction;
    if (!c || !c.hasError) {
      // 整句地道 → 占位卡变 ✓ 短暂停留后淡出（不留卡刷屏）
      this._resolvePendingCard(pending, '✓ 这句很地道', true);
      return;
    }

    // 记录标签（生长式：新标签并入本场集合）
    (c.tags || []).forEach(t => this.sessionTags.add(t));

    const entry = {
      original: c.original || sentence,
      corrected: c.corrected || '',
      explanation: c.explanation || '',
      tags: c.tags || [],
      timestamp: Date.now()
    };
    this.corrections.push(entry);
    this.renderCorrectionCard(entry, pending);
  }

  // ===== LLM 等待占位卡 =====

  /** 是否接近底部——仅此时才跟随滚动，用户回看旧内容时不强行拉走视口 */
  _isNearBottom(el, threshold = 80) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  /** 插入一张「转圈占位卡」，返回元素供后续原位替换/收尾 */
  _insertPendingCard(text, label) {
    const el = document.createElement('div');
    el.className = 'pending-card';
    el.innerHTML = `
      <div class="pc-row"><span class="pc-spinner"></span><span class="pc-label">${this.escapeHtml(label)}</span></div>
      <div class="pc-text">${this.escapeHtml(text)}</div>
    `;
    // 新卡追加到底部，与字幕出现顺序一致
    const follow = this._isNearBottom(this.feedbackContent);
    this.feedbackContent.appendChild(el);
    if (follow) this.feedbackContent.scrollTop = this.feedbackContent.scrollHeight;
    return el;
  }

  /** 占位卡轻收尾：变成一条简短结果（✓/⚠️），停留片刻后淡出移除 */
  _resolvePendingCard(el, message, ok) {
    if (!el || !el.isConnected) return; // 会话已清空（如切模式）→ 迟到结果直接丢弃
    el.classList.add(ok ? 'done' : 'failed');
    const row = el.querySelector('.pc-row');
    if (row) row.innerHTML = `<span class="pc-label">${this.escapeHtml(message)}</span>`;
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 400);
    }, 1600);
  }

  renderCorrectionCard(entry, pendingEl = null) {
    // 有占位卡且会话已被清空（如切模式）→ 迟到结果直接丢弃，不复活旧会话内容
    if (pendingEl && !pendingEl.isConnected) return;
    const card = document.createElement('div');
    card.className = 'correction-card';

    const tagsHtml = (entry.tags || [])
      .map(t => `<span class="tag-chip">${this.escapeHtml(t)}</span>`)
      .join('');

    card.innerHTML = `
      <div class="cc-original">
        <span class="cc-text">${this.escapeHtml(entry.original)}</span>
      </div>
      <div class="cc-corrected">
        <span class="cc-text">${this.escapeHtml(entry.corrected)}</span>
        ${entry.corrected ? '<button class="tts-btn" data-tts="corrected" title="朗读地道表达" aria-label="朗读地道表达">🔊</button>' : ''}
      </div>
      ${entry.explanation ? `<div class="cc-explain">${this.escapeHtml(entry.explanation)}</div>` : ''}
      ${tagsHtml ? `<div class="cc-tags">${tagsHtml}</div>` : ''}
    `;

    this._wireSpeakButton(card, '[data-tts="corrected"]', entry.corrected);

    // 有占位卡则原位替换（保持与说话顺序一致的落点），否则追加到底部
    const follow = this._isNearBottom(this.feedbackContent);
    if (pendingEl) pendingEl.replaceWith(card);
    else this.feedbackContent.appendChild(card);
    while (this.feedbackContent.children.length > 20) {
      this.feedbackContent.removeChild(this.feedbackContent.firstChild); // 追加布局下顶端是最旧
    }
    if (follow) this.feedbackContent.scrollTop = this.feedbackContent.scrollHeight;

    // 卡片一出现就后台预合成（edge 引擎下），点 🔊 时即点即播
    if (window.tts && window.tts.prefetch) {
      window.tts.prefetch(entry.corrected);
    }
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 给卡片里的 🔊 按钮挂朗读处理：文本取自 JS 对象（闭包），不经 DOM/onclick，天然 XSS 安全
  _wireSpeakButton(root, selector, text) {
    const btn = root.querySelector(selector);
    if (btn && text && window.tts) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btn.classList.contains('loading')) return;
        // 合成期间转圈（预合成命中时几乎瞬间恢复）；出声即恢复图标
        btn.classList.add('loading');
        try { await window.tts.speak(text); }
        finally { btn.classList.remove('loading'); }
      });
    }
  }

  // ===== Mode B：说中文 → 地道英文学习卡 =====

  handleModeBSentence(sentence) {
    // 若已武装跟读，这一句视为对目标英文的朗读
    if (this.shadowingEntry) {
      this.evaluateShadow(sentence);
      return;
    }
    // 否则视为新的一句中文 → 翻译成学习卡
    this.stats.totalWords += sentence.trim().length;
    this.updateStatsDisplay();
    this.requestTranslation(sentence);
  }

  async requestTranslation(sentence) {
    if (!sentence || !sentence.trim()) return;
    const existingTags = [...new Set([...this.registryTags, ...this.sessionTags])];

    // 与纠错同款：句子送出即出占位卡，翻译回来原位换真卡
    const pending = this._insertPendingCard(sentence, '正在翻译…');
    let result = null;
    try {
      result = await window.api.getTranslation(sentence, existingTags);
    } catch (_) { /* 下面统一走失败收尾 */ }
    if (!result || !result.success || !result.card) {
      this._resolvePendingCard(pending, '⚠️ 翻译失败，已跳过', false);
      return;
    }

    const card = result.card;
    (card.tags || []).forEach(t => this.sessionTags.add(t));

    const entry = {
      zh: card.zh || sentence,
      en: card.en || '',
      note: card.note || '',
      tags: card.tags || [],
      shadow: null,          // 跟读结果（slice 6 填充）
      timestamp: Date.now()
    };
    this.bcards.push(entry);
    this.renderLearningCard(entry, pending);
  }

  renderLearningCard(entry, pendingEl = null) {
    // 会话已清空（切模式）→ 迟到结果丢弃
    if (pendingEl && !pendingEl.isConnected) return;
    const card = document.createElement('div');
    card.className = 'learning-card';

    const tagsHtml = (entry.tags || [])
      .map(t => `<span class="tag-chip">${this.escapeHtml(t)}</span>`)
      .join('');

    card.innerHTML = `
      <div class="lc-zh">${this.escapeHtml(entry.zh)}</div>
      <div class="lc-en">
        <span class="lc-en-text">${this.escapeHtml(entry.en)}</span>
        ${entry.en ? '<button class="tts-btn" data-tts="en" title="朗读英文" aria-label="朗读英文">🔊</button>' : ''}
      </div>
      ${entry.note ? `<div class="lc-note">${this.escapeHtml(entry.note)}</div>` : ''}
      ${tagsHtml ? `<div class="cc-tags">${tagsHtml}</div>` : ''}
      <div class="lc-shadow">
        <div class="lc-diff"></div>
        <div class="lc-shadow-actions">
          <button class="btn-shadow">🎤 跟读</button>
          <span class="lc-score"></span>
        </div>
      </div>
    `;

    entry._el = card;
    this._wireSpeakButton(card, '[data-tts="en"]', entry.en);
    const btn = card.querySelector('.btn-shadow');
    btn.addEventListener('click', () => this.armShadow(entry, btn));
    // 有占位卡则原位替换，否则追加到底部
    const follow = this._isNearBottom(this.feedbackContent);
    if (pendingEl) pendingEl.replaceWith(card);
    else this.feedbackContent.appendChild(card);
    if (follow) this.feedbackContent.scrollTop = this.feedbackContent.scrollHeight;

    // 学习卡的地道英文同样预合成，点 🔊 即播
    if (window.tts && window.tts.prefetch) {
      window.tts.prefetch(entry.en);
    }
  }

  // ===== 跟读环 =====

  armShadow(entry, btn) {
    if (!this.isRecording) { this.showError('请先开始录制，再点跟读'); return; }
    // 武装跟读 = 用户马上要对麦克风朗读：停掉进行中的 TTS，免得尾音被当成跟读内容识别
    if (window.tts) window.tts.stop();
    // 解除上一个武装
    if (this.shadowBtn && this.shadowBtn !== btn) {
      this.shadowBtn.classList.remove('armed');
      this.shadowBtn.textContent = this.shadowBtn.dataset.done ? '🔁 再读一次' : '🎤 跟读';
    }
    this.shadowingEntry = entry;
    this.shadowBtn = btn;
    btn.classList.add('armed');
    btn.textContent = '🎙️ 请读出英文…';
  }

  async evaluateShadow(spoken) {
    const entry = this.shadowingEntry;
    const btn = this.shadowBtn;
    const card = entry._el;
    // 先解除武装，避免下一句被再次当作跟读
    this.shadowingEntry = null;
    this.shadowBtn = null;

    const diff = await window.api.diffWords(entry.en, spoken);
    const prevBest = (entry.shadow && entry.shadow.bestScore) || 0;
    entry.shadow = {
      bestScore: Math.max(prevBest, diff.score),
      lastScore: diff.score,
      attempts: ((entry.shadow && entry.shadow.attempts) || 0) + 1
    };

    if (card) {
      const diffEl = card.querySelector('.lc-diff');
      diffEl.innerHTML = diff.tokens
        .map(t => `<span class="${t.ok ? 'ok' : 'miss'}">${this.escapeHtml(t.word)}</span>`)
        .join(' ');
      const scoreEl = card.querySelector('.lc-score');
      scoreEl.textContent = `匹配度 ${diff.score}%（第 ${entry.shadow.attempts} 次，最佳 ${entry.shadow.bestScore}%）`;
      scoreEl.style.color = diff.score >= 80 ? '#69db7c' : diff.score >= 50 ? '#ffd43b' : '#ff6b6b';
      if (btn) { btn.classList.remove('armed'); btn.textContent = '🔁 再读一次'; btn.dataset.done = '1'; }
    }
  }

  disarmShadow() {
    if (this.shadowBtn) {
      this.shadowBtn.classList.remove('armed');
      this.shadowBtn.textContent = this.shadowBtn.dataset.done ? '🔁 再读一次' : '🎤 跟读';
    }
    this.shadowingEntry = null;
    this.shadowBtn = null;
  }

  updateStatsDisplay() {
    this.statFillers.textContent = this.stats.fillers;
    this.statHedges.textContent = this.stats.hedges;
    this.statVague.textContent = this.stats.vagueWords;
    if (this.stats.totalWords > 0) {
      const density = ((this.stats.totalWords - this.stats.fillers - this.stats.hedges) / this.stats.totalWords * 100).toFixed(0);
      this.statDensity.textContent = density + '%';
    }
  }

  // ===== 学习数据存档 =====

  async saveCurrentSession() {
    let session;
    if (this.mode === 'B') {
      if (this.bcards.length === 0) return;
      session = {
        mode: 'B',
        durationSec: this.stats.duration || 0,
        totalWords: this.stats.totalWords || 0,
        // 剥离 DOM 引用后存储
        cards: this.bcards.map(c => ({ zh: c.zh, en: c.en, note: c.note, tags: c.tags, shadow: c.shadow }))
      };
    } else {
      if (!this.fullText.trim() && this.corrections.length === 0) return;
      session = {
        mode: 'A',
        fullText: this.fullText,
        durationSec: this.stats.duration || 0,
        totalWords: this.stats.totalWords || 0,
        fillers: this.stats.fillers || 0,
        hedges: this.stats.hedges || 0,
        vagueWords: this.stats.vagueWords || 0,
        corrections: this.corrections
      };
    }
    try {
      await window.api.saveSession(session);
      // 新标签即时并入本地注册表，本会话后续即可复用
      const items = this.mode === 'B' ? this.bcards : this.corrections;
      items.forEach(c => (c.tags || []).forEach(t => {
        if (!this.registryTags.includes(t)) this.registryTags.push(t);
      }));
    } catch (e) {
      console.warn('saveSession failed:', e.message);
    }
  }

  // ===== 报告 =====

  async generateReport() {
    this.reportBody.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">正在生成报告...</p>';
    this.reportModal.classList.remove('hidden');

    const result = await window.api.getFinalReport({
      fullText: this.fullText,
      stats: this.stats,
      corrections: this.corrections
    });

    if (result.success) {
      this.lastReport = result.report;
      this.renderReport(result.report);
    } else {
      this.reportBody.innerHTML = `<p style="color:#ff6b6b;">生成失败: ${result.error}</p>`;
    }
  }

  renderReport(report) {
    let html = report
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\|(.+)\|/g, (match) => {
        // 简单表格支持
        return match;
      })
      .replace(/\n/g, '<br>');

    this.reportBody.innerHTML = `
      <div style="text-align:right;margin-bottom:12px;">
        <button id="btn-save-report" style="background:#E5007E;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">💾 保存为 Markdown</button>
      </div>
      ${html}
    `;

    document.getElementById('btn-save-report').addEventListener('click', () => this.saveReport());
  }

  async saveReport() {
    if (!this.lastReport) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
    const markdown = `# 表达训练报告\n\n**日期**: ${dateStr}  \n**时长**: ${this.stats.duration}秒  \n**总字数**: ${this.stats.totalWords}  \n\n---\n\n## 完整原文\n\n${this.fullText}\n\n---\n\n${this.lastReport}`;
    const filename = `表达训练-${dateStr}-${timeStr}.md`;

    try {
      const result = await window.api.saveFile(markdown, filename);
      if (result.success) {
        const btn = document.getElementById('btn-save-report');
        btn.textContent = '✓ 已保存';
        btn.style.background = '#333';
        setTimeout(() => { btn.textContent = '💾 保存为 Markdown'; btn.style.background = '#E5007E'; }, 2000);
      }
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  }

  // ===== 工具 =====

  updateTimer() {
    let totalPaused = this.pausedTime;
    if (this.pauseStart) totalPaused += Date.now() - this.pauseStart;
    const elapsed = Math.floor((Date.now() - this.startTime - totalPaused) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    this.timer.textContent = `${minutes}:${seconds}`;
  }

  resetStats() {
    this.stats = { fillers: 0, hedges: 0, vagueWords: 0, totalWords: 0, duration: 0 };
    this.corrections = [];
    this.bcards = [];
    this.sessionTags = new Set();
    this.shadowingEntry = null;
    this.shadowBtn = null;
    this.updateStatsDisplay();
    this.feedbackContent.innerHTML = '';
  }

  showError(msg) {
    const line = document.createElement('div');
    line.className = 'subtitle-line';
    line.style.color = '#ff6b6b';
    line.textContent = msg;
    this.subtitleContainer.appendChild(line);
  }

  // ===== 复制 & 保存原文 & 清空 =====

  copyOriginalText() {
    if (!this.fullText.trim()) return;
    navigator.clipboard.writeText(this.fullText).then(() => {
      this.btnCopyText.textContent = '✓ 已复制';
      setTimeout(() => { this.btnCopyText.textContent = '📋 复制'; }, 1500);
    });
  }

  async saveOriginalText() {
    if (!this.fullText.trim()) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
    const markdown = `# 表达训练原文\n\n**日期**: ${dateStr}\n\n---\n\n${this.fullText}`;
    const filename = `原文-${dateStr}-${timeStr}.md`;

    try {
      const result = await window.api.saveFile(markdown, filename);
      if (result.success) {
        this.btnSaveText.textContent = '✓ 已保存';
        setTimeout(() => { this.btnSaveText.textContent = '💾 保存'; }, 2000);
      }
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  }

  clearAll() {
    if (window.tts) window.tts.stop();   // 停掉可能仍在播放的朗读
    this.fullText = '';
    this.sentences = [];
    this.lastReport = '';
    this.subtitleContainer.innerHTML = '<div class="subtitle-line hint">点击下方按钮开始说话</div>';
    this.feedbackContent.innerHTML = '';
    this.resetStats();
    this.timer.textContent = '00:00';
    this.timer.classList.remove('active');
    this.btnReport.classList.add('hidden');
    this.btnCopyText.classList.add('hidden');
    this.btnSaveText.classList.add('hidden');
    this.btnClear.classList.add('hidden');
  }

  // ===== 粘贴逐字稿分析 =====

  openPasteModal() {
    this.pasteTextarea.value = '';
    this.pasteModal.classList.remove('hidden');
    this.pasteTextarea.focus();
  }

  async analyzePastedText() {
    const text = this.pasteTextarea.value.trim();
    if (!text) return;

    // 关闭粘贴弹窗
    this.pasteModal.classList.add('hidden');

    // 把文本显示到字幕区（高亮标记）
    this.subtitleContainer.innerHTML = '';
    this.fullText = text;
    this.resetStats();

    // 按句分句（兼容中英标点）
    const sentences = text.split(/(?<=[.!?。！？\n])/g).filter(s => s.trim());
    this.sentences = sentences;

    for (const sentence of sentences) {
      const line = document.createElement('div');
      line.className = 'subtitle-line';
      line.innerHTML = this.highlightText(sentence.trim());
      this.subtitleContainer.appendChild(line);

      // 本地词库分析（统计）
      const analysis = await window.api.analyzeText(sentence);
      if (analysis) {
        this.stats.fillers += analysis.fillers.length;
        this.stats.hedges += analysis.hedges.length;
        this.stats.vagueWords += analysis.vagueWords.length;
        this.stats.totalWords += analysis.totalWords;
      }

      // AI 按句纠错卡片
      this.requestCorrection(sentence.trim());
    }

    this.stats.duration = 0; // 粘贴模式没有时长
    this.updateStatsDisplay();

    // 显示操作按钮
    this.btnReport.classList.remove('hidden');
    this.btnCopyText.classList.remove('hidden');
    this.btnSaveText.classList.remove('hidden');
    this.btnClear.classList.remove('hidden');

    this.saveCurrentSession();   // 粘贴逐字稿也存档
  }
}

document.addEventListener('DOMContentLoaded', () => { new ExpressionTrainer(); });
