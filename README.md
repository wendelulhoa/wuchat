# Wuchat

Wuchat is a compact, independent chat experience inside VS Code. The chat composer keeps agent, model, and thinking-effort controls next to the message box. Provider sign-in, API key management, connection tests, and advanced preferences live in **Chat Settings**.

## Connect a provider

Open Wuchat and click **Connect an AI provider**, or open the gear menu and choose **Connect or switch provider**. Wuchat starts the provider's own sign-in flow:

- Claude Plan opens Claude.ai sign-in.
- ChatGPT Codex opens ChatGPT sign-in.
- Z.AI GLM asks for an API key in a protected input field.

The provider extension stores credentials in VS Code SecretStorage. Wuchat does not copy or read those credentials. Install and enable the companion provider extension to use these providers. Wuchat also includes an offline Echo provider for basic local checks.

## Chat settings

The gear menu gives quick access to provider sign-in or API key management, a connection test, the default agent, and advanced Wuchat preferences. Choose the agent, model, and thinking effort directly in the composer. Custom agents in the workspace `.github/agents` folder are discovered automatically. Conversation history opens from the clock button at the top of the chat. When a provider reports `fetch failed`, Wuchat shows network guidance and offers a connection test.

## Build and install

Run `npm run build` or `npm run vsix` to create a VSIX. Each packaging build increments the patch version in `package.json` and `package-lock.json`, then creates a uniquely named artifact in `dist/`, such as `wuchat-0.2.5.vsix`. Use `npm run compile` for a local compile without changing the release version.

Install the generated VSIX with **Extensions: Install from VSIX…** in VS Code.

## Standalone CLI

Run `npm run install-local` and choose **Standalone CLI** to install `wuchat` in `~/.local/bin`, or choose the VS Code extension option to build and install a local VSIX. Node.js 20 or later is required.

By default, the CLI uses the provider and model currently selected in Wuchat through an authenticated loopback bridge. Keep VS Code open and run `wuchat`, or choose **Wuchat: Open Connected CLI** from the Command Palette or Wuchat settings. No API key or provider CLI installation is needed. The extension never copies provider credentials into the CLI; the bridge only forwards requests while the Wuchat extension host is active. If the bridge is unavailable, activate Wuchat in VS Code and authenticate/select a provider there.

Direct API access is an optional alternative: pass `--api`, set `WUCHAT_PROVIDER` (`openai`, `anthropic`, or `zai`), and provide the matching `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`. `WUCHAT_MODEL` selects the model, and OpenAI-compatible endpoints can be overridden with `OPENAI_BASE_URL` or `ZAI_BASE_URL`. The workspace is the current directory, or `WUCHAT_WORKSPACE` when set.

Start a persistent SSH chat inside tmux with `tmux new -s wuchat -- wuchat`. Detach with `Ctrl+B`, then `D`; reconnect using `tmux attach -t wuchat`. The CLI stores conversations under `~/.wuchat/sessions`; use `wuchat --session ID` to resume one. `wuchat --agent` enables file writes and shell commands, each with an approval prompt; `--yes` allows them without prompts.

See [docs/architecture.md](docs/architecture.md) for implementation details and provider boundaries.
