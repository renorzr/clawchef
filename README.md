# clawchef

Recipe-driven OpenClaw environment orchestrator.

## What it does

- Parses a YAML recipe.
- Accepts recipe input from local file/dir/archive and HTTP URL/archive.
- Resolves `${var}` parameters from `--var`, environment, and defaults.
- Auto-loads environment variables from `.env` in the current working directory.
- Supports loading env vars from a custom `.env` path/URL via `--dotenv-ref`.
- Requires secrets to be injected via `--var` / `CLAWCHEF_VAR_*` (no inline secrets in recipe).
- Prepares OpenClaw version (install or reuse).
- When installed OpenClaw version mismatches recipe version, prompts: ignore / abort / force reinstall (silent mode auto-picks force reinstall).
- Supports scoped execution via `--scope full|files|workspace`.
- `full` scope runs factory reset first (with confirmation prompt unless `-s/--silent` is used).
- Factory reset includes removing local `~/.openclaw` directory.
- If `openclaw` is missing, auto-installs the recipe version and skips factory reset.
- Starts OpenClaw gateway after each recipe execution based on `--gateway-mode`.
- Creates workspaces and agents (default workspace path: `~/.openclaw/workspace-<workspace-name>`).
- Supports workspace-level assets copy via `workspaces[].assets`.
- Materializes files into target workspaces.
- Supports OpenClaw root-level assets/files via `openclaw.root` (default root path: `~/.openclaw`).
- Installs skills.
- Supports plugin preinstall via `openclaw.plugins[]` and runtime `--plugin` flags.
- Configures channels with `openclaw channels add`.
- Supports interactive channel login at the end of execution (`channels[].login: true`) for channels that expose login.
- Supports remote HTTP orchestration via runtime flags (`--provider remote`) when OpenClaw is reachable via API.
- Writes preset conversation messages.
- Runs agent and validates reply output.

## Install and run

```bash
npm i -g clawchef
clawchef cook recipes/sample.yaml
```

Run recipe from URL:

```bash
clawchef cook https://example.com/recipes/sample.yaml --provider remote
```

Run with custom env file (local path or HTTP URL):

```bash
clawchef cook recipes/sample.yaml --dotenv-ref ./.env.staging
clawchef cook recipes/sample.yaml --dotenv-ref https://example.com/envs/staging.env
```

Run recipe from GitHub repository root (`recipe.yaml` at repo root):

```bash
clawchef cook https://github.com/renorzr/loom-plus-recipe
```

Run recipe from archive (default `recipe.yaml`):

```bash
clawchef cook ./bundle.tgz --provider mock
```

Run specific recipe in directory or archive:

```bash
clawchef cook ./recipes-pack:team/recipe-prod.yaml --provider remote
clawchef cook https://example.com/recipes-pack.zip:team/recipe-prod.yaml --provider remote
```

Dev mode:

```bash
clawchef cook recipes/sample.yaml --verbose
```

Run sample with mock provider:

```bash
clawchef cook recipes/sample.yaml --provider mock
```

Run `content_from` sample:

```bash
clawchef cook recipes/content-from-sample.yaml --provider mock
```

Skip reset confirmation prompt:

```bash
clawchef cook recipes/sample.yaml -s
```

Control gateway startup mode:

```bash
clawchef cook recipes/sample.yaml --gateway-mode service
clawchef cook recipes/sample.yaml --gateway-mode run
clawchef cook recipes/sample.yaml --gateway-mode none
```

Warning: `-s/--silent` suppresses the factory-reset confirmation and auto-chooses force reinstall on version mismatch.
Use it only in CI/non-interactive flows where destructive reset behavior is expected.

Keep existing OpenClaw state (skip reset and keep current version on mismatch):

```bash
clawchef cook recipes/sample.yaml --scope files
```

Update only one workspace:

```bash
clawchef cook recipes/sample.yaml --scope workspace --workspace workspace-meeting
```

From-zero OpenClaw bootstrap (recommended):

```bash
CLAWCHEF_VAR_LLM_API_KEY=sk-... clawchef cook recipes/openclaw-from-zero.yaml --verbose
```

Telegram channel setup only:

```bash
CLAWCHEF_VAR_TELEGRAM_BOT_TOKEN=123456:abc... clawchef cook recipes/openclaw-telegram.yaml
```

Telegram mock channel setup (for tests):

```bash
CLAWCHEF_VAR_TELEGRAM_MOCK_API_KEY=test-key clawchef cook recipes/openclaw-telegram-mock.yaml
```

Install plugin only for this run:

```bash
clawchef cook recipes/openclaw-telegram-mock.yaml --plugin openclaw-telegram-mock-channel
```

Remote HTTP orchestration:

```bash
CLAWCHEF_REMOTE_BASE_URL=https://remote-openclaw.example.com \
CLAWCHEF_REMOTE_API_KEY=secret-token \
clawchef cook recipes/openclaw-remote-http.yaml --provider remote --verbose
```

Validate recipe structure only:

```bash
clawchef validate recipes/sample.yaml
```

Validate recipe from URL:

```bash
clawchef validate https://example.com/recipes/sample.yaml
```

Validate recipe in archive:

```bash
clawchef validate ./bundle.zip
clawchef validate ./bundle.zip:custom/recipe.yaml
```

Create a new recipe project scaffold:

```bash
clawchef scaffold
clawchef scaffold ./my-recipe-project
clawchef scaffold ./my-recipe-project --name meetingbot
```

`scaffold` prompts for project name (default: target directory name).

Scaffold output:

- `package.json` with `telegram-api-mock-server` in `devDependencies`
- `recipe.yaml` with `telegram-mock` channel, plugin preinstall, and `workspaces[].assets`
- `assets/{AGENTS.md,IDENTITY.md,SOUL.md,TOOLS.md}`
- `assets/scripts/scheduling.mjs`
- `test/recipe-smoke.test.mjs`

By default scaffold only writes files; it does not run `npm install`.

## Node.js API

You can call clawchef directly from Node.js (without invoking CLI commands).

```ts
import { cook, scaffold, validate } from "clawchef";

await validate("recipes/sample.yaml");

await cook("recipes/sample.yaml", {
  provider: "command",
  silent: true,
  vars: {
    llm_api_key: process.env.OPENAI_API_KEY ?? "",
  },
});

await scaffold("./my-recipe-project", {
  projectName: "my-recipe-project",
});
```

`cook()` options:

- `vars`: template variables (`Record<string, string>`)
- `plugins`: plugin npm specs to preinstall for this run (`string[]`)
- `scope`: `full | files | workspace` (default: `full`)
- `workspaceName`: required when `scope: "workspace"`
- `gatewayMode`: `service | run | none` (default: `service`)
- `provider`: `command | remote | mock`
- `remote`: remote provider config (same fields as CLI remote flags)
- `envFile`: custom env file path/URL; when set, default cwd `.env` loading is skipped
- `dryRun`, `allowMissing`, `verbose`
- `silent` (default: `true` in Node API)
- `loadDotEnvFromCwd` (default: `true`)

Node API `silent: true` has the same risk as CLI `-s`: no reset confirmation and force reinstall on version mismatch.
Set `silent: false` when you want an interactive safety prompt.

Notes:

- `validate()` throws on invalid recipe.
- `cook()` throws on runtime/configuration errors.
- `scaffold()` creates `package.json`, `recipe.yaml`, `assets/`, and `test/`.

## Variable precedence

1. `--var key=value`
2. `CLAWCHEF_VAR_<KEY_IN_UPPERCASE>`
3. `params.<key>.default`

If `params.<key>.required: true` and no value is found, run fails.

If `.env` exists in the directory where `clawchef` is executed, it is loaded before recipe parsing.
If `--dotenv-ref` (or Node API `envFile`) is provided, only that env source is loaded.

## Recipe reference formats

`cook` and `validate` accept:

- `path/to/recipe.yaml`
- `path/to/dir` (loads `path/to/dir/recipe.yaml`)
- `path/to/archive.zip` (loads `recipe.yaml` from extracted archive)
- `path/to/dir:custom/recipe.yaml`
- `path/to/archive.tgz:custom/recipe.yaml`
- `https://host/recipe.yaml`
- `https://host/archive.zip` (loads `recipe.yaml` from archive)
- `https://host/archive.zip:custom/recipe.yaml`
- `https://github.com/<owner>/<repo>` (loads `recipe.yaml` from repo root)

Supported archives: `.zip`, `.tar`, `.tar.gz`, `.tgz`.

## OpenClaw provider

Provider is selected at runtime when running `cook`:

- `--provider command` (default)
- `--provider remote`
- `--provider mock`

`mock` provider is useful for local testing of orchestration and output checks.

### Remote HTTP provider

Use `--provider remote` when clawchef cannot run commands on the target machine and must drive configuration via an HTTP endpoint.

Required runtime config:

- `--remote-base-url` or `CLAWCHEF_REMOTE_BASE_URL`

Optional runtime config:

- `--remote-api-key` or `CLAWCHEF_REMOTE_API_KEY`
- `--remote-api-header` or `CLAWCHEF_REMOTE_API_HEADER` (default: `Authorization`)
- `--remote-api-scheme` or `CLAWCHEF_REMOTE_API_SCHEME` (default: `Bearer`; set empty string to send raw key)
- `--remote-timeout-ms` or `CLAWCHEF_REMOTE_TIMEOUT_MS` (default: `60000`)
- `--remote-operation-path` or `CLAWCHEF_REMOTE_OPERATION_PATH` (default: `/v1/clawchef/operation`)

Request payload format (POST):

```json
{
  "operation": "create_workspace",
  "recipe_version": "2026.2.9",
  "payload": {
    "workspace": {
      "name": "demo",
      "path": "/home/runner/.openclaw/workspace-demo"
    }
  }
}
```

Expected response format:

```json
{
  "ok": true,
  "message": "workspace created",
  "output": "optional agent output",
  "installed_this_run": false
}
```

Supported operation values sent by clawchef:

- `ensure_version`, `factory_reset`, `start_gateway`
- `install_plugin`
- `create_workspace`, `create_agent`, `materialize_file`, `install_skill`
- `configure_channel`, `bind_channel_agent`, `login_channel`
- `run_agent`

For `start_gateway`, clawchef sends `{ mode: "service" | "run" }` in payload when gateway mode is enabled.

For `run_agent`, clawchef expects `output` in response for assertions.

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
- auth/provider: `auth_choice`, `llm_api_key`, `token`, `token_provider`, `token_profile_id`

### Plugin preinstall

Use `openclaw.plugins` to preinstall plugin packages before workspace/channel setup.

Example:

```yaml
openclaw:
  version: "2026.2.9"
  plugins:
    - "openclaw-telegram-mock-channel"
    - "@scope/custom-channel-plugin@1.2.3"
```

When `openclaw.bootstrap` contains `llm_api_key`, clawchef maps it to the provider-specific runtime env by `auth_choice` for `openclaw agent --local`.

For `command` provider, default command templates are:

- `use_version`: `${bin} --version`
- `install_version`: `npm install -g openclaw@${version}`
- `uninstall_version`: `npm uninstall -g openclaw`
- `install_plugin`: `${bin} plugins install ${plugin_spec_q}`
- `factory_reset`: `${bin} reset --scope full --yes --non-interactive`
- `start_gateway`: `${bin} gateway start`
- `run_gateway`: `${bin} gateway run`
- `bind_channel_agent`: built-in `openclaw config get/set bindings` upsert (override with `openclaw.commands.bind_channel_agent`)
- `login_channel`: `${bin} channels login --channel ${channel_q}${account_arg}`
- `create_workspace`: generated from `openclaw.bootstrap` (override with `openclaw.commands.create_workspace`)
- `create_agent`: `${bin} agents add ${agent} --workspace ${workspace_path} --model ${model} --non-interactive --json`
- `install_skill`: `${bin} skills check`
- `send_message`: `true` (messages are staged internally for prompt assembly)
- `run_agent`: `${bin} agent --local --agent ${agent} --message ${prompt_q} --json`

You can override any command under `openclaw.commands` in recipe.

By default, clawchef does not auto-run `openclaw plugins enable <channel>` during channel configuration.
If you need custom enable behavior, set `openclaw.commands.enable_plugin` explicitly.

## Channels

Use `channels[]` to configure accounts via `openclaw channels add`.
If `login: true` is set, clawchef runs channel login at the end of `cook` (after gateway start).
Telegram does not support `openclaw channels login`; do not set `login` for `channel: "telegram"`.

Example:

```yaml
channels:
  - channel: "telegram"
    token: "${telegram_bot_token}"
    account: "default"
    agent: "main"
    group_policy: "allowlist"

  - channel: "telegram"
    token: "${alerts_bot_token}"
    account: "alerts"
    agent: "alerts"

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
- optional: `account`, `agent`, `group_policy`, `name`, `token`, `token_file`, `use_env`, `bot_token`, `access_token`, `app_token`, `webhook_url`, `webhook_path`, `signal_number`, `password`, `login`, `login_mode`, `login_account`
- advanced passthrough: `extra_flags` (`snake_case` keys become `--kebab-case` CLI flags)

`channels[].agent` currently supports `channel: "telegram"` only.
If `agent` is set and `account` is omitted, clawchef defaults `account` to the same value as `agent`.
`channels[].group_policy` currently supports `channel: "telegram"` only and is applied after `channels add` via `openclaw config set` so it is not overwritten by add-flow writes.
If `channel: "telegram"` has `token: ""` or `bot_token: ""`, clawchef auto-disables that telegram account (`enabled=false`) and skips channel add/bind.

## Workspace path behavior

- `workspaces[].path` is optional.
- If omitted, clawchef uses `~/.openclaw/workspace-<workspace-name>`.
- `workspaces[].assets` is optional.
- If `assets` is set, clawchef recursively copies files from that directory into the workspace root.
- `assets` is resolved relative to the recipe file path (unless absolute path is given).
- `workspaces[].files[]` runs after assets copy, so explicit file entries can override copied asset files.
- Direct URL recipes do not support `workspaces[].assets` (assets must resolve to a local directory).
- If provided, relative paths are resolved from the recipe file directory.
- For direct URL recipe files, relative workspace paths are resolved from the current working directory.
- For directory/archive recipe references, relative workspace paths are resolved from the selected recipe file directory.

Example:

```yaml
workspaces:
  - name: "workspace-meeting"
    assets: "./meetingbot-assets"
```

## OpenClaw root files

- `openclaw.root.path` is optional.
- If omitted, clawchef uses `~/.openclaw`.
- `openclaw.root.assets` is optional and recursively copied into the root directory.
- `openclaw.root.files[]` runs after assets copy, so explicit file entries can override copied assets.
- `openclaw.root.assets` is resolved relative to the recipe file path (unless absolute path is given).
- Direct URL recipes do not support `openclaw.root.assets` (assets must resolve to a local directory).
- `openclaw.root` currently supports `command` and `mock` providers; `remote` provider is not supported.

Example:

```yaml
openclaw:
  version: "2026.2.9"
  root:
    assets: "./openclaw-root-assets"
    files:
      - path: "AGENTS.md"
        content_from: "./snippets/agents-template.md"
```

## File content references

In `workspaces[].files[]` and `openclaw.root.files[]`, set exactly one of:

- `content`: inline text in recipe
- `content_from`: load text from another file/URL (loaded content supports `${var}` template rendering)
- `source`: copy raw file bytes from another file/URL

`content_from` and `source` accept:

- path relative to recipe file location
- absolute filesystem path
- HTTP/HTTPS URL

Useful placeholders when overriding commands:

- common: `${bin}`, `${version}`, `${workspace}`, `${agent}`, `${channel}`, `${channel_q}`, `${account}`, `${account_q}`, `${account_arg}`
- paths: `${path}` / `${workspace_path}` (shell-quoted), `${path_raw}` / `${workspace_path_raw}` (raw)
- message: `${content}`, `${content_q}`, `${message_file}`, `${message_file_raw}` (`${role}` is always `user`)
- run prompt: `${prompt}`, `${prompt_q}`

## Secret handling

- Do not put plaintext API keys/tokens in recipe files.
- Use `${var}` placeholders in recipe and pass values via:
  - `--var llm_api_key=...`
  - `CLAWCHEF_VAR_LLM_API_KEY=...`
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
