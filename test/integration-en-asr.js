/**
 * 集成验证脚本（非单测，需已下载英文模型）：
 * 通过 lib/asr.js 的真实代码路径加载英文 zipformer（transducer）模型，
 * 喂入模型自带的 test_wavs/*.wav，打印识别结果，并与自带 transcript 对照。
 *
 * 运行： node test/integration-en-asr.js
 * 若模型缺失则打印提示并以退出码 2 退出（不算失败，供 CI 跳过）。
 */

const path = require('path');
const fs = require('fs');

const asr = require('../lib/asr');
const sherpa = require('sherpa-onnx-node');

const EN_SUBDIR = asr.MODEL_REGISTRY.en.subdir;
const modelDir = path.join(asr.MODELS_DIR, EN_SUBDIR);
const wavsDir = path.join(modelDir, 'test_wavs');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!fs.existsSync(wavsDir)) {
  fail(`[skip] 未找到 test_wavs 目录: ${wavsDir}\n请先下载英文模型（见 README「下载英文识别模型 (Mode A)」）`, 2);
}

// 读取自带 transcript（若有），做人工对照参考
let bundledTranscript = null;
const transcriptPath = path.join(modelDir, 'test_wavs', 'trans.txt');
if (fs.existsSync(transcriptPath)) {
  bundledTranscript = fs.readFileSync(transcriptPath, 'utf-8');
}

/** 通过 lib/asr.js 的真实路径识别单个 wav：initASR('A') → feedAudio → stopRecognition */
function transcribeWav(wavPath) {
  const wave = sherpa.readWave(wavPath); // { samples: Float32Array, sampleRate }
  const samples = wave.samples;

  const finals = [];
  const CHUNK = 3200; // 0.2s @16k，模拟流式喂入
  for (let i = 0; i < samples.length; i += CHUNK) {
    const chunk = samples.subarray(i, Math.min(i + CHUNK, samples.length));
    const r = asr.feedAudio(chunk);
    if (r && r.isFinal && r.text) finals.push(r.text);
  }
  const tail = asr.stopRecognition();
  if (tail) finals.push(tail);
  return { sampleRate: wave.sampleRate, text: finals.join(' ').trim() };
}

async function main() {
  const wavFiles = fs
    .readdirSync(wavsDir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .sort();

  if (wavFiles.length === 0) fail(`[skip] test_wavs 下没有 .wav 文件`, 2);

  console.log(`\n=== 英文 ASR 集成验证 (${EN_SUBDIR}) ===`);
  if (bundledTranscript) {
    console.log(`\n--- 模型自带 transcript (trans.txt) ---\n${bundledTranscript.trim()}\n`);
  } else {
    console.log('（模型未附带 trans.txt，仅打印识别结果供人工核对）\n');
  }

  for (const wav of wavFiles) {
    const wavPath = path.join(wavsDir, wav);

    // 每个文件前重新 init：同种模型走快速路径（复用引擎，重建 stream）
    // 首个文件会真正构造 transducer recognizer —— 验证 sherpa 接受 transducer 配置不抛错
    await asr.initASR('A'); // 'A' → en，覆盖 mode→kind 映射
    const { sampleRate, text } = transcribeWav(wavPath);
    console.log(`[${wav}] (sr=${sampleRate})`);
    console.log(`  → "${text}"\n`);
  }

  console.log('=== 完成：sherpa 接受了 transducer(encoder/decoder/joiner) 配置，未抛错 ===');

  // ===== 换模型状态机验证：en → bilingual → en =====
  // 覆盖 initASR 的异种拆除/重建分支（评审 finding 1：该分支此前无任何自动化覆盖）
  try {
    asr.checkModels('bilingual');
  } catch (e) {
    console.log('\n[skip] 双语模型未下载，跳过换模型状态机验证（en↔bilingual swap）');
    return;
  }

  console.log('\n=== 换模型状态机验证: en → bilingual → en ===');
  await asr.initASR('B'); // en→bilingual：真实走「拆旧引擎+重建」
  await asr.initASR('A'); // bilingual→en：再次拆除+重建
  const again = transcribeWav(path.join(wavsDir, wavFiles[0]));
  console.log(`[swap] ${wavFiles[0]} 重载后 → "${again.text}"`);
  if (!again.text || again.text.length < 10) {
    fail('换模型后英文识别结果异常（空或过短）——拆除/重建分支疑似有问题');
  }
  console.log('=== 换模型状态机验证通过：拆除/重建后英文识别仍正常 ===');
}

main().catch((e) => {
  console.error('集成验证失败:', e);
  process.exit(1);
});
