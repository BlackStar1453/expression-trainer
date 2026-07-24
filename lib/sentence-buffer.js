/**
 * 定稿缓冲层（issue #5）—— 说话慢/停顿思考导致一句话被 ASR 端点拆成多段的对策。
 *
 * ASR 的 isFinal 片段不再立即定稿，而是先进缓冲：
 *   - 静默满 holdMs → 真正定稿（onCommit 合并句）→ 送 AI / 计统计
 *   - holdMs 内出现新语音（interim）→ 挂起计时，等下一个 final 合并进同一句
 * 合并判据为纯时间（两个 ASR 模型输出都无标点，标点/连接词启发式不可用）。
 *
 * 与 tts-helpers.js 同款 UMD：
 *   - Node（node:test 单测）via module.exports
 *   - 渲染进程（<script src="../lib/sentence-buffer.js">）via window.SentenceBuffer
 * 时钟通过 setTimeoutFn/clearTimeoutFn 注入，单测用 fake clock，不碰真实时间。
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SentenceBuffer = api;
  else if (typeof globalThis !== 'undefined') globalThis.SentenceBuffer = api;
})(function () {
  'use strict';

  // 「停顿容忍度」（秒）：final 进缓冲后需再静默这么久才定稿。
  // 代价是卡片比说完晚 N 秒出现——有意取舍，设置页可调。
  const PAUSE_TOLERANCE_MIN = 1;
  const PAUSE_TOLERANCE_MAX = 5;
  const DEFAULT_ASR = { pauseTolerance: 2.5 };

  function clampPauseTolerance(value) {
    // null/undefined/'' 表示「未设置」→ 回默认；不能交给 Number()（Number(null)===0 会被钳成 1）
    let v = value == null || value === '' ? NaN : Number(value);
    if (!Number.isFinite(v)) v = DEFAULT_ASR.pauseTolerance;
    return Math.min(PAUSE_TOLERANCE_MAX, Math.max(PAUSE_TOLERANCE_MIN, v));
  }

  /**
   * 把持久化 settings 解析成具体 ASR 断句配置（读 `.asr`，缺省安全）。
   * @param {object} rawSettings  get-settings 返回的完整设置（可能缺 .asr）
   * @returns {{pauseTolerance:number}}
   */
  function resolveAsrSettings(rawSettings) {
    const a = (rawSettings && typeof rawSettings === 'object' && rawSettings.asr) || {};
    return { pauseTolerance: clampPauseTolerance(a.pauseTolerance) };
  }

  /**
   * 创建一个定稿缓冲。每次开始录制建一个（joiner 按模式：'A' 英文 ' '，'B' 中文 ''）。
   * @param {object} opts
   * @param {number}   opts.holdMs        final 进缓冲后的静默定稿窗口（毫秒）
   * @param {string}   opts.joiner        片段合并连接串
   * @param {function} opts.onCommit      定稿回调，收合并后的整句文本
   * @param {function} [opts.setTimeoutFn]   注入时钟（默认全局 setTimeout）
   * @param {function} [opts.clearTimeoutFn] 注入时钟（默认全局 clearTimeout）
   */
  function createSentenceBuffer(opts) {
    const holdMs = Number(opts.holdMs) > 0 ? Number(opts.holdMs) : DEFAULT_ASR.pauseTolerance * 1000;
    const joiner = typeof opts.joiner === 'string' ? opts.joiner : ' ';
    const onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : function () {};
    const setTimeoutFn = opts.setTimeoutFn || setTimeout;
    const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;

    let segments = [];
    let timer = null;

    function clearTimer() {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    }

    function commit() {
      clearTimer();
      if (segments.length === 0) return null;
      const merged = segments.join(joiner);
      segments = [];
      onCommit(merged);
      return merged;
    }

    return {
      /** 一个 isFinal 片段进缓冲；（重新）起静默定稿计时。空文本忽略。 */
      pushFinal(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return;
        segments.push(t);
        clearTimer();
        timer = setTimeoutFn(commit, holdMs);
      },

      /**
       * 有新语音活动（非空 interim）：用户又开口了 → 挂起定稿计时，
       * 等这段话的 final 到来时（pushFinal）再重新计时。缓冲为空时 no-op。
       */
      noteActivity() {
        if (segments.length === 0) return;
        clearTimer();
      },

      /** 立即定稿（停止录制/武装跟读前清场用）。返回合并文本，空缓冲返回 null。 */
      flush() {
        return commit();
      },

      /** 丢弃缓冲不定稿（清空会话/切模式用）。 */
      cancel() {
        clearTimer();
        segments = [];
      },

      hasPending() {
        return segments.length > 0;
      },

      /** 当前缓冲里的合并文本（字幕 pending 行渲染用）。 */
      pendingText() {
        return segments.join(joiner);
      },
    };
  }

  return {
    DEFAULT_ASR,
    PAUSE_TOLERANCE_MIN,
    PAUSE_TOLERANCE_MAX,
    clampPauseTolerance,
    resolveAsrSettings,
    createSentenceBuffer,
  };
});
