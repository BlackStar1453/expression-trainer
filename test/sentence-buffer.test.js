// 定稿缓冲层（issue #5）单元测试
// 纯时间判据状态机：isFinal 片段先进缓冲，静默满 holdMs 才真正定稿（onCommit）。
// 时钟通过 setTimeoutFn/clearTimeoutFn 注入，测试用手动推进的 fake clock。

const { test } = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_ASR,
  PAUSE_TOLERANCE_MIN,
  PAUSE_TOLERANCE_MAX,
  clampPauseTolerance,
  resolveAsrSettings,
  createSentenceBuffer,
} = require('../lib/sentence-buffer');

// ===== 测试用 fake clock =====

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingTimerCount: () => timers.size,
  };
}

function makeBuffer(overrides = {}) {
  const clock = fakeClock();
  const commits = [];
  const buf = createSentenceBuffer({
    holdMs: 2500,
    joiner: ' ',
    onCommit: (text) => commits.push(text),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...overrides,
  });
  return { buf, clock, commits };
}

// ===== 设置解析 =====

test('DEFAULT_ASR 默认停顿容忍度 2.5s，范围 1-5', () => {
  assert.strictEqual(DEFAULT_ASR.pauseTolerance, 2.5);
  assert.strictEqual(PAUSE_TOLERANCE_MIN, 1);
  assert.strictEqual(PAUSE_TOLERANCE_MAX, 5);
});

test('clampPauseTolerance：越界钳制、非法值回默认', () => {
  assert.strictEqual(clampPauseTolerance(0.5), 1);
  assert.strictEqual(clampPauseTolerance(10), 5);
  assert.strictEqual(clampPauseTolerance(3), 3);
  assert.strictEqual(clampPauseTolerance('3.5'), 3.5);
  assert.strictEqual(clampPauseTolerance('abc'), 2.5);
  assert.strictEqual(clampPauseTolerance(undefined), 2.5);
  assert.strictEqual(clampPauseTolerance(null), 2.5);
});

test('resolveAsrSettings：缺 asr 块 / 空对象 / 正常值', () => {
  assert.deepStrictEqual(resolveAsrSettings(undefined), { pauseTolerance: 2.5 });
  assert.deepStrictEqual(resolveAsrSettings({}), { pauseTolerance: 2.5 });
  assert.deepStrictEqual(resolveAsrSettings({ asr: {} }), { pauseTolerance: 2.5 });
  assert.deepStrictEqual(resolveAsrSettings({ asr: { pauseTolerance: 4 } }), { pauseTolerance: 4 });
  assert.deepStrictEqual(resolveAsrSettings({ asr: { pauseTolerance: 99 } }), { pauseTolerance: 5 });
});

// ===== 基本定稿 =====

test('单个 final：静默满 holdMs 后原文定稿一次', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('i went to the store');
  assert.strictEqual(commits.length, 0, '进缓冲不立即定稿');
  clock.tick(2400);
  assert.strictEqual(commits.length, 0, '未满 holdMs 不定稿');
  clock.tick(100);
  assert.deepStrictEqual(commits, ['i went to the store']);
});

test('窗口内两个 final 合并为一句（英文空格 join）', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('i went to the store');
  clock.tick(1000);
  buf.pushFinal('and bought some milk');
  clock.tick(2500);
  assert.deepStrictEqual(commits, ['i went to the store and bought some milk']);
});

test('中文 joiner 为空串直接拼接', () => {
  const { buf, clock, commits } = makeBuffer({ joiner: '' });
  buf.pushFinal('我昨天');
  clock.tick(1000);
  buf.pushFinal('去了超市');
  clock.tick(2500);
  assert.deepStrictEqual(commits, ['我昨天去了超市']);
});

test('三段合并：每个新 final 都重置静默计时', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('a');
  clock.tick(2000);
  buf.pushFinal('b');
  clock.tick(2000);
  buf.pushFinal('c');
  assert.strictEqual(commits.length, 0);
  clock.tick(2500);
  assert.deepStrictEqual(commits, ['a b c']);
});

// ===== 语音活动挂起计时 =====

test('noteActivity 取消进行中的定稿计时，等下一个 final 重新计时', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('i was thinking');
  clock.tick(2000);
  buf.noteActivity();          // 用户在 2s 时又开口（interim 出现）
  clock.tick(3000);            // 远超 holdMs 也不定稿——在等下一个 final
  assert.strictEqual(commits.length, 0);
  buf.pushFinal('about the plan');
  clock.tick(2500);
  assert.deepStrictEqual(commits, ['i was thinking about the plan']);
});

test('缓冲为空时 noteActivity 是 no-op', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.noteActivity();
  clock.tick(10000);
  assert.strictEqual(commits.length, 0);
});

// ===== flush / cancel =====

test('flush 立即定稿并返回合并文本，取消挂起计时', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('hello');
  buf.pushFinal('world');
  const merged = buf.flush();
  assert.strictEqual(merged, 'hello world');
  assert.deepStrictEqual(commits, ['hello world']);
  clock.tick(5000);
  assert.deepStrictEqual(commits, ['hello world'], 'flush 后计时器不再触发');
});

test('空缓冲 flush 返回 null 且不触发 onCommit', () => {
  const { buf, commits } = makeBuffer();
  assert.strictEqual(buf.flush(), null);
  assert.strictEqual(commits.length, 0);
});

test('cancel 丢弃缓冲不定稿', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('discard me');
  buf.cancel();
  clock.tick(5000);
  assert.strictEqual(commits.length, 0);
  assert.strictEqual(buf.hasPending(), false);
});

// ===== 状态与复用 =====

test('定稿后缓冲清空，下一个 final 是新句子', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('first sentence');
  clock.tick(2500);
  buf.pushFinal('second sentence');
  clock.tick(2500);
  assert.deepStrictEqual(commits, ['first sentence', 'second sentence']);
});

test('pushFinal 忽略空/全空白文本', () => {
  const { buf, clock, commits } = makeBuffer();
  buf.pushFinal('');
  buf.pushFinal('   ');
  clock.tick(5000);
  assert.strictEqual(commits.length, 0);
  assert.strictEqual(buf.hasPending(), false);
});

test('hasPending / pendingText 反映缓冲状态', () => {
  const { buf, clock } = makeBuffer();
  assert.strictEqual(buf.hasPending(), false);
  assert.strictEqual(buf.pendingText(), '');
  buf.pushFinal('hello');
  buf.pushFinal('world');
  assert.strictEqual(buf.hasPending(), true);
  assert.strictEqual(buf.pendingText(), 'hello world');
  clock.tick(2500);
  assert.strictEqual(buf.hasPending(), false);
  assert.strictEqual(buf.pendingText(), '');
});
