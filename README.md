# clawchef

Recipe-driven OpenClaw environment orchestrator.

## What it does

- Parses a YAML recipe.
- Resolves `${var}` parameters from `--var`, environment, and defaults.
- Auto-loads environment variables from `.env` in the current working directory.
- Requires secrets to be injected via `--var` / `CLAWCHEF_VAR_*` (no inline secrets in recipe).
- Prepares OpenClaw version (install or reuse).
- Always runs factory reset first (with confirmation prompt unless `-s/--silent` is used).
- If `openclaw` is missing, auto-installs the recipe version and skips factory reset.
- Starts OpenClaw gateway service after each recipe execution.
- Creates workspaces and agents (default workspace path: `~/.openclaw/workspaces/<workspace-name>`).
- Materializes files into target workspaces.
- Installs skills.
- Configures channels with `openclaw channels add`.
- Enables channel plugins before channel configuration.
- Supports interactive channel login at the end of execution (`channels[].login: true`).
- Writes preset conversation messages.
- Runs agent and validates reply output.

## Install and run

```bash
npm install
npm run build
node dist/index.js cook recipes/sample.yaml
```

Dev mode:

```bash
npm run dev -- cook recipes/sample.yaml --verbose
```

Skip reset confirmation prompt:

```bash
npm run dev -- cook recipes/sample.yaml -s
```

From-zero OpenClaw bootstrap (recommended):

```bash
CLAWCHEF_VAR_OPENAI_API_KEY=sk-... npm run dev -- cook recipes/openclaw-from-zero.yaml --verbose
```

Telegram channel setup only:

```bash
CLAWCHEF_VAR_TELEGRAM_BOT_TOKEN=123456:abc... npm run dev -- cook recipes/openclaw-telegram.yaml -s
```

Validate recipe structure only:

```bash
npm run dev -- validate recipes/sample.yaml
```

## Variable precedence

1. `--var key=value`
2. `CLAWCHEF_VAR_<KEY_IN_UPPERCASE>`
3. `params.<key>.default`

If `params.<key>.required: true` and no value is found, run fails.

If `.env` exists in the directory where `clawchef` is executed, it is loaded before recipe parsing.

## OpenClaw provider

Recipe field:

- `openclaw.provider: command` (default) or `mock`

`mock` provider is useful for local testing of orchestration and output checks.

`command` provider now defaults to the current OpenClaw CLI shape (`openclaw 2026.x`), including:

- version check: `openclaw --version`
- reset: `openclaw reset --scope full --yes --non-interactive`
- workspace prep: `openclaw onboard --non-interactive --accept-risk --mode local --flow quickstart --auth-choice skip --skip-channels --skip-skills --skip-health --skip-ui --skip-daemon --workspace <path>`
- agent create: `openclaw agents add <name> --workspace <path> --model <model> --non-interactive --json`
- run turn: `openclaw agent --local --agent <name> --message <prompt> --json`

### Bootstrap config

You can provide OpenClaw onboarding and auth parameters under `openclaw.bootstrap`.
This is used by default workspace creation unless `openclaw.commands.create_workspace` is explicitly overridden.

Supported fields include:

- onboarding: `mode`, `flow`, `non_interactive`, `accept_risk`, `reset`
- setup toggles: `skip_channels`, `skip_skills`, `skip_health`, `skip_ui`, `skip_daemon`, `install_daemon`
- auth/provider: `auth_choice`, `openai_api_key`, `anthropic_api_key`, `openrouter_api_key`, `xai_api_key`, `gemini_api_key`, `ai_gateway_api_key`, `cloudflare_ai_gateway_api_key`, `token`, `token_provider`, `token_profile_id`

When `openclaw.bootstrap` contains provider keys, `clawchef` also injects them into runtime env for `openclaw agent --local`.

For `command` provider, default command templates are:

- `use_version`: `${bin} --version`
- `install_version`: `npm install -g openclaw@${version}`
- `factory_reset`: `${bin} reset --scope full --yes --non-interactive`
- `start_gateway`: `${bin} gateway start`
- `enable_plugin`: `${bin} plugins enable ${channel_q}`
- `login_channel`: `${bin} channels login --channel ${channel_q}${account_arg}`
- `create_workspace`: generated from `openclaw.bootstrap` (override with `openclaw.commands.create_workspace`)
- `create_agent`: `${bin} agents add ${agent} --workspace ${workspace_path} --model ${model} --non-interactive --json`
- `install_skill`: `${bin} skills check`
- `send_message`: `true` (messages are staged internally for prompt assembly)
- `run_agent`: `${bin} agent --local --agent ${agent} --message ${prompt_q} --json`

You can override any command under `openclaw.commands` in recipe.

## Channels

Use `channels[]` to configure accounts via `openclaw channels add`.
If `login: true` is set, clawchef runs channel login at the end of `cook` (after gateway start).

Example:

```yaml
channels:
  - channel: "telegram"
    token: "${telegram_bot_token}"
    account: "default"
    login: true

  - channel: "slack"
    bot_token: "${slack_bot_token}"
    app_token: "${slack_app_token}"
    name: "team-workspace"

  - channel: "discord"
    token_file: "${discord_token_file}"
    extra_flags:
      webhook_path: "/discord/webhook"
```

Supported common fields:

- required: `channel`
- optional: `account`, `name`, `token`, `token_file`, `use_env`, `bot_token`, `access_token`, `app_token`, `webhook_url`, `webhook_path`, `signal_number`, `password`, `login`, `login_mode`, `login_account`
- advanced passthrough: `extra_flags` (`snake_case` keys become `--kebab-case` CLI flags)

Login fields:

- `login: true` enables channel login step
- `login_mode`: currently supports `interactive`
- `login_account`: override account used for login (defaults to `account`)

Security rules:

- Do not inline secret values in `channels[]`.
- Use `${var}` placeholders and inject values via `--var` / `CLAWCHEF_VAR_*`.

## Workspace path behavior

- `workspaces[].path` is optional.
- If omitted, clawchef uses `~/.openclaw/workspaces/<workspace-name>`.
- If provided, relative paths are resolved from the recipe file directory.

Useful placeholders when overriding commands:

- common: `${bin}`, `${version}`, `${workspace}`, `${agent}`, `${channel}`, `${channel_q}`, `${account}`, `${account_q}`, `${account_arg}`
- paths: `${path}` / `${workspace_path}` (shell-quoted), `${path_raw}` / `${workspace_path_raw}` (raw)
- message: `${content}`, `${content_q}`, `${message_file}`, `${message_file_raw}` (`${role}` is always `user`)
- run prompt: `${prompt}`, `${prompt_q}`

## Secret handling

- Do not put plaintext API keys/tokens in recipe files.
- Use `${var}` placeholders in recipe and pass values via:
  - `--var openai_api_key=...`
  - `CLAWCHEF_VAR_OPENAI_API_KEY=...`
- Inline secrets in `openclaw.bootstrap.*` are rejected by validation.

## Conversation message format

`conversations[].messages[]` uses:

- `content` (required): the user message sent to agent
- `expect` (optional): output assertion for that message

When `conversations[].run: true`, each message triggers one agent run.
If `run` is omitted, a message still triggers a run when it has `expect`.

`expect` supports:

- `contains: ["..."]`
- `not_contains: ["..."]`
- `regex: ["..."]`
- `equals: "..."`

All configured assertions must pass.
