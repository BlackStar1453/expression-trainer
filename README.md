# 🗣️ 英语表达训练 · 本地桌面版

> Fork 自 [fxy2311-youyou/expression-trainer](https://github.com/fxy2311-youyou/expression-trainer)（原为中文口语表达训练系统），已改造为**帮助学习英语表达**的桌面应用。

一个帮你练英语口语表达的本地 Electron 应用。**一个壳，两种模式**，全程本地语音识别 + AI 分析：

| 模式 | 你做什么 | AI 做什么 |
|------|---------|-----------|
| 🅰️ **纠错** | 说**英语** | 按句指出哪里不正确 / 不地道（语法、搭配、Chinglish），给地道改写 |
| 🅱️ **中译英** | 说**中文** | 翻成地道英文 + 讲解，然后你**跟读**，本地词级比对给匹配度 |

界面中文，内容英文；暂不做发音评分。

## 功能

- 🎤 **实时语音识别**：基于 Sherpa-ONNX 中英双语模型，完全离线（Mode A 识别英语、Mode B 识别中文，同一模型）
- ✏️ **Mode A 按句纠错卡**：原句 → 地道改写 → 中文说明 → 问题标签
- 📊 **六维结课报告**：语法准确性 / 地道度 / 填充词 / 词汇丰富度 / 句式多样性 / 亮点
- 📖 **Mode B 学习卡 + 跟读环**：中文原句 → 地道英文 → 讲解 → 🎤 跟读 → 词级 diff（对绿/漏错红）+ 匹配度，自定节奏 🔁 再读一次
- 🏷️ **生长式标签**：AI 打标时优先复用历史标签，跨会话聚合
- 💾 **学习语料库**：每场自动存 `JSON + Markdown 镜像 + INDEX.md`，MD 供 AI 复习消费
- 🤖 **多 AI 后端**：**Claude 订阅（CLI，默认，无需 API Key）** / DeepSeek / OpenAI / Ollama / 自定义 OpenAI 兼容接口

## 安装

### 1. 克隆 & 安装依赖

```bash
cd expression-trainer
npm install
```

### 2. 下载语音识别模型

需要 Sherpa-ONNX 的 streaming paraformer 中英双语模型：

```bash
cd models
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
tar xvf sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
```

下载后 `models/` 应包含：

```
models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/
├── encoder.int8.onnx
├── decoder.int8.onnx
└── tokens.txt
```

### 3. 启动

```bash
npm start          # 或 npm run dev（带 DevTools）
```

### 4. 配置 AI 后端

默认用 **Claude 订阅（CLI）**——只要你本机装了 `claude`（Claude Code）并已登录，**无需任何 API Key**，开箱即用（首句约 10s 冷启动，之后每句约 2-4s，进程保温）。

想换后端就点右上角 ⚙️：填 DeepSeek / OpenAI 的 API Key，或用本地 Ollama。

> Claude 订阅模式通过常驻 `claude -p`（stream-json）子进程调用，退出应用时自动关闭。从终端 `npm start` 启动能自动找到 `claude`；若找不到可在设置里手填路径。

## 使用

**Mode A（纠错）**：点「🅰️ 纠错」→ 开始录制 → 说英语。字幕区实时高亮填充词/含糊词；右栏每说完一句弹一张纠错卡（无问题则不弹）。结束后点「生成报告」出六维报告。

**Mode B（中译英）**：点「🅱️ 中译英」→ 开始录制 → 说一句中文 → 右栏出学习卡（中文→地道英文→讲解）→ 点卡片上的「🎤 跟读」→ 把英文读出来 → 看词级匹配结果，想再练点「🔁 再读一次」，想继续直接说下一句中文。

所有卡片会自动存进 `userData/learning-data/`（JSON + MD + INDEX），方便日后复习或喂给 AI。

## 技术架构

```
┌─────────────────────────────────────────────┐
│ Electron 主进程                               │
│  ├── lib/asr.js       Sherpa-ONNX 离线识别    │
│  ├── lib/lexicon.js   英文填充/含糊词本地扫描 │
│  ├── lib/ai-feedback  纠错 / 翻译 / 报告 (多后端)│
│  ├── lib/prompts.js   各场景 prompt 模板       │
│  ├── lib/diff.js      跟读词级 LCS diff        │
│  └── lib/storage.js   学习语料库 (JSON+MD+标签)│
├─────────────────────────────────────────────┤
│ 渲染进程 (src/app.js)                          │
│  ├── 模式切换 · 全屏字幕 · 高亮                 │
│  ├── Mode A 纠错卡 · 六维报告                   │
│  └── Mode B 学习卡 · 跟读环                     │
└─────────────────────────────────────────────┘
```

术语表与设计决策见 [`CONTEXT.md`](CONTEXT.md)。

## 系统要求

- macOS 12+ / Windows 10+ / Linux ｜ Node.js 18+ ｜ 麦克风权限
- 词库分析 + 跟读 diff 可离线；纠错 / 翻译 / 报告需 AI 后端（可用本地 Ollama 彻底离线）

## License

MIT
