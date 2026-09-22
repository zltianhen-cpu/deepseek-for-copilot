<h1 align="center">DeepSeek for Copilot Chat (Cache-Aware)</h1>

<!-- marketplace-readme:remove-start -->
<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=zltianhen.deepseek-for-copilot">Install from VS Code Marketplace</a>
</p>
<!-- marketplace-readme:remove-end -->

<p align="center">
  English |
  <a href="https://github.com/zltianhen-cpu/deepseek-for-copilot/blob/main/README.zh-cn.md">简体中文</a>
</p>

**Pick DeepSeek V4 from the Copilot Chat model picker — and keep everything else Copilot already gives you.**

Love DeepSeek's price-performance but don't want to give up GitHub Copilot's agent mode, tool calling, and polished UI? This extension adds **DeepSeek Flash and V4 Pro** to the Copilot Chat model selector — with **image input (reads images, never generates them) and Vision Proxy**, **thinking mode**, and your own API key.

## Why this extension?

- **Don't replace Copilot — power it up.** No new sidebar, no new chat UI to learn. Just a new model in the picker you already use.
- **Agent mode, tool calling, instructions, MCP, skills — all of it still works.** Copilot's entire stack, now running on DeepSeek.
- **Two ways to read images — neither one generates images.** Flash takes image attachments directly as input. Pro keeps its existing text context while a configurable Vision Proxy turns images into descriptions. Both models only read images (describe them, read text out of screenshots, analyze charts); neither can generate images.
- **BYOK, pay DeepSeek directly.** Your API key, your bill, your rate limits. Stored in the OS keychain, never on disk.
- **Cache-aware by design — our goal is a 99.5%+ prompt-cache hit rate.** DeepSeek bills cache-hit input tokens at a fraction of the standard price; this extension keeps your request prefix stable across turns so the cache keeps hitting.

## Features

### Two DeepSeek models in the model picker
**DeepSeek Flash** and **DeepSeek V4 Pro** appear alongside other models in Copilot Chat's model selector. Both support DeepSeek's long context, tool calling, and configurable thinking effort.

### Image Input (Reading Images) and Vision Proxy
Choose the image path that fits the conversation:

- **DeepSeek Flash** takes image attachments directly as input (describe images, read text in screenshots, analyze charts), without Vision Proxy.
- **DeepSeek V4 Pro** uses Vision Proxy: Flash first describes each attachment, then Pro receives the description with the conversation. Auto mode uses Flash as the proxy by default, while an explicitly configured VS Code model or API endpoint remains supported.

Avoid switching models mid-chat just to inspect an image if DeepSeek prefix-cache reuse matters. Use Flash directly to read images, or stay on Pro and let Vision Proxy preserve the main model choice.

### Thinking Mode with Reasoning Effort Control
Full support for DeepSeek V4's `reasoning_content`. Flash and Pro offer `none` (off), `low` (light reasoning), `high` (balanced, default), and `max` (deep reasoning for hard agent tasks), matching the effort levels implemented by the official API.

### Inherits Every Copilot Capability
Because this plugs into Copilot's native provider API, you get the full stack for free:
- **Agent mode** — autonomous multi-step tasks
- **Tool calling** — file edits, terminal, workspace search, Git, tests
- **Instructions & skills** — all your `.instructions.md`, `AGENTS.md`, and skills just work
- **Prompt caching stats** — the live cache hit rate (goal: 99.5%+) is logged in the output channel, so you can see the savings

### Secure by Default
API key lives in VS Code's `SecretStorage` (OS keychain on macOS / Windows / Linux). Never in `settings.json`, never in your Git history.

### Zero Runtime Dependencies
Pure VS Code API + Node.js built-ins. No Python, no Docker, no local proxy server to babysit.

## Getting Started

### Prerequisites

- VS Code 1.116 or later. This extension relies on non-public Copilot Chat APIs that may break on newer VS Code versions — [report an issue](https://github.com/zltianhen-cpu/deepseek-for-copilot/issues) if you hit one.
- GitHub Copilot subscription (Free / Pro / Enterprise — the free tier works)
- DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com), or a compatible provider token when using a custom `deepseek-fork.baseUrl`

### Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=zltianhen.deepseek-for-copilot), or search `DeepSeek for Copilot Chat` in the VS Code Extensions view.

You can also install it from the command line:

```bash
code --install-extension zltianhen.deepseek-for-copilot
```

After installing or upgrading a local VSIX, run **Developer: Reload Window** so VS Code reloads the bundled request hooks.

### Usage

1. Run **DeepSeek Cache-Aware: Set API Key** from the Command Palette (`Cmd+Shift+P`)
2. Paste your key or compatible provider token (official DeepSeek keys usually start with `sk-`)
3. Open Copilot Chat, click the model picker, and choose **DeepSeek Flash（Cache-Aware）** or **DeepSeek V4 Pro（Cache-Aware）**
4. That's it — chat away

## Models

| Model | Image Input (reads images; never generates them) | Thinking Effort | Best For |
|---|---|---|---|
| **DeepSeek Flash（Cache-Aware）** | Image input (reads images) | `none` / `low` / `high` / `max` | Fast everyday coding, image understanding, cheap iteration |
| **DeepSeek V4 Pro（Cache-Aware）** | Vision Proxy | `none` / `low` / `high` / `max` | Complex refactors, agent tasks, deep reasoning |

Both support optional thinking mode and tool calling, with a **655,360 input token / 393,216 output token** context.

## Settings

| Setting | Default | Description |
|---|---|---|
| `deepseek-fork.baseUrl` | `https://api.deepseek.com` | API endpoint — change for self-hosted / proxied deployments |
| `deepseek-fork.maxTokens` | `0` | Max output tokens (`0` = no limit). Useful for cost control |
| `deepseek-fork.modelIdOverrides` | prefilled official ID map | API model IDs actually sent for the two DeepSeek models. Change only for compatible third-party APIs with different model names |
| `deepseek-fork.customModels` | `[]` | Extra models to expose in the model picker, for self-hosted / proxied gateways (NewAPI, Volcengine Ark, enterprise LLM gateways). Entries are appended after the built-in models in the order given; an entry whose `id` matches a built-in replaces it. Invalid entries are skipped with a warning in the DeepSeek output log, and a malformed price table is ignored rather than shown |
| `deepseek-fork.debugMode` | `minimal` | Diagnostic mode: `minimal` for token usage only, `metadata` for privacy-preserving logs, or `verbose` for full request dumps and pipeline snapshots under extension global storage. Full dumps may include sensitive prompt text, tool schemas, file snippets, and image descriptions. Use `DeepSeek Cache-Aware: Open Request Dumps Folder` to open the dump location |
| `deepseek-fork.visionModel` | *(auto)* | Vision Proxy used by Pro (Flash takes images directly as input and bypasses the proxy; neither model generates images). Auto mode uses Flash as the proxy by default; configure another VS Code model or API endpoint with `DeepSeek Cache-Aware: Configure Vision Proxy` |
| `deepseek-fork.visionPrompt` | *(built-in)* | Prompt used by the Vision Proxy to describe image attachments. It does not affect Flash's direct image input. Clearing it falls back to the built-in default |
| `deepseek-fork.experimental.stabilizeToolList` | `false` | Experimental. Tries to pre-activate VS Code/Copilot virtual tools so the DeepSeek API `tools` parameter is more complete and stable across turns. May improve context-cache hit rate when enabled tools change between turns. Can increase input tokens because more function definitions may be included; cache-hit input tokens are cheaper but still count toward usage. Usually leave it off with 64 or fewer enabled tools unless the tool list still changes across turns; do not enable it with more than 128 enabled tools |

Thinking Effort is configured from Copilot Chat's model picker for each DeepSeek model.

Example `settings.json` override for compatible API proxies:

```json
{
  "deepseek-fork.modelIdOverrides": {
    "deepseek-flash": "your-flash-model-id",
    "deepseek-v4-pro": "your-pro-model-id"
  }
}
```

Adding a model that your gateway exposes (no code change or new release needed):

```json
{
  "deepseek-fork.customModels": [
    {
      "id": "deepseek-v4-1-flash-260910",
      "name": "Volcengine DeepSeek v4.1 Flash",
      "detail": "Volcengine Ark - thinking on by default",
      "maxInputTokens": 1000000,
      "maxOutputTokens": 393216,
      "capabilities": {
        "toolCalling": true,
        "imageInput": false,
        "thinking": {
          "supportedEfforts": ["low", "high", "max"],
          "defaultEffort": "high",
          "canDisable": true
        }
      },
      "requiresThinkingParam": true
    }
  ]
}
```

Capability defaults are conservative (`toolCalling: true`, `imageInput: false`, no thinking). `pricing` is optional — omit it to show no price hint; a malformed table is ignored so a wrong price is never displayed.

## Compared to alternatives

| | This extension | Local proxy (e.g. LiteLLM) | Standalone DeepSeek extensions |
|---|---|---|---|
| Works inside Copilot Chat | ✅ | ✅ | ❌ separate UI |
| Agent mode, tools, skills | ✅ | ✅ | ⚠️ reimplemented |
| Image input (reading images) | ✅ native + proxied | ❌ | ❌ |
| No extra process to run | ✅ | ❌ | ✅ |
| One-click install | ✅ | ❌ | ✅ |
| API key in OS keychain | ✅ | ❌ | ⚠️ varies |

## License

[MIT](LICENSE)
