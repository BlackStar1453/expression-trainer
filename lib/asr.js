/**
 * 语音识别模块 - 基于 sherpa-onnx-node
 * 使用 streaming recognizer 实现实时语音识别
 * 录音通过 Electron 渲染进程的 Web Audio API 采集，音频数据通过 IPC 传入
 *
 * 按模式选择模型：
 *   - Mode A（说英语）→ 英文专用 streaming zipformer（transducer，encoder/decoder/joiner）
 *   - Mode B（说中文）→ 中英双语 streaming paraformer（encoder/decoder），行为与旧版一致
 */

const path = require('path');
const fs = require('fs');

let recognizer = null;
let stream = null;
let isRunning = false;
let loadedKind = null; // 当前已加载的模型种类 key（registry 的 key），null 表示未加载

const MODELS_DIR = path.join(__dirname, '..', 'models');

/**
 * 模型注册表 —— 每个 key 对应一种识别模型。
 * - kind: 'transducer'（encoder/decoder/joiner）或 'paraformer'（encoder/decoder）
 *         决定构造 sherpa modelConfig 时用哪个字段（transducer vs paraformer）
 * - subdir: models/ 下的子目录名
 * - files: 该模型实际的文件名（相对 subdir）
 */
const MODEL_REGISTRY = {
  // Mode B：中英双语 paraformer（保持旧版行为不变）
  bilingual: {
    kind: 'paraformer',
    subdir: 'sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
  // Mode A：英文专用 streaming zipformer（transducer，int8 变体）
  en: {
    kind: 'transducer',
    subdir: 'sherpa-onnx-streaming-zipformer-en-2023-06-21',
    files: {
      encoder: 'encoder-epoch-99-avg-1.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1.int8.onnx',
      joiner: 'joiner-epoch-99-avg-1.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
};

/** 应用模式（'A' | 'B'）→ 模型 key。集中在此一处映射。 */
function modeToKind(mode) {
  return mode === 'A' ? 'en' : 'bilingual';
}

/** 取得某个模型 key 的注册表条目，未知 key 抛错 */
function getEntry(modelKind) {
  const entry = MODEL_REGISTRY[modelKind];
  if (!entry) {
    throw new Error(`未知的 ASR 模型种类: ${modelKind}（可选: ${Object.keys(MODEL_REGISTRY).join(', ')}）`);
  }
  return entry;
}

/** 把注册表条目里的文件名解析成绝对路径 */
function resolvePaths(modelKind) {
  const entry = getEntry(modelKind);
  const modelDir = path.join(MODELS_DIR, entry.subdir);
  const out = { modelDir };
  for (const [role, filename] of Object.entries(entry.files)) {
    out[role] = path.join(modelDir, filename);
  }
  return out;
}

/**
 * 检查指定模型的文件是否齐全，缺文件时抛出带下载提示的清晰错误
 * @param {string} modelKind - registry key（'en' | 'bilingual'）
 */
function checkModels(modelKind) {
  const entry = getEntry(modelKind);
  const paths = resolvePaths(modelKind);

  for (const role of Object.keys(entry.files)) {
    if (!fs.existsSync(paths[role])) {
      throw new Error(
        `模型文件未找到: ${entry.files[role]}\n` +
        `请确认 models/${entry.subdir}/ 目录下有完整的模型文件。\n` +
        `英文模型（Mode A）下载见 README「下载英文识别模型 (Mode A)」章节。`
      );
    }
  }
}

/**
 * 构造 sherpa 的 modelConfig（纯函数，不触碰原生库，便于单测）
 * paraformer 与 transducer 的字段形状不同，这里按 kind 分派。
 * @param {string} modelKind - registry key（'en' | 'bilingual'）
 * @returns {object} sherpa modelConfig
 */
function buildModelConfig(modelKind) {
  const entry = getEntry(modelKind);
  const paths = resolvePaths(modelKind);

  const base = {
    tokens: paths.tokens,
    numThreads: 2,
    provider: 'cpu',
    debug: false,
  };

  if (entry.kind === 'transducer') {
    return {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      ...base,
    };
  }

  if (entry.kind === 'paraformer') {
    return {
      paraformer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
      },
      ...base,
    };
  }

  throw new Error(`不支持的模型 kind: ${entry.kind}`);
}

/**
 * 构造 OnlineRecognizer 完整配置（纯函数，便于单测）
 * featConfig 与解码参数对所有 kind 保持一致 —— Mode B 行为与旧版逐字节相同。
 * @param {string} modelKind - registry key（'en' | 'bilingual'）
 * @returns {object} OnlineRecognizerConfig
 */
function buildRecognizerConfig(modelKind) {
  return {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: buildModelConfig(modelKind),
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
  };
}

/**
 * 初始化 ASR 引擎
 * @param {string} [mode='B'] - 应用模式 'A'（英语）| 'B'（中文）
 *   兼容传入 registry key（'en' | 'bilingual'）：若传入的是已知 key 则直接使用。
 */
async function initASR(mode = 'B') {
  // 允许直接传 registry key，也允许传应用模式 'A'/'B'
  const modelKind = MODEL_REGISTRY[mode] ? mode : modeToKind(mode);

  // 同种模型已加载：走快速路径，仅重建 stream
  if (recognizer && loadedKind === modelKind) {
    stream = recognizer.createStream();
    isRunning = true;
    console.log(`[ASR] 重用已有引擎（${modelKind}），创建新 stream`);
    return;
  }

  // 先校验目标模型文件齐全，再拆旧引擎——避免目标模型缺失时把还能用的引擎也毁掉
  // （否则切到缺失模型报错后，切回原模式还得整段重新加载）
  checkModels(modelKind);

  // 切换到不同种类：释放旧引擎再重建。
  // 注意：addon 无显式 free/dispose，置空引用后原生内存（英文 encoder ~190MB）
  // 要等 GC 触发 finalizer 才归还；切换是用户手动低频操作，且每次只挂起一个旧引擎，可接受。
  if (recognizer && loadedKind !== modelKind) {
    console.log(`[ASR] 模型切换 ${loadedKind} → ${modelKind}，释放旧引擎`);
    stream = null;
    recognizer = null;
    loadedKind = null;
  }

  const sherpa = require('sherpa-onnx-node');
  const config = buildRecognizerConfig(modelKind);

  recognizer = new sherpa.OnlineRecognizer(config);
  stream = recognizer.createStream();
  isRunning = true;
  loadedKind = modelKind;

  console.log(`[ASR] 识别引擎初始化完成（${modelKind}, kind=${MODEL_REGISTRY[modelKind].kind}）`);
}

/**
 * 接收渲染进程发来的音频数据进行识别
 * @param {Float32Array} samples - 16kHz 单声道音频采样
 * @returns {{ text: string, isFinal: boolean } | null}
 */
function feedAudio(samples) {
  if (!isRunning || !stream || !recognizer) return null;

  // sherpa-onnx-node API: acceptWaveform({ samples, sampleRate })
  stream.acceptWaveform({ samples, sampleRate: 16000 });

  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }

  const result = recognizer.getResult(stream);
  const text = (result.text || '').trim();
  const isEndpoint = recognizer.isEndpoint(stream);

  if (isEndpoint && text) {
    recognizer.reset(stream);
    return { text, isFinal: true };
  } else if (text) {
    return { text, isFinal: false };
  }

  return null;
}

/**
 * 停止识别
 * @returns {string} 最后的未确认文本
 */
function stopRecognition() {
  isRunning = false;

  let finalText = '';
  if (stream && recognizer) {
    stream.inputFinished();
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
    const result = recognizer.getResult(stream);
    finalText = (result.text || '').trim();
    stream = null;
  }

  console.log('[ASR] 停止录制');
  return finalText;
}

module.exports = {
  initASR,
  feedAudio,
  stopRecognition,
  // 以下导出供测试与调用方使用
  modeToKind,
  buildModelConfig,
  buildRecognizerConfig,
  checkModels,
  MODEL_REGISTRY,
  MODELS_DIR,
};
