/**
 * lib/asr.js 纯配置构造逻辑的单元测试（不加载原生库、不需要模型文件）
 * 运行： node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const asr = require('../lib/asr');

test('modeToKind: A→en, B→bilingual, 其它→bilingual', () => {
  assert.equal(asr.modeToKind('A'), 'en');
  assert.equal(asr.modeToKind('B'), 'bilingual');
  // 默认（未知/空）落到 bilingual，保持 Mode B 兜底行为
  assert.equal(asr.modeToKind(undefined), 'bilingual');
  assert.equal(asr.modeToKind('X'), 'bilingual');
});

test('buildModelConfig(en): transducer 形状（encoder/decoder/joiner），无 paraformer', () => {
  const cfg = asr.buildModelConfig('en');

  // transducer 分支：三个模型文件
  assert.ok(cfg.transducer, 'en 应使用 transducer 字段');
  assert.equal(typeof cfg.transducer.encoder, 'string');
  assert.equal(typeof cfg.transducer.decoder, 'string');
  assert.equal(typeof cfg.transducer.joiner, 'string');

  // 不应出现 paraformer 字段
  assert.equal(cfg.paraformer, undefined, 'en 不应有 paraformer 字段');

  // 通用字段
  assert.equal(typeof cfg.tokens, 'string');
  assert.equal(cfg.numThreads, 2);
  assert.equal(cfg.provider, 'cpu');
  assert.equal(cfg.debug, false);
});

test('buildModelConfig(en): 路径为绝对路径且指向正确文件名', () => {
  const cfg = asr.buildModelConfig('en');
  const subdir = 'sherpa-onnx-streaming-zipformer-en-2023-06-21';

  assert.ok(path.isAbsolute(cfg.transducer.encoder));
  assert.ok(path.isAbsolute(cfg.transducer.decoder));
  assert.ok(path.isAbsolute(cfg.transducer.joiner));
  assert.ok(path.isAbsolute(cfg.tokens));

  assert.equal(path.basename(cfg.transducer.encoder), 'encoder-epoch-99-avg-1.int8.onnx');
  assert.equal(path.basename(cfg.transducer.decoder), 'decoder-epoch-99-avg-1.int8.onnx');
  assert.equal(path.basename(cfg.transducer.joiner), 'joiner-epoch-99-avg-1.int8.onnx');
  assert.equal(path.basename(cfg.tokens), 'tokens.txt');

  // 目录部分应落在 models/<subdir>/ 下
  assert.equal(path.basename(path.dirname(cfg.transducer.encoder)), subdir);
});

test('buildModelConfig(bilingual): paraformer 形状（encoder/decoder），无 transducer/joiner', () => {
  const cfg = asr.buildModelConfig('bilingual');

  assert.ok(cfg.paraformer, 'bilingual 应使用 paraformer 字段');
  assert.equal(typeof cfg.paraformer.encoder, 'string');
  assert.equal(typeof cfg.paraformer.decoder, 'string');
  assert.equal(cfg.paraformer.joiner, undefined, 'paraformer 无 joiner');

  assert.equal(cfg.transducer, undefined, 'bilingual 不应有 transducer 字段');

  assert.equal(path.basename(cfg.paraformer.encoder), 'encoder.int8.onnx');
  assert.equal(path.basename(cfg.paraformer.decoder), 'decoder.int8.onnx');
  assert.equal(path.basename(cfg.tokens), 'tokens.txt');
  assert.equal(
    path.basename(path.dirname(cfg.paraformer.encoder)),
    'sherpa-onnx-streaming-paraformer-bilingual-zh-en'
  );
});

test('buildRecognizerConfig(bilingual): 与旧版解码参数逐字节一致', () => {
  const cfg = asr.buildRecognizerConfig('bilingual');

  assert.deepEqual(cfg.featConfig, { sampleRate: 16000, featureDim: 80 });
  assert.equal(cfg.decodingMethod, 'greedy_search');
  assert.equal(cfg.maxActivePaths, 4);
  assert.equal(cfg.enableEndpoint, true);
  assert.equal(cfg.rule1MinTrailingSilence, 2.4);
  assert.equal(cfg.rule2MinTrailingSilence, 1.2);
  assert.equal(cfg.rule3MinUtteranceLength, 20);

  // modelConfig 仍是 paraformer 形状
  assert.ok(cfg.modelConfig.paraformer);
  assert.equal(cfg.modelConfig.transducer, undefined);
});

test('buildRecognizerConfig(en): 相同 featConfig/解码参数 + transducer modelConfig', () => {
  const cfg = asr.buildRecognizerConfig('en');

  assert.deepEqual(cfg.featConfig, { sampleRate: 16000, featureDim: 80 });
  assert.equal(cfg.decodingMethod, 'greedy_search');
  assert.ok(cfg.modelConfig.transducer);
  assert.equal(cfg.modelConfig.paraformer, undefined);
});

test('未知 modelKind 抛清晰错误', () => {
  assert.throws(() => asr.buildModelConfig('nope'), /未知的 ASR 模型种类/);
});

test('MODEL_REGISTRY: 两个 key，kind 正确', () => {
  assert.equal(asr.MODEL_REGISTRY.en.kind, 'transducer');
  assert.equal(asr.MODEL_REGISTRY.bilingual.kind, 'paraformer');
});
