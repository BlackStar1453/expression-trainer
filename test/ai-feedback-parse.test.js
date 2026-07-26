// 批次纠错/翻译解析层（issue #5 v2：LLM 断句、一句一卡）
// 输入是「无标点断续口语合并段」，LLM 负责语义断句并返回数组；
// 解析层要容错：code fence / 前后闲话 / 旧版单对象 / 裸数组 / 畸形输出。

const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseCorrectionBatchResponse,
  parseTranslationBatchResponse,
} = require('../lib/ai-feedback');

// ===== Mode A 纠错批次 =====

test('纠错：标准 sentences 数组（混合有错/无错）', () => {
  const raw = JSON.stringify({
    sentences: [
      { original: 'i went to the store', hasError: false },
      { original: 'i buyed some milk', hasError: true, corrected: 'I bought some milk', explanation: 'buy 过去式是 bought', tags: ['语法-时态'] },
    ],
  });
  const out = parseCorrectionBatchResponse(raw, 'fallback');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].hasError, false);
  assert.strictEqual(out[1].hasError, true);
  assert.strictEqual(out[1].corrected, 'I bought some milk');
  assert.deepStrictEqual(out[1].tags, ['语法-时态']);
});

test('纠错：容忍 ```json fence 和前后闲话', () => {
  const raw = '好的，以下是结果：\n```json\n{"sentences":[{"original":"a","hasError":false}]}\n```\n希望有帮助';
  const out = parseCorrectionBatchResponse(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hasError, false);
});

test('纠错：裸数组输出也接受', () => {
  const raw = '[{"original":"x","hasError":true,"corrected":"y","explanation":"z"}]';
  const out = parseCorrectionBatchResponse(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].corrected, 'y');
});

test('纠错：旧版单对象 hasError=true 包装成单元素数组，original 缺省用 fallback', () => {
  const raw = '{"hasError":true,"corrected":"I bought milk","explanation":"时态"}';
  const out = parseCorrectionBatchResponse(raw, 'i buyed milk');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hasError, true);
  assert.strictEqual(out[0].original, 'i buyed milk');
});

test('纠错：旧版单对象 hasError=false → 单元素无错数组', () => {
  const out = parseCorrectionBatchResponse('{"hasError":false}', 'whole utterance');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hasError, false);
});

test('纠错：hasError=true 但 corrected 为空 → 降级为无错（没有可展示的修正）', () => {
  const raw = '{"sentences":[{"original":"a","hasError":true,"corrected":""}]}';
  const out = parseCorrectionBatchResponse(raw);
  assert.strictEqual(out[0].hasError, false);
});

test('纠错：空 sentences 数组 → 空数组（全部干净，不是失败）', () => {
  const out = parseCorrectionBatchResponse('{"sentences":[]}');
  assert.deepStrictEqual(out, []);
});

test('纠错：畸形/无 JSON → null（调用方按失败处理）', () => {
  assert.strictEqual(parseCorrectionBatchResponse('模型宕机了没有 JSON'), null);
  assert.strictEqual(parseCorrectionBatchResponse(''), null);
  assert.strictEqual(parseCorrectionBatchResponse(null), null);
  assert.strictEqual(parseCorrectionBatchResponse('{"foo": 1}'), null);
});

test('纠错：tags 清洗——去空、转字符串、最多 3 个', () => {
  const raw = '{"sentences":[{"original":"a","hasError":true,"corrected":"b","tags":["一"," ","二","三","四"]}]}';
  const out = parseCorrectionBatchResponse(raw);
  assert.deepStrictEqual(out[0].tags, ['一', '二', '三']);
});

// ===== Mode B 翻译批次 =====

test('翻译：标准 cards 数组', () => {
  const raw = JSON.stringify({
    cards: [
      { zh: '我昨天去了超市', en: 'I went to the supermarket yesterday', note: '注意时态', tags: ['场景-日常'] },
      { zh: '买了一些牛奶', en: 'I picked up some milk', note: 'pick up 更口语', tags: ['短语动词'] },
    ],
  });
  const out = parseTranslationBatchResponse(raw, 'fallback');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].en, 'I picked up some milk');
});

test('翻译：旧版单对象包装成数组，zh 缺省用 fallback', () => {
  const raw = '{"en":"Hello there","note":"打招呼"}';
  const out = parseTranslationBatchResponse(raw, '你好啊');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].zh, '你好啊');
  assert.strictEqual(out[0].en, 'Hello there');
});

test('翻译：缺 en 的卡被丢弃；全部无 en → null', () => {
  const mixed = '{"cards":[{"zh":"甲","en":"A"},{"zh":"乙","en":""}]}';
  const out = parseTranslationBatchResponse(mixed);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].zh, '甲');
  assert.strictEqual(parseTranslationBatchResponse('{"cards":[{"zh":"乙","en":""}]}'), null);
});

test('翻译：容忍 fence；畸形 → null', () => {
  const out = parseTranslationBatchResponse('```json\n{"cards":[{"zh":"a","en":"b"}]}\n```');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(parseTranslationBatchResponse('乱七八糟'), null);
});
