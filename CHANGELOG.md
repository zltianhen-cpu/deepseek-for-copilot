# Changelog

## 0.0.24 (2026-09-20)

- Reuse the verified skill directory from the same conversation's ordinary request when preparing a host conversation summary. Match the original first message and conversation scope before applying the already-filtered text.
- Preserve the remaining history and summary replay behavior. Keep the original request when no matching in-memory snapshot exists, including immediately after a window reload.
- Add regression coverage for conversation isolation, string and text-part messages, changed instructions, and conservative fallback behavior.

## 0.0.23 (2026-09-20)

- Reduce the fixed image budget reserve from 16,384 to 4,096 tokens per image after a 29-screenshot conversation was blocked locally despite a successful nearby API request. Keep the input and output limits, original messages, and final HTTP budget check.
- Include the estimated usage, limit, overage, and image count in budget rejection errors. Add a regression test for a conversation with 29 screenshots.

## 0.0.22 (2026-09-20)

- Keep the host’s complete conversation-summary history intact when the normal Agent request was folded. Verified replay now restores missing reasoning only; it never substitutes the shorter Agent payload for the host’s 329-message summary input.
- Add a regression case for the observed 329-to-112 mismatch, retain strict conversation and history authentication, and leave cancellation and main-chat folding unchanged.

## 0.0.21 (2026-09-20)

- Preserve historical message additions across a VS Code window reload when the host supplies user content as text parts. Restore saved pin locations using the same text extraction used to create them, and persist newly assigned locations after the append succeeds.
- Keep edited messages from inheriting stale pin locations. Conversation identity and existing prefix recovery rules remain unchanged.

## 0.0.20 (2026-09-20)

- Recognize host conversation-summary requests separately from ordinary Agent turns. Preserve their historical reasoning by replaying a verified request snapshot from the same conversation, model, endpoint, and account.
- Keep summary requests from rewriting the main conversation cache. Reject changed or ambiguous history, bound the in-memory replay cache, and handle either arrival order of concurrent main and summary requests.
- Keep model, tools, thinking settings, and the appended summary instruction unchanged. If a verified snapshot is unavailable, preserve the incoming request and apply the existing budget check.

## 0.0.19 (2026-09-20)

- Keep the Mermaid diagram tool available from the first Agent request. Normalize its definition when the host omits it mid-conversation, and render its diagram in chat without relying on the host's tool enablement state.

## 0.0.18 (2026-09-18)

- Estimate request budget with weighted CJK tokens (not UTF-8 bytes) plus a 1.25 safety factor. Fold commit/restore now keeps a strictly smaller projection even when it is still over budget.
- Treat the recovery archive as a bounded cache: when it is full, evict the oldest unreferenced snapshots (referenced ones are never removed; fresh files keep a 10-minute grace window) instead of failing the fold; if archiving still fails, commit the fold anyway with the recovery reference cleared, and surface an 80% capacity warning. Previously a full archive silently discarded every fold and left oversized requests blocked.
- Validate complete main and summary requests at the HTTP boundary without trimming messages; include tools, output reserve and configured model limits.
- Split oversized summaries into bounded, atomic tool groups. Preserve host instructions and the latest user task with its complete tool loop. Retain recoverable originals before committing or restoring a folded history.
- Disable process-wide compression discounts in host token counting and restore the built-in input capacity to the installed baseline.
- Link input, filtered candidates, wire attempts and actual usage with request IDs; retain observed usage when streaming is interrupted. Add read-only diagnostics for differing request histories.
- Preserve the existing custom-model configuration and normalize missing tool parameter schemas, with dedicated regression coverage.

## 0.0.16 (2026-09-15)

- Hold the fold waterline higher so long sessions rewrite history less often: folding now triggers near ~250K actual tokens instead of ~100K, and keeps a larger recent-history tail intact for steadier prompt-cache reuse.
- Compact the fold store: per-message keys become fixed-length fingerprints, with read caching and size caps — shrinking the on-disk projections file from tens of MB to well under 1 MB per machine. Existing records migrate automatically on first load.
- Rotate the local statistics log: it now rolls over at 32MB and keeps the three most recent files, so long-running installs no longer accumulate an unbounded log file.

## 0.0.15 (2026-09-14)

- Keep the cached prefix state alive across compaction: rounds that replay pre-compaction history no longer discard the stored state, eliminating full cold reads on long-session fold turns.

## 0.0.14 (2026-09-14)

- Fold long conversations earlier: lowered the history-fold waterline so long sessions compact sooner, keeping the outgoing request prefix smaller and steadier for prompt-cache reuse.
- Debounce repeated state resets within one conversation: reset conditions firing in rapid succession (within 60 seconds) no longer discard the cached prefix state, avoiding redundant rebuilds in bursty sessions.

## 0.0.13 (2026-09-13)

- Persist per-conversation cache state across window reloads: after a reload the client restores the last stable prefix snapshot instead of rebuilding it from scratch, reducing cold-start churn on long sessions.
- Normalize persisted state keys to fixed-length identifiers so on-disk records stay portable regardless of how a conversation key is shaped.

## 0.0.12 (2026-09-13)

- Stabilize per-session state keys: the key no longer drifts when the conversation's first message grows, so long sessions keep reusing their folded state instead of dropping and re-folding it.
- Isolate parallel conversations in the same window: state keys now include a stable conversation fingerprint, so separate conversations no longer overwrite each other's cached state.
- Carry conversation identity across turns: the replay-marker channel is now exercised on every response, letting history restoration and long-session folding resolve to the correct conversation.

## 0.0.11

- Recover skill selection from validated request catalogs when the local index is missing or mismatched, preserving attachments and prior catalog bytes.
- Reject stale summary commits and merge fold storage under a short process lock.
- Add a local diagnostic viewer with request and usage correlation, explicit missing-data states, and complete bundled runtime dependency checks.

## 0.0.10 (2026-09-11)

文档与收尾版本 / Documentation and housekeeping.

### 变更 / Changed

* **商店说明写明核心目标**：README（中/英）新增「为缓存而设计」的说明 —— 目标 **99.5% 以上的 prompt-cache 缓存命中率**；「Prompt 缓存统计」条目同步重申该目标。
* **随包文件措辞清理**：包内算法文件注释中的内部措辞已中性化；功能行为与 0.0.9 完全一致。
* **更新日志补齐**：补记 0.0.9 条目（见下）——商店 Changelog 页面不再落后于实际发布版本。

## 0.0.9 (2026-09-11)

长会话折叠上线 + 前缀缓存稳定性修复版本 / Long-conversation folding and prefix-cache stability fixes.

### 新增 / Added

* **长会话自动折叠（Compaction）**：对话接近上下文水位时，较早的对话被压缩为一份「工作简报」（resume briefing）继续使用；水位以下保持原文不动 —— 模型写不出简报时就不折叠、不破坏原文。长会话不再因上下文见顶而丢历史。

### 修复 / Fixed

* **会话级前缀缓存隔离修复**：带会话身份的请求不再回退读写其它会话的缓存，避免跨会话串扰，稳住缓存命中率。
* **折叠恢复边界修复**：恢复摘要前先验证覆盖区全文；无可信会话标识时不补历史。
* **摘要请求健壮性**：有界重试（截断场景按上限再试一次）、总时长预算控制、拒绝半截摘要、失败按会话退避。
* **Token 计数口径修正**：图片编码不作文本 token 统计（本地图片估值为非计费值）。

## 0.0.4 (2026-09-10)

模型名纠错 + 图片能力口径修正版本 / Model name correction and image-capability wording fix.

### 修复 / Fixed

* **Flash 的显示名去掉版本号 `V4.1`**：服务端当前接受并回报的模型名就是 `deepseek-flash` —— 实测请求 `deepseek-flash` → 响应 `model` 字段 `deepseek-flash`；而 `deepseek-v4-flash` 是**旧名**（被路由到同一模型）。拿旧名或历史版本号当显示名 = 把历史当现状。现改为 **`DeepSeek Flash（Cache-Aware）`** / **`DeepSeek Flash (Cache-Aware)`**，共 **43 处**（模型名与 tooltip、商店副标题、README 中英、引导文档）。
* **Pro 的显示名保持不变**：`deepseek-v4-pro` 仍是服务端实际模型名（北京时间 9-14 12:00 前仍是真 V4 Pro），故保留 `DeepSeek V4 Pro（Cache-Aware）`。
* **改名尺子固化为规则**：显示名**照抄服务端返回的 `model` 字段**，不照抄我们的记忆 —— 服务端改名，我们的界面跟着改。
* **产物体检扩展「陈旧显示名」断言**：[out/i18n.js](out/i18n.js) 里出现 `V4.1` / `自研版` / `(Fork)` 任一即判不可外发（沿用 0.0.3 修的那类「陈旧编译产物静默进包」事故，这次把已废弃的版本号也纳入守门）。

* **图片能力口径修正**：原措辞「原生多模态直传 / native multimodal」容易被读成「能出图」。按官方文档客观事实（`deepseek-flash` 支持**图片输入**：描述图片、识别截图文字、分析图表）改为明确口径 —— **图片是「输入」（看图），不是「输出」（不生成图片）**。涉及模型选择器 detail/tooltip、视觉代理面板、README（中/英）、`package.json` 描述、设置项说明共 **31 处**。

## 0.0.3 (2026-09-10)

命名版本 / Naming.

### 变更 / Changed

* **模型名去掉「自研版 / (Fork)」，改为「Cache-Aware」**：旧标签只说「这是谁做的」，不说「好在哪」；且「瘦」方向的词（Slim / Lean / Lite）挂在 `Pro` 后面易被读成「缩水版」。新标签是**能力词而非减配词**，点出本扩展的核心价值 —— **只发送相关技能块（省无效 token）+ 锁定前缀（稳住缓存命中率）**。中英一致：`DeepSeek V4.1 Flash（Cache-Aware）` / `DeepSeek V4 Pro（Cache-Aware）`。
* **同一标签统一到全部界面**：命令面板标题（`DeepSeek Cache-Aware: …`）、设置项标题、引导文档、README（中/英）、Issue 模板，共 **66 处**。
* **模型供应商标签去重**：模型选择器原同时显示「DeepSeek 自研版」与「…（自研版）」，标签出现两次。现供应商标签为 `DeepSeek`，标签只出现在模型名上。
* **模型 tooltip 补上价值说明**（中英各 2 处）：说明「只发相关技能块 + 锁定前缀以稳住命中率」。
* **版本号 0.0.2 → 0.0.3**：命名变更属用户可见改动；换版本号可避免「同版本号覆盖安装」造成的“改动没生效”歧义。
* 注：本文件下方 0.0.2 条目里的旧名**保留不改** —— 变更记录是历史，不应改写。

## 0.0.2 (2026-09-10)

文档与界面文案纠错版本 / Documentation and UI text corrections.

### 修复 / Fixed

* **模型信息全面纠错**：README（中/英）、`package.json` 商店副标题、设置项说明（`visionModel` / `visionPrompt` / `debugMode`）、引导文档与 Issue 模板此前仍描述上游的 **3 个**模型（含已移除的 Flash Vision Exp），现统一为实际的两个：**DeepSeek V4.1 Flash**（原生多模态直传）与 **DeepSeek V4 Pro**（视觉代理）。
* **上下文长度更正**：文档中的 “1M Token” 改为实际值 —— **655,360 输入 / 393,216 输出** Token。
* **模型名与描述本地化修复**：`resolveModelText()` 原先按 `deepseek-v4-` 前缀截取 i18n 键，而 Flash 的模型 ID 是 `deepseek-flash`，键永远查不到、静默回落到硬编码中文 —— 英文界面下 Flash 的描述与模型名都显示为中文。现改为按**完整模型 ID** 取键，并补上模型名的本地化（英文 `(Fork)` / 中文 `（自研版）`）。
* **命令名更正**：[src/i18n.ts](src/i18n.ts)、设置项说明与引导文档中 7 处旧命令名（如 `DeepSeek: 设置 API Key`）更正为实际的 `DeepSeek 自研版: …` / `DeepSeek Fork: …`。
* **移除失效安装路径**：README 一度引导用户从 Open VSX 安装，但本扩展**并未发布到 Open VSX**（接口返回 404）。已移除该指引，改为 Marketplace 与命令行安装。
* **`modelIdOverrides` 示例更正**：示例键由 `deepseek-v4-flash` 改为实际的 `deepseek-flash`。
* **撤下过时截图，改为纯文字文档**：README 中的 3 张截图来自上游版本（画面含已移除的 Flash Vision Exp 与旧模型 ID `deepseek-v4-flash`），与当前功能不符。现把两个 README 改为**全文字说明**（同时移除版本／安装量徽章，仅保留纯文字安装链接），并删除这 3 个图片文件。它们此前无任何引用，却仍随包发布。
* **包体积精简**：`.vscodeignore` 新增排除 `resources/screenshots/**` 与 [resources/icon@512.png](resources/icon@512.png)（后者无任何引用）。配图不影响商店页显示 —— vsce 会把相对路径改写为 GitHub 直链，商店从 GitHub 取图，不必打进 `vsix`。包体积由 **606 KB（99 文件）降至 162 KB（95 文件）**，约减少 73%。

### 新增 / Added

* [tools/check-i18n-models.js](tools/check-i18n-models.js)：逐个模型 × 逐字段校验 i18n 键能否解析（防“静默回落到硬编码”），并反向检查孤儿键。已接入 `npm test`。

## 0.0.1 (2026-09-10)

首个自研发布版本 / First release under the `zltianhen` publisher.

基于 [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot) `v0.8.2`（MIT License）二次开发。
Based on upstream `v0.8.2` (MIT License).

### 与上游的差异 / Changes from upstream

* 扩展标识：`zltianhen.deepseek-for-copilot`
* 模型供应商 ID 与命令前缀独立，可与上游扩展并存安装
* 新的应用图标
* 版本号自此从 `0.0.1` 起算，与上游版本号不连续
