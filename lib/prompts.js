/**
 * Prompt 模板模块（英语表达训练）
 * - getCorrectionPrompt : Mode A 按句纠错（结构化 JSON）
 * - getReportPrompt     : Mode A 结课报告（英文六维分析，中文讲解）
 * - getRealtimePrompt   : 已废弃（旧的每 N 字实时提示），保留接口兼容旧 IPC
 */

/**
 * Mode A — batch correction prompt（issue #5 v2）.
 * 输入是一段**断续口语的 ASR 合并转写**（无标点，可能含多句），LLM 负责按语义断句后逐句纠错。
 * @param {string} utterance   merged ASR transcript of one utterance (may span sentences)
 * @param {string[]} existingTags  tags already seen this session — reuse first
 * @returns {{system: string, user: string}}
 */
function getCorrectionPrompt(utterance, existingTags = []) {
  const tagBlock = existingTags.length
    ? `\n\n已有标签（请优先从中选择，只有确实不合适时才新建标签）：\n${existingTags.join(' / ')}`
    : '';

  return {
    system: `你是英语表达教练。用户在做英语口语训练，你会收到**一段**语音识别（ASR）转写的英文口语。它是断断续续说出来的：没有标点，可能包含**一句或多句话**，也可能有口头重复、自我修正。

## 你的任务（按顺序）
1. **先按语义断句**：把这段话切成完整的句子。
2. **逐句判断**它在**语法 / 搭配 / 地道性**上是否有问题，有问题就给修正。

## 输出：严格的 JSON（不要 markdown，不要代码块，不要多余文字）
{"sentences": [
  {"original": "断出的第 1 句", "hasError": false},
  {"original": "断出的第 2 句", "hasError": true, "corrected": "修正后的地道说法", "explanation": "用中文一句话说明为什么", "tags": ["标签1", "标签2"]}
]}

## 规则
- original 必须**原样保留**用户的话（只按断句切分，不要改写）。
- explanation 用**中文**，简洁，只讲最关键的一点，不超过 40 字。
- corrected 要地道、自然，是母语者会说的版本，不是逐字直译。
- **忽略** ASR 明显的识别噪音（同音误听、缺标点、大小写），只纠真正的表达问题。
- 判断标准偏宽松：口语可以不完美，只在确实不地道 / 语法错 / 中式英语时才 hasError=true。
- 结尾若是**明显没说完的残句**，也作为一句返回但 hasError=false，不要强行纠错。
- tags 用中文，1-3 个，描述**问题类型**（如：语法-时态 / 语法-单复数 / 语法-冠词 / 介词错误 / 用词不当 / 搭配错误 / Chinglish / 句式生硬 / 冗余）。${tagBlock}
- 只输出 JSON 本身。`,

    user: `这段英文口语：\n"${utterance.trim()}"`
  };
}

/**
 * Mode A — end-of-session report.
 * @param {string} fullText
 * @param {Object} stats     { duration, totalWords, fillers, hedges, vagueWords }
 * @param {Array}  corrections  [{ original, corrected, explanation, tags }]
 * @param {Object} [customPrompt]
 */
function getReportPrompt(fullText, stats, corrections = [], customPrompt) {
  const errorSummary = corrections.length
    ? corrections.map((c, i) =>
        `${i + 1}. "${c.original}" → "${c.corrected}"` +
        `${c.explanation ? `（${c.explanation}）` : ''}` +
        `${c.tags && c.tags.length ? ` [${c.tags.join(', ')}]` : ''}`
      ).join('\n')
    : '（本场未累积到逐句纠错，请直接基于原文分析）';

  const tagCount = {};
  corrections.forEach(c => (c.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`).join('、') || '无';

  const result = {
    system: `你是英语表达教练，给一段英语口语训练做**结课报告**。用**中文**写讲解，引用的英文原句和改写保留英文（界面中文 + 英文内容）。

严格按以下 markdown 结构输出：

## 总评
一句话定位这段英语表达的整体水平 + 给一个 0-100 分。

## 六维分析
逐维给「评价 + 具体例子」，例子引用原文英文：
1. **语法准确性 (Grammar)** —— 时态 / 单复数 / 冠词 / 介词等是否准确
2. **地道度 (Naturalness)** —— 是否有 Chinglish / 生硬直译，母语者会怎么说
3. **填充词 (Fillers)** —— um / uh / like / you know 等，频率与出现场景
4. **词汇丰富度 (Vocabulary)** —— 是否总用 good / big / thing 等笼统词，可升级为哪些
5. **句式多样性 (Sentence variety)** —— 句子结构是否单一，如何变化
6. **亮点 (Strengths)** —— 说得好 / 地道的地方，引用原文肯定

## 🔧 逐句纠错汇总
把本场发现的问题整理成表格（没有就写「本场无明显问题」）：

| 原句 | 更地道的说法 | 问题 |
|------|------------|------|
| ... | ... | ... |

## 📊 数据
| 指标 | 数值 |
|------|------|
| 时长 | X 秒 |
| 词数 | X |
| 填充词 | X |
| 犹豫词 | X |
| 纠错点 | X |
| 高频问题 | ... |

## 🎯 下次练习重点
只给 1 条最关键的改进方向 + 具体怎么练（可操作，不空话）。

语气：直接、鼓励、有建设性，像一个严格但真心帮你进步的教练。`,

    user: `学习者的英语口语原文：

---
${fullText}
---

本场累积的逐句纠错：
${errorSummary}

数据：时长 ${stats.duration || 0} 秒 | 词数 ${stats.totalWords || 0} | 填充词 ${stats.fillers || 0} | 犹豫词 ${stats.hedges || 0} | 笼统词 ${stats.vagueWords || 0} | 纠错点 ${corrections.length} | 高频问题 ${topTags}`
  };

  let customBlock = '';
  if (customPrompt) {
    if (customPrompt.goals) customBlock += `\n\n## 学习者目标（报告中重点关注）\n${customPrompt.goals}`;
    if (customPrompt.styleRef) customBlock += `\n\n## 学习者想要的风格（评价以此为准）\n${customPrompt.styleRef}`;
    if (customPrompt.customWords) customBlock += `\n\n## 学习者额外口癖词（一并统计）\n${customPrompt.customWords}`;
  }
  if (customBlock) result.system += customBlock;

  return result;
}

/**
 * Mode B — batch Chinese → idiomatic English learning cards（issue #5 v2）.
 * 输入是一段断续口语的 ASR 合并中文（可能含多句），LLM 负责按语义断句，一句一卡。
 * @param {string} utterance   merged ASR Chinese transcript (may span sentences)
 * @param {string[]} existingTags  tags already seen this session — reuse first
 * @returns {{system: string, user: string}}
 */
function getTranslationPrompt(utterance, existingTags = []) {
  const tagBlock = existingTags.length
    ? `\n\n已有标签（优先复用，不合适才新建）：\n${existingTags.join(' / ')}`
    : '';

  return {
    system: `你是中译英学习教练。用户在做「说中文 → 学地道英文」训练，你会收到**一段**语音识别转写的中文口语。它是断断续续说出来的：没有标点，可能包含**一句或多句话**。

## 你的任务（按顺序）
1. **先按语义断句**：把这段话切成完整的句子。
2. **逐句**翻成**地道、自然的口语英文**，并给出简短讲解——一句一张卡。

## 输出：严格 JSON（不要 markdown，不要代码块，不要多余文字）
{"cards": [
  {"zh": "整理后的第 1 句中文", "en": "地道英文说法", "note": "中文讲解", "tags": ["标签"]},
  {"zh": "整理后的第 2 句中文", "en": "...", "note": "...", "tags": ["..."]}
]}

## 规则
- en：母语者会说的地道口语，**不是逐字直译**；如果有更自然的说法，优先用它。
- note：用**中文**，点出 1-2 个关键学习点（关键词汇 / 搭配 / 句型 / 为什么这样说），不超过 50 字。
- zh：把 ASR 的口语碎片整理成通顺的中文原句（断句后逐句整理）。
- 结尾若是明显没说完的残句，跳过它，不要强行翻译。
- tags：每卡 1-3 个中文，描述**场景或知识点**（如：场景-日常 / 场景-工作 / 句型-条件句 / 短语动词 / 时态 / 地道表达）。${tagBlock}
- 只输出 JSON 本身。`,

    user: `这段中文口语：\n"${utterance.trim()}"`
  };
}

/**
 * DEPRECATED: Mode A now uses getCorrectionPrompt for per-sentence corrections.
 * Kept only so the legacy get-realtime-feedback IPC / sendFeedback still resolve.
 */
function getRealtimePrompt(text, context, customPrompt) {
  return {
    system: `You are a real-time English speaking coach. Given the latest snippet, output at most ONE short hint (<= 6 words, in Chinese) only if there is an obvious issue (filler overuse, hesitation, or a vague word). Otherwise output an empty line. Output only the hint text, nothing else.`,
    user: `${(text || '').slice(-300)}`
  };
}

module.exports = { getRealtimePrompt, getReportPrompt, getCorrectionPrompt, getTranslationPrompt };
