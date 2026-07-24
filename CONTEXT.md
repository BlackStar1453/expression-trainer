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
6. ~~ASR 复用现有 `paraformer-bilingual-zh-en` 双语模型~~ **已被 issue #2 取代（2026-07-24）**：真机实测证实双语模型英文识别毛糙，Mode A 已换**英文专用 streaming zipformer**（`sherpa-onnx-streaming-zipformer-en-2023-06-21` int8，transducer）。**按模式选模型**：`initASR(mode)`，'A'→en、'B'→bilingual，切换时按需 reload（同种复用/异种拆建，`lib/asr.js` 模型注册表）。Mode B 行为逐字节不变。
7. Git：在 fork（`BlackStar1453/expression-trainer`）的 `feat/english-mode` 分支开发，切片自动 commit，push 前问用户。

## 切片计划（全部完成 ✅）

1. ✅ **骨架切换**：开分支、改名、拆中文情绪词库、`lexicon.js` 三表英语化 → Mode A 本地高亮。
2. ✅ **A-纠错卡**：按句调 AI + 结构化返回（含标签）+ 卡片 UI。
3. ✅ **A-报告**：英文 6 维报告 prompt（基于纠错记录）。
4. ✅ **数据层**：`lib/storage.js` — JSON + MD + INDEX + 生长式标签注册表。
5. ✅ **B-翻译卡**：模式切换 UI + 中→英学习卡（`getTranslationPrompt`）。
6. ✅ **B-跟读环**：跟读状态机 + `lib/diff.js` 词级 LCS diff。
7. ✅ **打磨**：清理废弃中文实时反馈代码、更新 README。
8. ✅ **Claude 订阅 provider（CLI）**：用 `claude -p` 常驻子进程免 key 调用，设为默认。

**测试（更正 2026-07-24）**：切片 1-8 时代声称的测试套件（lexicon 16 · correction 10 …）**从未提交进 git**（所有分支历史均无测试文件），系当时会话记录失实。现有真实套件从 issues #2/#3 起 bootstrap：`npm test` = `node --test test/*.test.js`，**asr 9 + tts 19 = 28 全绿**；另有 `test/integration-en-asr.js`（需模型，真加载转写 + en↔bilingual 换模型验证）与 `scripts/tts-edge-check.js`（需联网，Edge 合成检查），二者故意不进 `npm test`。
**已验证真机**：英文 zipformer 真加载 + test_wavs 转写逐字正确（16k）；en↔bilingual 换模型拆建后识别正常；claude 订阅 provider 冷 7.7s→暖 3.0s，纠错/翻译结构化输出正确。

## Issues #2 + #3（2026-07-24 完成，均经独立 agent 评审）

- **#2 Mode A 英文专用 ASR**（`feat/asr-en-model`，5 slices）：见「关键决策」6。模型下载：GitHub 整包 tarball 在受限网络下反复截断，**改从 HuggingFace 单抓 int8 三件套更稳**（encoder 188MB + decoder 527KB + joiner 253KB）。评审反馈已落地：checkModels 前置（缺模型不毁旧引擎）、换模型分支补集成覆盖、原生内存滞留（addon 无 free，~190MB 等 GC）已注释说明。
- **#3 TTS 朗读**（`feat/tts-speak`，6 slices）：纠错卡（修正句）与学习卡（英文句）加 🔊，统一 `window.tts.speak()`。双引擎：**webspeech 默认**（离线零依赖）/ **edge 可选**（`msedge-tts` 2.0.7 免 key，主进程 `lib/tts.js` 合成 mp3 data URL，失败自动回退本地语音 + 轻提示——适配受限网络）。设置页配引擎/语音/语速（0.5-2.0x，两引擎同语义）+ **🔊 试听按钮**（按当前表单值即点即听）。评审反馈已落地：**SSML XML 转义**（含 & / < 的句子不再被 Edge 拒绝且误报网络问题）、语音未加载完不覆盖已存选择、武装跟读先停 TTS（尾音不混进跟读识别）。共享纯函数在 `lib/tts-helpers.js`（UMD，node+渲染两用）。

## 合并后打磨（2026-07-24 下午，验收驱动的 7 个 commit）

> 主线：**把所有可预付的等待移出用户路径**。用户网络到微软/Anthropic 的握手都极慢（实测 5-17s），策略统一为「连接/进程常驻 + 提前预热 + 等待可见化」。

- **Edge TTS 三层提速**（`lib/tts.js` 重写）：① **连接常驻复用**——建连 ~7.4s 是大头，活连接单句仅 1-2s，缓存连接跨调用复用，闲置被断则自动重连重试一次（真离线不重试，快速回退）；② **卡片预合成**——卡片一渲染就后台合成进渲染层缓存（`src/tts.js`，Map 上限 120、在途去重），点 🔊 即点即播；③ **预热**——应用启动/设置变更/开始录制时提前建连（`tts-warmup` IPC）。合成超时用**流停滞检测**（5s 无数据判死 + 30s 硬上限）而非总时长；主进程合成**串行队列**防同连接并发干扰。🔊 按钮合成期间圆圈 loading。
- **LLM 同款处理**（`lib/claude-cli.js`）：`warmup()`（spawn + 微型 ping，启动/设置变更/开始录制三时机，`main.js warmClaudeIfActive`）；**闲时回收**取代懒回收（响应完且队列空时换进程并预热新进程，用户无感）；软阈值 **20→10**（实测 stream-json 会话轮次越多单轮越慢——每轮携带全部历史），硬上限 20 兜底。**边界**：单轮耗时地板 = 网络到 Anthropic 的往返（当前时段实测 6-14s，无法客户端优化；网络好时 ~3s）。
- **LLM 等待占位卡**（`src/app.js`）：句子送出即插「转圈+原句」占位卡，返回后原位收尾——有错换真卡 / 整句地道变「✓ 这句很地道」淡出（补上设计有但从未实现的 ✓ 反馈）/ 失败「⚠️ 已跳过」淡出；会话清空后迟到结果直接丢弃（顺带修掉迟到复活隐患）。
- **待办**：issue #4（卡片顺序应与字幕一致，新卡在下）、#5（断句：说话慢被 1.2s 停顿拆句，半句纠错无意义；建议定稿缓冲层+可调停顿容忍度）。

## AI 后端：Claude 订阅（CLI）—— slice 8

- **动机**：用用户现成的 Claude 订阅，免填 API Key。
- **实现**：`lib/claude-cli.js` 维护**一个常驻** `claude -p --input-format stream-json --output-format stream-json --verbose` 子进程；stdin 逐行发 `{"type":"user",...}`，读到 `{"type":"result",...}` 即一轮完成。请求经队列**串行**（stream-json 一次一轮）。
- **保温**：常驻进程避免每次 ~10s 冷启动 → 后续每句 ~2-4s（网络好时；见「合并后打磨」的边界说明）。软阈值 10 次**闲时回收+预热**以限制上下文膨胀（硬上限 20 兜底）；进程死了自动重启；启动/设置变更/开始录制时 `warmup()` 预热。
- **路由**：`ai-feedback.js` 的 `callModel(settings, messages, maxTokens)` 按 `settings.provider` 分流：`claude-cli` 走子进程，其余走 OpenAI 兼容 HTTP。解析层（parseCorrection/parseTranslation）provider 无关，已容错 code-fence/prose。
- **系统提示**：因常驻进程共享一个会话，任务指令（纠错 vs 翻译）**拼进每条 user 消息**，不用 `--system-prompt`。
- **默认**：新装默认 `provider='claude-cli'`, model `sonnet`；设置页可切 sonnet/opus/haiku、可手填 `binPath`。
- **二进制路径**：Finder 启动不继承 shell PATH → `resolveBin` 依次探 `~/.local/bin/claude` 等，兜底 PATH，设置可覆盖。
- **生命周期**：`app.before-quit` 调 `claudeCli.shutdown()` 杀子进程。
- **已知局限**：串行队列下突发多句会排队；`claude -p` 首句仍有冷启动；依赖本机已登录 Claude Code。

## 已知技术债

- `src/app.js` 的 `highlightText` 英文词表**硬编码**，和 `data/english-lexicon.json` 重复。应通过 IPC `get-lexicon` 统一为单一来源（`lib/lexicon.js` 已导出 `getLexicon()` 备用）。
- 本地高亮是纯字符串匹配，会误报正常用法的 "like/actually" 等。精准判断交给 Mode A 的 AI 层（切片 2）。

## 跑起来的前提

- `npm install`
- 下载 ASR 模型到 `models/`（约 200MB，`git` 里只有占位）：见 README「下载语音识别模型」。
- `npm start`
