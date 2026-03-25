import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ClawChefError } from "../errors.js";
import type { AgentDef, ChannelDef, ConversationDef, GatewayMode, OpenClawBootstrap, OpenClawSection } from "../types.js";
import type { ChannelAgentBinding, EnsureVersionResult, OpenClawProvider, ResolvedWorkspaceDef } from "./provider.js";

const DEFAULT_COMMANDS = {
  use_version: "${bin} --version",
  install_version: "npm install -g openclaw@${version}",
  uninstall_version: "npm uninstall -g openclaw",
  install_plugin: "${bin} plugins install ${plugin_spec_q}",
  factory_reset: "${bin} reset --scope full --yes --non-interactive",
  start_gateway: "${bin} gateway start",
  run_gateway: "${bin} gateway run",
  enable_plugin: "",
  bind_channel_agent: "",
  login_channel: "${bin} channels login --channel ${channel_q}${account_arg}",
  create_agent:
    "${bin} agents add ${agent} --workspace ${workspace_path} --model ${model} --non-interactive --json",
  install_skill: "${bin} skills check",
  send_message: "true",
  run_agent: "${bin} agent --local --agent ${agent} --message ${prompt_q} --json",
};

type CommandKey = keyof typeof DEFAULT_COMMANDS;

interface StagedMessage {
  content: string;
}

interface BindingItem {
  agentId?: unknown;
  match?: {
    channel?: unknown;
    accountId?: unknown;
    peer?: unknown;
    parentPeer?: unknown;
    guildId?: unknown;
    teamId?: unknown;
    roles?: unknown;
  };
  [key: string]: unknown;
}

const SECRET_FLAG_RE =
  /(--[A-Za-z0-9-]*(?:api-key|token|password|secret)[A-Za-z0-9-]*\s+)(?:'[^']*'|"[^"]*"|\S+)/g;

let TRACE_VERBOSE = false;

function timestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function traceDebug(message: string): void {
  if (!TRACE_VERBOSE) {
    return;
  }
  process.stdout.write(`[${timestamp()}] [DEBUG] ${message}\n`);
}

type BootstrapStringField =
  | "cloudflare_ai_gateway_account_id"
  | "cloudflare_ai_gateway_gateway_id"
  | "token"
  | "token_provider"
  | "token_profile_id";

const AUTH_CHOICE_TO_LLM_FLAG: Record<string, string> = {
  "openai-api-key": "--openai-api-key",
  "anthropic-api-key": "--anthropic-api-key",
  "openrouter-api-key": "--openrouter-api-key",
  "xai-api-key": "--xai-api-key",
  "gemini-api-key": "--gemini-api-key",
  "ai-gateway-api-key": "--ai-gateway-api-key",
  "cloudflare-ai-gateway-api-key": "--cloudflare-ai-gateway-api-key",
};

const AUTH_CHOICE_TO_LLM_ENV: Record<string, string> = {
  "openai-api-key": "OPENAI_API_KEY",
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "openrouter-api-key": "OPENROUTER_API_KEY",
  "xai-api-key": "XAI_API_KEY",
  "gemini-api-key": "GEMINI_API_KEY",
  "ai-gateway-api-key": "AI_GATEWAY_API_KEY",
  "cloudflare-ai-gateway-api-key": "CLOUDFLARE_AI_GATEWAY_API_KEY",
};

const BOOTSTRAP_STRING_FLAGS: Array<[BootstrapStringField, string]> = [
  ["cloudflare_ai_gateway_account_id", "--cloudflare-ai-gateway-account-id"],
  ["cloudflare_ai_gateway_gateway_id", "--cloudflare-ai-gateway-gateway-id"],
  ["token", "--token"],
  ["token_provider", "--token-provider"],
  ["token_profile_id", "--token-profile-id"],
];

function fillTemplate(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => vars[key] ?? "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitizeCommand(command: string): string {
  return command.replace(SECRET_FLAG_RE, "$1***");
}

function snakeToKebab(value: string): string {
  return value.replace(/_/g, "-");
}

async function commandExists(bin: string): Promise<boolean> {
  try {
    await runShell(`command -v ${shellQuote(bin)}`, false);
    return true;
  } catch {
    return false;
  }
}

async function runShell(command: string, dryRun: boolean, extraEnv?: Record<string, string>): Promise<string> {
  const sanitized = sanitizeCommand(command);
  if (dryRun) {
    traceDebug(`CMD DRY-RUN: ${sanitized}`);
    return "";
  }

  const startedAt = Date.now();
  traceDebug(`CMD START: ${sanitized}`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(extraEnv ?? {}) },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (buf) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += String(buf);
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        traceDebug(`CMD DONE (${Date.now() - startedAt}ms): ${sanitized}`);
        resolve(stdout.trim());
        return;
      }
      traceDebug(`CMD FAIL (${Date.now() - startedAt}ms) code=${String(code)}: ${sanitized}`);
      reject(new ClawChefError(`Command failed (${code}): ${sanitizeCommand(command)}\n${stderr.trim()}`));
    });
  });
}

async function runShellInteractive(command: string, dryRun: boolean): Promise<void> {
  const sanitized = sanitizeCommand(command);
  if (dryRun) {
    traceDebug(`CMD DRY-RUN (interactive): ${sanitized}`);
    return;
  }

  const startedAt = Date.now();
  traceDebug(`CMD START (interactive): ${sanitized}`);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        traceDebug(`CMD DONE (interactive, ${Date.now() - startedAt}ms): ${sanitized}`);
        resolve();
        return;
      }
      traceDebug(`CMD FAIL (interactive, ${Date.now() - startedAt}ms) code=${String(code)}: ${sanitized}`);
      reject(new ClawChefError(`Command failed (${code}): ${sanitizeCommand(command)}`));
    });
  });
}

function commandFor(config: OpenClawSection, key: CommandKey, vars: Record<string, string>): string {
  const template = config.commands?.[key] ?? DEFAULT_COMMANDS[key];
  return fillTemplate(template, vars);
}

function parseVersionOutput(output: string): string {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? output.trim();
}

function telegramGroupPolicyPath(account: string | undefined): string {
  const trimmed = account?.trim();
  if (!trimmed) {
    return "channels.telegram.groupPolicy";
  }
  return `channels.telegram.accounts[${trimmed}].groupPolicy`;
}

function telegramEnabledPath(account: string | undefined): string {
  const trimmed = account?.trim();
  if (!trimmed) {
    return "channels.telegram.enabled";
  }
  return `channels.telegram.accounts[${trimmed}].enabled`;
}

function shouldAutoDisableTelegramChannel(channel: ChannelDef): boolean {
  if (channel.channel !== "telegram") {
    return false;
  }
  const emptyToken = channel.token !== undefined && channel.token.trim().length === 0;
  const emptyBotToken = channel.bot_token !== undefined && channel.bot_token.trim().length === 0;
  return emptyToken || emptyBotToken;
}

type VersionMismatchChoice = "ignore" | "abort" | "force";

type JsonPatchValue = null | boolean | number | string | JsonPatchValue[] | { [key: string]: JsonPatchValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidConfigPathToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function appendPath(base: string, key: string): string {
  if (!isValidConfigPathToken(key)) {
    throw new ClawChefError(`Unsupported config patch key for path token: ${key}`);
  }
  if (!base) {
    return key;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return `${base}.${key}`;
  }
  return `${base}[${key}]`;
}

function toJsonPatchValue(value: unknown, pathLabel: string): JsonPatchValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonPatchValue(item, `${pathLabel}[${index}]`));
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: JsonPatchValue } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonPatchValue(v, `${pathLabel}.${k}`);
    }
    return out;
  }
  throw new ClawChefError(`openclaw.config_patch contains unsupported value at ${pathLabel}`);
}

async function applyConfigPatchAtPath(
  bin: string,
  basePath: string,
  value: JsonPatchValue,
  dryRun: boolean,
): Promise<void> {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      const cmd = `${bin} config set ${shellQuote(basePath)} '${"{}"}' --strict-json`;
      await runShell(cmd, dryRun);
      return;
    }
    for (const [k, nested] of entries) {
      const nextPath = appendPath(basePath, k);
      await applyConfigPatchAtPath(bin, nextPath, nested, dryRun);
    }
    return;
  }

  const payload = JSON.stringify(value);
  const cmd = `${bin} config set ${shellQuote(basePath)} ${shellQuote(payload)} --strict-json`;
  await runShell(cmd, dryRun);
}

async function chooseVersionMismatchAction(
  currentVersion: string,
  expectedVersion: string,
  silent: boolean,
): Promise<VersionMismatchChoice> {
  if (silent) {
    return "force";
  }
  if (!input.isTTY) {
    throw new ClawChefError(
      "OpenClaw version mismatch requires interactive terminal. Use --silent to force reinstall and continue.",
    );
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(
        [
          `OpenClaw version mismatch detected: current ${currentVersion}, expected ${expectedVersion}`,
          "Choose action:",
          "  1) Ignore and continue",
          "  2) Abort",
          "  3) Force continue (uninstall + install expected version)",
          "Enter 1/2/3 [default: 2]: ",
        ].join("\n"),
      );
      const choice = answer.trim();
      if (choice === "1") return "ignore";
      if (choice === "2" || choice === "") return "abort";
      if (choice === "3") return "force";
      output.write("Invalid choice. Please enter 1, 2, or 3.\n");
    }
  } finally {
    rl.close();
  }
}

function buildPrompt(messages: StagedMessage[]): string {
  return messages.map((m) => `user: ${m.content}`).join("\n");
}

function buildBootstrapCommand(bin: string, bootstrap: OpenClawBootstrap | undefined, workspacePath: string): string {
  const cfg = bootstrap ?? {};
  const flags: string[] = [];

  flags.push(`--mode ${shellQuote(cfg.mode ?? "local")}`);
  flags.push(`--flow ${shellQuote(cfg.flow ?? "quickstart")}`);
  flags.push(`--auth-choice ${shellQuote(cfg.auth_choice ?? "skip")}`);

  if (cfg.non_interactive ?? true) {
    flags.push("--non-interactive");
  }
  if (cfg.accept_risk ?? true) {
    flags.push("--accept-risk");
  }
  if (cfg.reset) {
    flags.push("--reset");
  }
  if (cfg.skip_channels ?? true) {
    flags.push("--skip-channels");
  }
  if (cfg.skip_skills ?? true) {
    flags.push("--skip-skills");
  }
  if (cfg.skip_health ?? true) {
    flags.push("--skip-health");
  }
  if (cfg.skip_ui ?? true) {
    flags.push("--skip-ui");
  }
  if (cfg.skip_daemon ?? true) {
    flags.push("--skip-daemon");
  }

  if (cfg.install_daemon === true) {
    flags.push("--install-daemon");
  } else if (cfg.install_daemon === false) {
    flags.push("--no-install-daemon");
  }

  if (cfg.llm_api_key?.trim()) {
    const llmFlag = AUTH_CHOICE_TO_LLM_FLAG[cfg.auth_choice ?? ""];
    if (llmFlag) {
      flags.push(`${llmFlag} ${shellQuote(cfg.llm_api_key)}`);
    }
  }

  for (const [field, flag] of BOOTSTRAP_STRING_FLAGS) {
    const value = cfg[field];
    if (value && value.trim()) {
      flags.push(`${flag} ${shellQuote(value)}`);
    }
  }

  const workspaceValue = cfg.workspace?.trim() ? cfg.workspace : workspacePath;
  flags.push(`--workspace ${shellQuote(workspaceValue)}`);
  return `${bin} onboard ${flags.join(" ")}`;
}

function bootstrapRuntimeEnv(bootstrap: OpenClawBootstrap | undefined): Record<string, string> {
  if (!bootstrap) {
    return {};
  }
  const env: Record<string, string> = {};

  if (bootstrap.llm_api_key?.trim()) {
    const envKey = AUTH_CHOICE_TO_LLM_ENV[bootstrap.auth_choice ?? ""];
    if (envKey) {
      env[envKey] = bootstrap.llm_api_key;
    }
  }

  return env;
}

function isAccountLevelBinding(item: BindingItem, channel: string, account: string): boolean {
  const match = item.match;
  if (!match || typeof match !== "object") {
    return false;
  }
  if (match.channel !== channel || match.accountId !== account) {
    return false;
  }
  return (
    match.peer === undefined
    && match.parentPeer === undefined
    && match.guildId === undefined
    && match.teamId === undefined
    && match.roles === undefined
  );
}

function parseBindingsJson(raw: string): BindingItem[] {
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new ClawChefError("openclaw config bindings is not an array");
    }
    return parsed as BindingItem[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ClawChefError(`Failed to parse openclaw bindings JSON: ${message}`);
  }
}

export class CommandOpenClawProvider implements OpenClawProvider {
  private readonly stagedMessages = new Map<string, StagedMessage[]>();
  private readonly enabledChannelPlugins = new Set<string>();

  constructor(verboseEnabled = false) {
    TRACE_VERBOSE = verboseEnabled;
  }

  async ensureVersion(
    config: OpenClawSection,
    dryRun: boolean,
    silent: boolean,
    preserveExistingState: boolean,
  ): Promise<EnsureVersionResult> {
    const bin = config.bin ?? "openclaw";
    const installPolicy = config.install ?? "auto";
    const useCmd = commandFor(config, "use_version", { bin, version: config.version });
    const installCmd = commandFor(config, "install_version", { bin, version: config.version });
    const uninstallCmd = commandFor(config, "uninstall_version", { bin, version: config.version });

    if (dryRun) {
      return { installedThisRun: false };
    }

    const existedBeforeRun = await commandExists(bin);
    let installedThisRun = false;

    if (!existedBeforeRun) {
      if (!installCmd.trim()) {
        throw new ClawChefError(
          `OpenClaw is not installed and install_version is empty; cannot install ${config.version}`,
        );
      }
      await runShell(installCmd, false);
      installedThisRun = true;
    }

    if (!useCmd.trim()) {
      return { installedThisRun };
    }

    if (installPolicy === "always") {
      if (!installCmd.trim()) {
        throw new ClawChefError(
          `install=always requires install_version command to install ${config.version}`,
        );
      }
      await runShell(installCmd, false);
      installedThisRun = true;
    }

    let currentVersion: string;
    try {
      const versionOut = await runShell(useCmd, false);
      currentVersion = parseVersionOutput(versionOut);
    } catch (err) {
      if (installPolicy === "never" && !installedThisRun) {
        throw err;
      }
      if (!installCmd.trim()) {
        throw new ClawChefError("Requested version is unavailable and install_version is not configured");
      }
      await runShell(installCmd, false);
      installedThisRun = true;
      const versionOutAfterInstall = await runShell(useCmd, false);
      currentVersion = parseVersionOutput(versionOutAfterInstall);
    }

    if (currentVersion === config.version) {
      return { installedThisRun };
    }

    if (installedThisRun) {
      throw new ClawChefError(
        `OpenClaw version mismatch after install: current ${currentVersion}, expected ${config.version}`,
      );
    }

    if (preserveExistingState) {
      return { installedThisRun: false };
    }

    const choice = await chooseVersionMismatchAction(currentVersion, config.version, silent);

    if (choice === "ignore") {
      return { installedThisRun: false };
    }
    if (choice === "abort") {
      throw new ClawChefError("Aborted by user due to OpenClaw version mismatch");
    }

    if (!uninstallCmd.trim()) {
      throw new ClawChefError("Force continue requires openclaw.commands.uninstall_version");
    }
    if (!installCmd.trim()) {
      throw new ClawChefError("Force continue requires openclaw.commands.install_version");
    }

    await runShell(uninstallCmd, false);
    await runShell(installCmd, false);
    installedThisRun = true;

    const versionOutAfter = await runShell(useCmd, false);
    const installedVersion = parseVersionOutput(versionOutAfter);
    if (installedVersion !== config.version) {
      throw new ClawChefError(
        `Version still mismatched after install: current ${installedVersion}, expected ${config.version}`,
      );
    }

    return { installedThisRun };
  }

  async factoryReset(config: OpenClawSection, dryRun: boolean): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const resetCmd = commandFor(config, "factory_reset", { bin, version: config.version });
    if (resetCmd.trim()) {
      await runShell(resetCmd, dryRun);
    }

    const openclawHome = path.join(homedir(), ".openclaw");
    if (!dryRun) {
      await rm(openclawHome, { recursive: true, force: true });
    }
  }

  async installPlugin(config: OpenClawSection, pluginSpec: string, dryRun: boolean): Promise<void> {
    const trimmed = pluginSpec.trim();
    if (!trimmed) {
      return;
    }

    const bin = config.bin ?? "openclaw";
    const cmd = commandFor(config, "install_plugin", {
      bin,
      version: config.version,
      plugin_spec: trimmed,
      plugin_spec_q: shellQuote(trimmed),
    });
    if (!cmd.trim()) {
      return;
    }
    await runShell(cmd, dryRun);
  }

  async startGateway(config: OpenClawSection, mode: GatewayMode, dryRun: boolean): Promise<void> {
    if (mode === "none") {
      return;
    }

    const bin = config.bin ?? "openclaw";
    const key = mode === "run" ? "run_gateway" : "start_gateway";
    const startCmd = commandFor(config, key, { bin, version: config.version });
    if (!startCmd.trim()) {
      return;
    }
    await runShell(startCmd, dryRun);
  }

  async createWorkspace(config: OpenClawSection, workspace: ResolvedWorkspaceDef, dryRun: boolean): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const cmd = config.commands?.create_workspace
      ? fillTemplate(config.commands.create_workspace, {
          bin,
          version: config.version,
          workspace: workspace.name,
          path: shellQuote(workspace.path),
          path_raw: workspace.path,
        })
      : buildBootstrapCommand(bin, config.bootstrap, workspace.path);
    if (!cmd.trim()) {
      return;
    }
    await runShell(cmd, dryRun);
  }

  async configureChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void> {
    const bin = config.bin ?? "openclaw";

    if (shouldAutoDisableTelegramChannel(channel)) {
      const enabledPath = telegramEnabledPath(channel.account);
      const disableCmd = `${bin} config set ${shellQuote(enabledPath)} false --strict-json`;
      await runShell(disableCmd, dryRun);
      return;
    }

    const enablePluginTemplate = config.commands?.enable_plugin;
    if (enablePluginTemplate?.trim() && !this.enabledChannelPlugins.has(channel.channel)) {
      const enablePluginCmd = fillTemplate(enablePluginTemplate, {
        bin,
        version: config.version,
        channel: channel.channel,
        channel_q: shellQuote(channel.channel),
      });
      if (enablePluginCmd.trim()) {
        await runShell(enablePluginCmd, dryRun);
      }
      this.enabledChannelPlugins.add(channel.channel);
    } else if (enablePluginTemplate?.trim()) {
      traceDebug(`Skip plugin enable for channel=${channel.channel}; already enabled in this run`);
    }

    const flags: string[] = [
      "--channel",
      shellQuote(channel.channel),
    ];

    const fields: Array<[keyof ChannelDef, string]> = [
      ["account", "--account"],
      ["name", "--name"],
      ["token", "--token"],
      ["token_file", "--token-file"],
      ["bot_token", "--bot-token"],
      ["access_token", "--access-token"],
      ["app_token", "--app-token"],
      ["webhook_url", "--webhook-url"],
      ["webhook_path", "--webhook-path"],
      ["signal_number", "--signal-number"],
      ["password", "--password"],
    ];

    for (const [field, flag] of fields) {
      const value = channel[field];
      if (typeof value === "string" && value.trim()) {
        flags.push(`${flag} ${shellQuote(value)}`);
      }
    }

    if (channel.use_env) {
      flags.push("--use-env");
    }

    for (const [rawKey, rawValue] of Object.entries(channel.extra_flags ?? {})) {
      const key = `--${snakeToKebab(rawKey)}`;
      if (typeof rawValue === "boolean") {
        if (rawValue) {
          flags.push(key);
        }
        continue;
      }
      flags.push(`${key} ${shellQuote(String(rawValue))}`);
    }

    const cmd = `${bin} channels add ${flags.join(" ")}`;
    await runShell(cmd, dryRun);

    if (channel.channel === "telegram" && channel.group_policy) {
      const configPath = telegramGroupPolicyPath(channel.account);
      const policyValue = JSON.stringify(channel.group_policy);
      const setPolicyCmd = `${bin} config set ${shellQuote(configPath)} ${shellQuote(policyValue)} --strict-json`;
      await runShell(setPolicyCmd, dryRun);
    }
  }

  async applyConfigPatch(config: OpenClawSection, patch: Record<string, unknown>, dryRun: boolean): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const normalized = toJsonPatchValue(patch, "openclaw.config_patch");
    if (!isPlainObject(normalized)) {
      throw new ClawChefError("openclaw.config_patch must be an object");
    }

    for (const [k, v] of Object.entries(normalized)) {
      const path = appendPath("", k);
      await applyConfigPatchAtPath(bin, path, v, dryRun);
    }
  }

  async bindChannelAgents(config: OpenClawSection, bindingsInput: ChannelAgentBinding[], dryRun: boolean): Promise<void> {
    if (bindingsInput.length === 0) {
      return;
    }

    const bin = config.bin ?? "openclaw";
    const customTemplate = config.commands?.bind_channel_agent;
    if (customTemplate?.trim()) {
      for (const binding of bindingsInput) {
        await this.bindChannelAgent(config, binding.channel, binding.agent, dryRun);
      }
      return;
    }

    if (dryRun) {
      return;
    }

    const getCmd = `${bin} config get bindings --json 2>/dev/null || printf '[]'`;
    const rawBindings = await runShell(getCmd, false);
    const bindings = parseBindingsJson(rawBindings);

    for (const binding of bindingsInput) {
      const account = binding.channel.account?.trim();
      if (!account) {
        throw new ClawChefError(`Channel ${binding.channel.channel} requires account for agent binding`);
      }

      const nextBinding: BindingItem = {
        agentId: binding.agent,
        match: {
          channel: binding.channel.channel,
          accountId: account,
        },
      };

      const index = bindings.findIndex((item) => isAccountLevelBinding(item, binding.channel.channel, account));
      if (index >= 0) {
        bindings[index] = nextBinding;
      } else {
        bindings.push(nextBinding);
      }
    }

    const json = JSON.stringify(bindings);
    const setCmd = `${bin} config set bindings ${shellQuote(json)} --json`;
    await runShell(setCmd, false);
  }

  async bindChannelAgent(config: OpenClawSection, channel: ChannelDef, agent: string, dryRun: boolean): Promise<void> {
    const account = channel.account?.trim();
    if (!account) {
      throw new ClawChefError(`Channel ${channel.channel} requires account for agent binding`);
    }

    const bin = config.bin ?? "openclaw";
    const customTemplate = config.commands?.bind_channel_agent;
    if (customTemplate?.trim()) {
      const customCmd = fillTemplate(customTemplate, {
        bin,
        version: config.version,
        channel: channel.channel,
        channel_q: shellQuote(channel.channel),
        account,
        account_q: shellQuote(account),
        agent,
        agent_q: shellQuote(agent),
      });
      if (customCmd.trim()) {
        await runShell(customCmd, dryRun);
      }
      return;
    }

    await this.bindChannelAgents(config, [{ channel, agent }], dryRun);
  }

  async loginChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void> {
    if (!channel.login) {
      return;
    }

    const bin = config.bin ?? "openclaw";
    const account = channel.login_account?.trim() || channel.account?.trim() || "";
    const accountArg = account ? ` --account ${shellQuote(account)}` : "";
    const cmd = commandFor(config, "login_channel", {
      bin,
      version: config.version,
      channel: channel.channel,
      channel_q: shellQuote(channel.channel),
      account,
      account_q: shellQuote(account),
      account_arg: accountArg,
    });
    if (!cmd.trim()) {
      return;
    }
    await runShellInteractive(cmd, dryRun);
  }

  async createAgent(
    config: OpenClawSection,
    agent: AgentDef,
    workspacePath: string,
    dryRun: boolean,
  ): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const model = agent.model ?? "";
    const cmd = commandFor(config, "create_agent", {
      bin,
      version: config.version,
      workspace: agent.workspace,
      workspace_path: shellQuote(workspacePath),
      workspace_path_raw: workspacePath,
      agent: agent.name,
      model: shellQuote(model),
      model_raw: model,
    });
    if (!cmd.trim()) {
      return;
    }
    try {
      await runShell(cmd, dryRun);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        return;
      }
      throw err;
    }
  }

  async installSkill(
    config: OpenClawSection,
    workspace: string,
    agent: string,
    skill: string,
    dryRun: boolean,
  ): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const cmd = commandFor(config, "install_skill", {
      bin,
      version: config.version,
      workspace,
      agent,
      skill,
      skill_q: shellQuote(skill),
    });
    if (!cmd.trim()) {
      return;
    }
    await runShell(cmd, dryRun);
  }

  async sendMessage(
    config: OpenClawSection,
    conversation: ConversationDef,
    content: string,
    dryRun: boolean,
  ): Promise<void> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const staged = this.stagedMessages.get(key) ?? [];
    staged.push({ content });
    this.stagedMessages.set(key, staged);

    const template = config.commands?.send_message ?? DEFAULT_COMMANDS.send_message;
    if (!template.trim() || template.trim() === "true") {
      return;
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "clawchef-msg-"));
    try {
      const msgPath = path.join(tempDir, "message.json");
      await writeFile(msgPath, JSON.stringify({ role: "user", content }, null, 2), "utf8");
      const bin = config.bin ?? "openclaw";
      const cmd = commandFor(config, "send_message", {
        bin,
        version: config.version,
        workspace: conversation.workspace,
        agent: conversation.agent,
        role: "user",
        role_q: shellQuote("user"),
        content,
        content_q: shellQuote(content),
        message_file: shellQuote(msgPath),
        message_file_raw: msgPath,
      });
      await runShell(cmd, dryRun);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async runAgent(config: OpenClawSection, conversation: ConversationDef, dryRun: boolean): Promise<string> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const staged = this.stagedMessages.get(key) ?? [];
    const prompt = buildPrompt(staged);
    const bin = config.bin ?? "openclaw";
    const cmd = commandFor(config, "run_agent", {
      bin,
      version: config.version,
      workspace: conversation.workspace,
      agent: conversation.agent,
      prompt,
      prompt_q: shellQuote(prompt),
    });
    return runShell(cmd, dryRun, bootstrapRuntimeEnv(config.bootstrap));
  }
}
