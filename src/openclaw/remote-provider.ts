import { ClawChefError } from "../errors.js";
import type {
  AgentDef,
  ChannelDef,
  ConversationDef,
  OpenClawRemoteConfig,
  OpenClawSection,
} from "../types.js";
import type { EnsureVersionResult, OpenClawProvider, ResolvedWorkspaceDef } from "./provider.js";

interface StagedMessage {
  content: string;
}

interface RemoteOperationRequest {
  operation: string;
  recipe_version: string;
  payload?: Record<string, unknown>;
}

interface RemoteOperationResponse {
  ok?: boolean;
  message?: string;
  output?: string;
  installed_this_run?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_PATH = "/v1/clawchef/operation";

function parseResponseBody(raw: string): RemoteOperationResponse {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as RemoteOperationResponse;
  } catch {
    return { message: raw.trim() };
  }
}

function buildHeaders(remote: OpenClawRemoteConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (remote.api_key?.trim()) {
    const headerName = remote.api_header?.trim() || "Authorization";
    const scheme = remote.api_scheme === undefined ? "Bearer" : remote.api_scheme;
    headers[headerName] = scheme ? `${scheme} ${remote.api_key}` : remote.api_key;
  }

  return headers;
}

function operationUrl(remote: OpenClawRemoteConfig): string {
  const path = remote.operation_path?.trim() || DEFAULT_OPERATION_PATH;
  return new URL(path, remote.base_url).toString();
}

function assertRemoteConfig(remote: Partial<OpenClawRemoteConfig>): OpenClawRemoteConfig {
  const baseUrl = remote.base_url?.trim();
  if (!baseUrl) {
    throw new ClawChefError("--provider remote requires --remote-base-url (or CLAWCHEF_REMOTE_BASE_URL)");
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new ClawChefError(`Remote base URL is invalid: ${baseUrl}`);
  }

  return {
    base_url: baseUrl,
    api_key: remote.api_key,
    api_header: remote.api_header,
    api_scheme: remote.api_scheme,
    timeout_ms: remote.timeout_ms,
    operation_path: remote.operation_path,
  };
}

export class RemoteOpenClawProvider implements OpenClawProvider {
  private readonly stagedMessages = new Map<string, StagedMessage[]>();
  private readonly remoteConfig: Partial<OpenClawRemoteConfig>;

  constructor(remoteConfig: Partial<OpenClawRemoteConfig>) {
    this.remoteConfig = remoteConfig;
  }

  private async perform(
    config: OpenClawSection,
    operation: string,
    payload: Record<string, unknown> | undefined,
    dryRun: boolean,
  ): Promise<RemoteOperationResponse> {
    if (dryRun) {
      return { ok: true };
    }

    const remote = assertRemoteConfig(this.remoteConfig);
    const timeoutMs = remote.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const requestBody: RemoteOperationRequest = {
      operation,
      recipe_version: config.version,
      payload,
    };

    try {
      const response = await fetch(operationUrl(remote), {
        method: "POST",
        headers: buildHeaders(remote),
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const raw = await response.text();
      const parsed = parseResponseBody(raw);

      if (!response.ok) {
        throw new ClawChefError(
          `Remote operation failed (${response.status}) for ${operation}: ${parsed.message ?? response.statusText}`,
        );
      }

      if (parsed.ok === false) {
        throw new ClawChefError(`Remote operation failed for ${operation}: ${parsed.message ?? "unknown error"}`);
      }

      return parsed;
    } catch (err) {
      if (err instanceof ClawChefError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ClawChefError(`Remote operation failed for ${operation}: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureVersion(
    config: OpenClawSection,
    dryRun: boolean,
    _silent: boolean,
    _keepOpenClawState: boolean,
  ): Promise<EnsureVersionResult> {
    const result = await this.perform(
      config,
      "ensure_version",
      {
        install: config.install,
      },
      dryRun,
    );

    return {
      installedThisRun: Boolean(result.installed_this_run),
    };
  }

  async installPlugin(config: OpenClawSection, pluginSpec: string, dryRun: boolean): Promise<void> {
    await this.perform(
      config,
      "install_plugin",
      {
        plugin_spec: pluginSpec,
      },
      dryRun,
    );
  }

  async factoryReset(config: OpenClawSection, dryRun: boolean): Promise<void> {
    await this.perform(config, "factory_reset", undefined, dryRun);
  }

  async startGateway(config: OpenClawSection, dryRun: boolean): Promise<void> {
    await this.perform(config, "start_gateway", undefined, dryRun);
  }

  async createWorkspace(config: OpenClawSection, workspace: ResolvedWorkspaceDef, dryRun: boolean): Promise<void> {
    await this.perform(config, "create_workspace", { workspace }, dryRun);
  }

  async configureChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void> {
    await this.perform(config, "configure_channel", { channel }, dryRun);
  }

  async loginChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void> {
    await this.perform(config, "login_channel", { channel }, dryRun);
  }

  async materializeFile(
    config: OpenClawSection,
    workspace: string,
    filePath: string,
    content: string,
    overwrite: boolean | undefined,
    dryRun: boolean,
  ): Promise<void> {
    await this.perform(
      config,
      "materialize_file",
      {
        workspace,
        path: filePath,
        content,
        overwrite,
      },
      dryRun,
    );
  }

  async createAgent(
    config: OpenClawSection,
    agent: AgentDef,
    workspacePath: string,
    dryRun: boolean,
  ): Promise<void> {
    await this.perform(
      config,
      "create_agent",
      {
        agent,
        workspace_path: workspacePath,
      },
      dryRun,
    );
  }

  async installSkill(
    config: OpenClawSection,
    workspace: string,
    agent: string,
    skill: string,
    dryRun: boolean,
  ): Promise<void> {
    await this.perform(
      config,
      "install_skill",
      {
        workspace,
        agent,
        skill,
      },
      dryRun,
    );
  }

  async sendMessage(
    _config: OpenClawSection,
    conversation: ConversationDef,
    content: string,
    _dryRun: boolean,
  ): Promise<void> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const staged = this.stagedMessages.get(key) ?? [];
    staged.push({ content });
    this.stagedMessages.set(key, staged);
  }

  async runAgent(config: OpenClawSection, conversation: ConversationDef, dryRun: boolean): Promise<string> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const staged = this.stagedMessages.get(key) ?? [];
    const prompt = staged.map((m) => `user: ${m.content}`).join("\n");
    const result = await this.perform(
      config,
      "run_agent",
      {
        workspace: conversation.workspace,
        agent: conversation.agent,
        prompt,
      },
      dryRun,
    );
    return result.output ?? result.message ?? "";
  }
}
