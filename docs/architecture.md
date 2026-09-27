# Wuchat architecture and provider analysis

## Current Wuchat code map

| Layer | Location | Responsibility |
| --- | --- | --- |
| Extension activation and VS Code registration | `src/extension.ts`, `src/extension/commands.ts` | single Wuchat Chat view, `wuchat.*` commands, provider registry, model-catalog refresh |
| Chat UI and context | `src/chat/views/WuchatChatView.ts`, `media/wuchat.js`, `media/wuchat.css` | Conversation webview with composer-level agent/model/reasoning selectors, provider setup and advanced preferences in Chat Settings, stream rendering, file/image attachment |
| Chat orchestration and persistence | `src/chat/controllers/ChatController.ts`, `src/chat/history/SessionStore.ts`, `src/chat/sessions/ChatSession.ts` | Agent routing, cancellation, session history in Wuchat `globalState` |
| Agent layer | `src/agents/Agent.ts`, `src/agents/AgentManager.ts` | Built-in agents plus workspace custom agents from `.github/agents/**/*.md`, mapped tool permissions, context preparation and bounded tool rounds |
| LLM boundary | `src/llm/ProviderRegistry.ts`, `src/llm/providers/vscodeLmProvider.ts` | Vendor-filtered adapter to `vscode.lm`, model metadata, provider reasoning options, streaming, cancellation, images, tool-call parts and network error guidance |
| Tool boundary | `src/tools/ToolRegistry.ts`, `src/tools/implementations/defaultTools.ts`, `src/vscode/workspaceBridge.ts` | Approved workspace/editor/terminal operations |

The Activity Bar, chat UI, agents, tools and history are Wuchat-owned. The only connection to the provider project is VS Code's language model API. Each Wuchat provider adapter asks for one exact vendor, so the generic model inventory does not include a Copilot provider.


## Chat controls and workspace agents

The chat composer stores the selected provider/model, agent, and reasoning effort in Wuchat settings. Model selection lists models from the registered providers; reasoning effort shows only levels supported by the active provider. `auto` omits the provider-specific option so that its own default is used.

At activation, Wuchat scans each workspace folder's `.github/agents` directory recursively for Markdown files and watches for changes. The Markdown body becomes the agent instructions; `name`, `description`, `tools`, and `user-invocable` are read from simple YAML frontmatter. Agents without a `tools` field receive read-only workspace tools. Known read/search, edit, and terminal names map to Wuchat's own tool registry; editing and terminal actions retain Wuchat's confirmation flow. Files marked `user-invocable: false` are not shown in the agent selector.

For Z.AI request failures that contain `fetch failed`, the adapter checks nested causes for safe network error codes and suggests checking DNS, proxy, VPN, or connectivity. Chat Settings delegates a connection test to the provider extension, which owns the API key and the actual HTTP request.

## `claude-for-copilot` inventory

The source directory is `/home/wendelulhoa/Documentos/codes/claude-for-copilot`. Despite its folder name, the current package is `claude-plan-copilot-chat` and registers these language model vendors:

| Vendor | Model discovery | Authentication and storage | Request/stream behavior |
| --- | --- | --- | --- |
| `claude-plan` | Authenticated Anthropic model catalog, with local Claude Sonnet/Opus fallback entries when the catalog is unavailable | Claude.ai OAuth PKCE; session saved in the provider extension's `SecretStorage` | Anthropic Messages API; bearer token, Anthropic version/beta headers and provider request identity; SSE text, thinking, tool calls and usage; image input; one token refresh retry after 401; prompt caching and configurable reasoning effort |
| `openai-codex` | Authenticated ChatGPT Codex catalog, with local fallback entries when discovery fails | ChatGPT OAuth PKCE; access/refresh tokens and account identity saved in the provider extension's `SecretStorage` | ChatGPT Codex Responses API; bearer token, account ID, originator/version/user-agent and session/thread headers; SSE text, reasoning, tools and usage; image input; one token refresh retry after 401; prompt cache and reasoning/speed options |
| `zai-glm` | Static `glm-5.3` and `glm-5.3-flash` entries | Z.AI Coding Plan API key in the provider extension's `SecretStorage` | OpenAI-compatible streaming chat completions endpoint; bearer API key; SSE text, reasoning and tool calls; image input on Flash; configurable reasoning effort |

Source locations:

- Claude: `src/provider.ts`, `src/oauth.ts`, `src/claude-request.ts`, `src/model-catalog.ts`, `src/model-options.ts`, `src/sse.ts`, `src/protocol.ts`.
- Codex: `src/codex/provider.ts`, `src/codex/oauth.ts`, `src/codex/model-catalog.ts`, `src/codex/model-options.ts`, `src/codex/sse.ts`, `src/codex/protocol.ts`.
- GLM: `src/glm-provider.ts`, `src/glm-request.ts`, `src/glm-sse.ts`, `src/glm-protocol.ts`.

The source exposes streamed usage and local usage summaries for Claude and Codex. Codex and GLM provide a rough local token-count estimate based on characters divided by four; this is not model-exact. The source has catalog fallback entries and one forced OAuth refresh on 401, but no automatic cross-provider fallback. Provider-specific reasoning, caching, endpoint and authentication code remains in the source extension and is not duplicated here.

The provider project documents Codex endpoints as private/unstable integration surfaces. Its own README lists GitHub Copilot Chat as a requirement. Wuchat consumes its models through the public `vscode.lm` interface and has no GitHub Copilot API imports, but using the existing provider extension still requires that extension to be installed and enabled. Validate that combination against the installed VS Code/provider versions before changing the source extension's published support claims.

## Dependency classification

| Category | Decision |
| --- | --- |
| **Can reuse** | VS Code's public `vscode.lm.selectChatModels`/`LanguageModelChat.sendRequest` boundary; source provider models, auth, dynamic catalogs, streaming, error handling, tools, images and provider settings; Wuchat's own agents, compact chat webview and session storage |
| **Needs adaptation** | Filter each vendor by ID and map VS Code text, data, thinking and tool-call parts into Wuchat chunks; map Wuchat tools to public tool schemas; expose Agent model overrides and Wuchat-only commands/settings; keep provider setup commands in the provider extension |
| **Needs replacement** | The generic `vscode` selector, which could surface any installed VS Code provider, is replaced by exact vendor adapters; text-fenced pseudo-tools are replaced with structured tool calls; final-only rendering is replaced by incremental stream rendering |
| **Remove from Wuchat** | GitHub authentication, Copilot subscription/token flows, Copilot endpoints, direct GitHub Copilot extension dependencies and use of Copilot-owned chat views/storage |

The optional built-in VS Code Chat participant bridge remains behind `wuchat.bridge.enableVsCodeChat=false`; it is a public VS Code adapter and does not provide Wuchat's main UI or model access.

## Credential and data ownership

Wuchat stores conversations in its extension `globalState`; its command, view and settings IDs are all namespaced `wuchat.*`. Provider credentials are created and stored only by the companion extension using its own `context.secrets`. Wuchat's connect and manage commands delegate to the source extension's existing sign-in/setup commands and never copies credentials into Wuchat settings, session JSON or local files.

Attached text and image data is read only after the user chooses files in the VS Code file picker. It is passed to the selected model request and is not persisted as file contents in session history. Text attachments and images are limited to 2 MB each.
