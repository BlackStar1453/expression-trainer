# CONTEXT — 英语表达训练

> 本项目由中文口语表达训练系统（fork 自 fxy2311-youyou/expression-trainer）改造而来，
> 目标是**帮助学习英语表达**。本文件记录术语表与关键决策，供后续 session 快速恢复上下文。

## 产品形态：一个壳，两种模式

| 模式 | 用户做什么 | ASR 识别 | AI 干什么 | 状态 |
|---|---|---|---|---|
| **Mode A · 表达纠错** | 说**英语** | 英语→文字 | 指出哪里不正确 / 不地道（语法、搭配、Chinglish） | ✅ 已完成（切片 1-3） |
| **Mode B · 中译英学习** | 说**中文** | 中文→文字 | 翻译成**地道英文** + 讲解 + **跟读**练习 | ✅ 已完成（切片 5-6） |

- 界面语言：**中文界面 + 英文内容**
- **暂不做发音评分**（sherpa-onnx 只做 ASR，不做发音打分）

## 术语表（Ubiquitous Language）

- **Mode A / Mode B**：见上表。一个应用内的两条流程，靠模式切换 UI 区分。
- **纠错卡片（correction card）**：Mode A 里每说完一句，AI 返回的「原句(标错) → 修正句 → 一句话中文说明」；整句无误则显示 ✓ 不出卡片。
- **学习卡片（learning card）**：Mode B 里每说完一句中文，AI 返回的「中文原句 → 地道英文 → 关键表达讲解」。
- **跟读环（shadowing loop）**：Mode B 出卡片后，用户把英文读出来 → ASR 识别 → 本地**词级 diff**（读对=绿/漏错=红 + 匹配度%）→ 自定节奏（「🔁 再读一次」「➡️ 下一句」，不设过关阈值）。
- **本地词库层（local lexicon）**：`lib/lexicon.js` + `data/english-lexicon.json`，离线扫描英文填充词/犹豫词/笼统词，零延迟高亮 + 统计。与 AI 层互补。
- **学习语料库（learning corpus）**：每场会话产出的结构化学习数据，**JSON + Markdown 双存**（MD 供 AI 复习消费）+ `INDEX.md` 总索引。（切片 4）
- **生长式标签（growing tags）**：AI 在纠错/翻译同一次调用里给卡片打标；维护 `tags.json` 注册表，prompt 注入已有标签，**优先复用、不合适才新增**。（切片 4）

## 关键决策

1. **先做 Mode A**（和原项目最对称，最快跑通验证；ASR 英文识别准确度是前置风险，早测）。
2. Mode A 纠错**按句触发**（复用 ASR 的 `isFinal` 端点检测）+ 结束后整体报告。
3. Mode A 报告 6 维：语法准确性 / 地道度 / 填充词 / 词汇丰富度 / 句式多样性 / 亮点。
4. Chinglish 检测全交 AI prompt，不做本地硬编码错误表。
5. Mode B **跟读进 v1**（重点是让用户读出来）；跟读比对用**本地词级 diff**，不逐次调 AI。
6. ASR **复用现有 `paraformer-bilingual-zh-en` 双语模型**：Mode A 识别英语、Mode B 识别中文，同一模型全覆盖，不换。
   - ⚠️ 已知风险：双语模型英文识别若不够准 → Mode A 纠错会基于错误文本。切片 1 完成后尽早实测，不行再给 Mode A 换英文专用模型。
7. Git：在 fork（`BlackStar1453/expression-trainer`）的 `feat/english-mode` 分支开发，切片自动 commit，push 前问用户。

## 切片计划（全部完成 ✅）

1. ✅ **骨架切换**：开分支、改名、拆中文情绪词库、`lexicon.js` 三表英语化 → Mode A 本地高亮。
2. ✅ **A-纠错卡**：按句调 AI + 结构化返回（含标签）+ 卡片 UI。
3. ✅ **A-报告**：英文 6 维报告 prompt（基于纠错记录）。
4. ✅ **数据层**：`lib/storage.js` — JSON + MD + INDEX + 生长式标签注册表。
5. ✅ **B-翻译卡**：模式切换 UI + 中→英学习卡（`getTranslationPrompt`）。
6. ✅ **B-跟读环**：跟读状态机 + `lib/diff.js` 词级 LCS diff。
7. ✅ **打磨**：清理废弃中文实时反馈代码、更新 README。

**测试**：纯逻辑全部 Node 单测覆盖，65/65 绿 —— lexicon 16 · correction 10 · storage 17 · translation 10 · diff 12。
**未做**：真机 Electron 端到端（需下 200MB ASR 模型）。

## 已知技术债

- `src/app.js` 的 `highlightText` 英文词表**硬编码**，和 `data/english-lexicon.json` 重复。应通过 IPC `get-lexicon` 统一为单一来源（`lib/lexicon.js` 已导出 `getLexicon()` 备用）。
- 本地高亮是纯字符串匹配，会误报正常用法的 "like/actually" 等。精准判断交给 Mode A 的 AI 层（切片 2）。

## 跑起来的前提

- `npm install`
- 下载 ASR 模型到 `models/`（约 200MB，`git` 里只有占位）：见 README「下载语音识别模型」。
- `npm start`
