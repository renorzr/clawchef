import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ClawChefError } from "../errors.js";
import type { AgentDef, ChannelDef, ConversationDef, OpenClawBootstrap, OpenClawSection } from "../types.js";
import type { EnsureVersionResult, OpenClawProvider, ResolvedWorkspaceDef } from "./provider.js";

const DEFAULT_COMMANDS = {
  use_version: "${bin} --version",
  install_version: "npm install -g openclaw@${version}",
  factory_reset: "${bin} reset --scope full --yes --non-interactive",
  start_gateway: "${bin} gateway start",
  enable_plugin: "${bin} plugins enable ${channel_q}",
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

const SECRET_FLAG_RE =
  /(--[A-Za-z0-9-]*(?:api-key|token|password|secret)[A-Za-z0-9-]*\s+)(?:'[^']*'|"[^"]*"|\S+)/g;

type BootstrapStringField =
  | "openai_api_key"
  | "anthropic_api_key"
  | "openrouter_api_key"
  | "xai_api_key"
  | "gemini_api_key"
  | "ai_gateway_api_key"
  | "cloudflare_ai_gateway_api_key"
  | "cloudflare_ai_gateway_account_id"
  | "cloudflare_ai_gateway_gateway_id"
  | "token"
  | "token_provider"
  | "token_profile_id";

const BOOTSTRAP_STRING_FLAGS: Array<[BootstrapStringField, string]> = [
  ["openai_api_key", "--openai-api-key"],
  ["anthropic_api_key", "--anthropic-api-key"],
  ["openrouter_api_key", "--openrouter-api-key"],
  ["xai_api_key", "--xai-api-key"],
  ["gemini_api_key", "--gemini-api-key"],
  ["ai_gateway_api_key", "--ai-gateway-api-key"],
  ["cloudflare_ai_gateway_api_key", "--cloudflare-ai-gateway-api-key"],
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
  if (dryRun) {
    return "";
  }

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
        resolve(stdout.trim());
        return;
      }
      reject(new ClawChefError(`Command failed (${code}): ${sanitizeCommand(command)}\n${stderr.trim()}`));
    });
  });
}

async function runShellInteractive(command: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    return;
  }

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
        resolve();
        return;
      }
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

  if (bootstrap.openai_api_key) env.OPENAI_API_KEY = bootstrap.openai_api_key;
  if (bootstrap.anthropic_api_key) env.ANTHROPIC_API_KEY = bootstrap.anthropic_api_key;
  if (bootstrap.openrouter_api_key) env.OPENROUTER_API_KEY = bootstrap.openrouter_api_key;
  if (bootstrap.xai_api_key) env.XAI_API_KEY = bootstrap.xai_api_key;
  if (bootstrap.gemini_api_key) env.GEMINI_API_KEY = bootstrap.gemini_api_key;
  if (bootstrap.ai_gateway_api_key) env.AI_GATEWAY_API_KEY = bootstrap.ai_gateway_api_key;
  if (bootstrap.cloudflare_ai_gateway_api_key) {
    env.CLOUDFLARE_AI_GATEWAY_API_KEY = bootstrap.cloudflare_ai_gateway_api_key;
  }

  return env;
}

export class CommandOpenClawProvider implements OpenClawProvider {
  private readonly stagedMessages = new Map<string, StagedMessage[]>();

  async ensureVersion(config: OpenClawSection, dryRun: boolean): Promise<EnsureVersionResult> {
    const bin = config.bin ?? "openclaw";
    const installPolicy = config.install ?? "auto";
    const useCmd = commandFor(config, "use_version", { bin, version: config.version });
    const installCmd = commandFor(config, "install_version", { bin, version: config.version });

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

    if (config.commands?.use_version || config.commands?.install_version) {
      if (!useCmd.trim()) {
        return { installedThisRun };
      }

      if (installPolicy === "always") {
        if (!installCmd.trim()) {
          throw new ClawChefError("install=always requires openclaw.commands.install_version");
        }
        await runShell(installCmd, false);
        installedThisRun = true;
      }

      try {
        await runShell(useCmd, false);
      } catch (err) {
        if (installPolicy === "never" && !installedThisRun) {
          throw err;
        }
        if (!installCmd.trim()) {
          throw new ClawChefError("Requested version is unavailable and install_version is not configured");
        }
        await runShell(installCmd, false);
        installedThisRun = true;
        await runShell(useCmd, false);
      }

      return { installedThisRun };
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

    const versionOut = await runShell(useCmd, false);
    const currentVersion = parseVersionOutput(versionOut);
    if (currentVersion === config.version) {
      return { installedThisRun };
    }

    if (installPolicy === "never" && !installedThisRun) {
      throw new ClawChefError(
        `OpenClaw version mismatch: current ${currentVersion}, expected ${config.version} (install=never)`,
      );
    }

    if (!installCmd.trim()) {
      throw new ClawChefError(
        `Current version ${currentVersion} does not match expected ${config.version}; configure openclaw.commands.install_version`,
      );
    }

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
    if (!resetCmd.trim()) {
      return;
    }
    await runShell(resetCmd, dryRun);
  }

  async startGateway(config: OpenClawSection, dryRun: boolean): Promise<void> {
    const bin = config.bin ?? "openclaw";
    const startCmd = commandFor(config, "start_gateway", { bin, version: config.version });
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
    const enablePluginCmd = commandFor(config, "enable_plugin", {
      bin,
      version: config.version,
      channel: channel.channel,
      channel_q: shellQuote(channel.channel),
    });
    if (enablePluginCmd.trim()) {
      await runShell(enablePluginCmd, dryRun);
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
