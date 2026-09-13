<h1 align="center">DeepSeek for Copilot Chat（Cache-Aware）</h1>

<!-- marketplace-readme:remove-start -->
<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=zltianhen.deepseek-for-copilot">从 VS Code Marketplace 安装</a>
</p>
<!-- marketplace-readme:remove-end -->

<p align="center">
  <a href="https://github.com/zltianhen-cpu/deepseek-for-copilot/blob/main/README.md">English</a> |
  简体中文
</p>

**在 Copilot Chat 模型选择器中直接使用 DeepSeek V4——无需离开你熟悉的 Copilot 工作流。**

喜欢 DeepSeek 的性价比，但不想放弃 GitHub Copilot 的 Agent 模式、工具调用和成熟的交互体验？本扩展将 **DeepSeek Flash 和 V4 Pro** 直接接入 Copilot Chat 模型选择器，支持**图片输入（看图，不生成图片）与视觉代理**、**思考模式**，并使用你自己的 API Key。

## 为什么选这个扩展？

- **不是替换 Copilot，而是增强它。** 没有新的侧边栏，没有新的聊天界面需要学习。只是在你已经在用的模型选择器中多了一个选项。
- **Agent 模式、工具调用、Instructions、MCP、Skills——全部正常运作。** Copilot 的完整能力栈，现在跑在 DeepSeek 上。
- **两种读图方式，都不生成图片。** Flash 原生接收图片附件（图片作为输入直接读）；Pro 则保留原有文本上下文，由可配置的视觉代理将图片转换为文字描述。两个模型都只能看图（描述图片、识别截图文字、分析图表），不能生成图片。
- **需自行提供 API Key，直接向 DeepSeek 付费。** 你的 API Key，你的账单，你的速率限制。密钥存储在操作系统密钥链中，不会以明文形式写入磁盘。
- **为缓存而设计——我们的目标是 99.5% 以上的缓存命中率。** DeepSeek 对缓存命中的输入 Token 收取远低于标准价的费用；本扩展让请求前缀在对话轮次之间保持稳定，从而让缓存持续命中。

## 功能特性

### 两个 DeepSeek 模型出现在模型选择器中
**DeepSeek Flash** 和 **DeepSeek V4 Pro** 会与其他模型并列出现在 Copilot Chat 的模型选择器中。两者均支持 DeepSeek 的长上下文、工具调用和可配置的思考深度。

### 图片输入（看图）与视觉代理
可以根据对话需要选择不同的读图路径：

- **DeepSeek Flash** 把图片附件作为原生输入直接处理（看图、识别截图文字、分析图表），不经过视觉代理。
- **DeepSeek V4 Pro** 使用视觉代理：先由 Flash 描述附件，再把描述连同对话内容交给 Pro。自动模式默认用 Flash 当代理，同时支持显式配置其他 VS Code 模型或 API 端点。

如果你在意 DeepSeek 前缀缓存的复用，不建议只为查看一张图片而在对话中途切换模型。需要 Flash 直接读图时，直接选 Flash；想继续用 Pro，就让视觉代理处理图片并保留主模型选择。

### 思考模式与推理深度控制
完整支持 DeepSeek V4 的 `reasoning_content`。Flash 和 Pro 均可选择 `停用`、`轻量`、`标准`（均衡，默认）或 `深度`（适用于复杂 Agent 任务），与官方 API 已实现的推理档位保持一致。

### 继承全部 Copilot 能力
由于本扩展接入的是 Copilot 的原生 provider API，你免费获得完整能力栈：
- **Agent 模式**——自主执行多步骤任务
- **工具调用**——文件编辑、终端操作、工作区搜索、Git、测试
- **Instructions & Skills**——你的 `.instructions.md`、`AGENTS.md` 和各项 Skills 开箱即用
- **Prompt 缓存统计**——实时缓存命中率（目标：99.5% 以上）记录在输出通道中，直观看到成本节省

### 安全优先
API Key 存储在 VS Code 的 `SecretStorage` 中（macOS 钥匙串 / Windows 凭据管理器 / Linux 密钥环）。绝不会出现在 `settings.json` 中，也不会被提交到 Git 历史。

### 零运行时依赖
纯 VS Code API + Node.js 内置模块。无需 Python、Docker 或本地代理进程。

## 快速开始

### 前置条件

- VS Code 1.116 及以上版本。本扩展依赖非公开的 Copilot Chat API，较新的 VS Code 版本可能存在兼容性问题——如遇到请[提交 Issue](https://github.com/zltianhen-cpu/deepseek-for-copilot/issues)。
- GitHub Copilot 订阅（Free / Pro / Enterprise——免费版即可使用）
- DeepSeek API Key，从 [platform.deepseek.com](https://platform.deepseek.com) 获取；使用自定义 `deepseek-fork.baseUrl` 时也可使用兼容的 provider token

### 安装方式

从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=zltianhen.deepseek-for-copilot) 安装，也可以直接在 VS Code 扩展面板搜索 `DeepSeek for Copilot Chat`。

或用命令行安装：

```bash
code --install-extension zltianhen.deepseek-for-copilot
```

### 使用步骤

1. 通过命令面板（`Cmd+Shift+P`）运行 **DeepSeek Cache-Aware: 设置 API Key**
2. 粘贴你的 Key 或兼容的 provider token（官方 DeepSeek Key 通常以 `sk-` 开头）
3. 打开 Copilot Chat，点击模型选择器，选择 **DeepSeek Flash（Cache-Aware）** 或 **DeepSeek V4 Pro（Cache-Aware）**
4. 搞定——开始聊天

## 模型

| 模型 | 图片输入方式（只读图，不生成图片） | 思考深度 | 适用场景 |
|---|---|---|---|
| **DeepSeek Flash（Cache-Aware）** | 直接读图（不生成图片） | `停用` / `轻量` / `标准` / `深度` | 日常快速编码、图片理解、低成本迭代 |
| **DeepSeek V4 Pro（Cache-Aware）** | 视觉代理 | `停用` / `轻量` / `标准` / `深度` | 复杂重构、Agent 任务、深度推理 |

两者均支持可选的思考模式与工具调用，上下文为 **655,360 输入 Token / 393,216 输出 Token**。

## 设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `deepseek-fork.baseUrl` | `https://api.deepseek.com` | API 端点——可改为自托管或代理部署地址 |
| `deepseek-fork.maxTokens` | `0` | 最大输出 Token 数（`0` = 不限制）。可用于成本控制 |
| `deepseek-fork.modelIdOverrides` | 预填官方 ID 映射 | 两个 DeepSeek 模型实际发送的 API 模型 ID。仅在使用模型名不同的兼容第三方 API 时需要修改 |
| `deepseek-fork.debugMode` | `minimal` | 诊断模式：`minimal` 仅上报 token 用量，`metadata` 输出隐私安全日志，`verbose` 将完整请求 dump 和 pipeline snapshot 写入扩展 global storage。完整 dump 可能包含敏感提示词文本、工具定义、文件片段和图片描述。使用 `DeepSeek Cache-Aware: 打开请求 Dump 目录` 打开 dump 位置 |
| `deepseek-fork.visionModel` | *(自动)* | Pro 使用的视觉代理（Flash 为图片直接输入，不走代理；两个模型都只读图，不生成图片）。自动模式默认用 Flash 当代理；也可通过 `DeepSeek Cache-Aware: 配置视觉代理` 改用其他 VS Code 模型或 API 端点 |
| `deepseek-fork.visionPrompt` | *(内置)* | 视觉代理用于描述图片附件的提示词，不影响 Flash 的图片直接输入。清空时回落到内置默认值 |
| `deepseek-fork.experimental.stabilizeToolList` | `false` | 实验性设置。尝试预先激活 VS Code/Copilot 的虚拟工具，让传给 DeepSeek API 的 `tools` 参数在多轮对话中更完整、更稳定。当已启用工具跨轮次变化时，可能提高上下文缓存命中率。代价是 input tokens 可能增加；缓存命中的 input tokens 单价更低，但仍会计入用量。64 个或更少已启用工具时通常无需开启，除非工具列表仍在跨轮次变化；超过 128 个已启用工具时不建议开启 |

思考深度可通过 Copilot Chat 的模型选择器对每个 DeepSeek 模型单独设置。

兼容 API 代理的 `settings.json` 配置示例：

```json
{
  "deepseek-fork.modelIdOverrides": {
    "deepseek-flash": "your-flash-model-id",
    "deepseek-v4-pro": "your-pro-model-id"
  }
}
```

## 方案对比

| | 本扩展 | 本地代理（如 LiteLLM） | 独立 DeepSeek 扩展 |
|---|---|---|---|
| 在 Copilot Chat 内使用 | ✅ | ✅ | ❌ 独立界面 |
| Agent 模式、工具、Skills | ✅ | ✅ | ⚠️ 自行实现 |
| 读图支持（图片输入） | ✅ 原生 + 代理 | ❌ | ❌ |
| 无需额外运行进程 | ✅ | ❌ | ✅ |
| 一键安装 | ✅ | ❌ | ✅ |
| API Key 存系统密钥链 | ✅ | ❌ | ⚠️ 各异 |

## 许可证

[MIT](LICENSE)
