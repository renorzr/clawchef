import type { AgentDef, ChannelDef, ConversationDef, OpenClawSection } from "../types.js";
import type { EnsureVersionResult, OpenClawProvider, ResolvedWorkspaceDef } from "./provider.js";

interface MockState {
  installedVersions: Set<string>;
  currentVersion?: string;
  workspaces: Set<string>;
  channels: Set<string>;
  agents: Set<string>;
  skills: Set<string>;
  messages: Map<string, string[]>;
}

export class MockOpenClawProvider implements OpenClawProvider {
  private state: MockState = {
    installedVersions: new Set(),
    workspaces: new Set(),
    channels: new Set(),
    agents: new Set(),
    skills: new Set(),
    messages: new Map(),
  };

  async ensureVersion(config: OpenClawSection, _dryRun: boolean, _silent: boolean): Promise<EnsureVersionResult> {
    const policy = config.install ?? "auto";
    const installed = this.state.installedVersions.has(config.version);
    let installedThisRun = false;

    if (policy === "always") {
      this.state.installedVersions.add(config.version);
      installedThisRun = true;
    } else if (policy === "auto" && !installed) {
      this.state.installedVersions.add(config.version);
      installedThisRun = true;
    } else if (policy === "never" && !installed) {
      throw new Error(`mock: version ${config.version} is not installed`);
    }

    this.state.currentVersion = config.version;
    return { installedThisRun };
  }

  async factoryReset(_config: OpenClawSection, _dryRun: boolean): Promise<void> {
    this.state.workspaces.clear();
    this.state.channels.clear();
    this.state.agents.clear();
    this.state.skills.clear();
    this.state.messages.clear();
  }

  async startGateway(_config: OpenClawSection, _dryRun: boolean): Promise<void> {
    return;
  }

  async createWorkspace(_config: OpenClawSection, workspace: ResolvedWorkspaceDef, _dryRun: boolean): Promise<void> {
    this.state.workspaces.add(workspace.name);
  }

  async configureChannel(_config: OpenClawSection, channel: ChannelDef, _dryRun: boolean): Promise<void> {
    this.state.channels.add(`${channel.channel}::${channel.account ?? "default"}`);
  }

  async loginChannel(_config: OpenClawSection, _channel: ChannelDef, _dryRun: boolean): Promise<void> {
    return;
  }

  async createAgent(
    _config: OpenClawSection,
    agent: AgentDef,
    _workspacePath: string,
    _dryRun: boolean,
  ): Promise<void> {
    this.state.agents.add(`${agent.workspace}::${agent.name}`);
  }

  async installSkill(
    _config: OpenClawSection,
    workspace: string,
    agent: string,
    skill: string,
    _dryRun: boolean,
  ): Promise<void> {
    this.state.skills.add(`${workspace}::${agent}::${skill}`);
  }

  async sendMessage(
    _config: OpenClawSection,
    conversation: ConversationDef,
    content: string,
    _dryRun: boolean,
  ): Promise<void> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const queue = this.state.messages.get(key) ?? [];
    queue.push(`user: ${content}`);
    this.state.messages.set(key, queue);
  }

  async runAgent(_config: OpenClawSection, conversation: ConversationDef, _dryRun: boolean): Promise<string> {
    const key = `${conversation.workspace}::${conversation.agent}`;
    const queue = this.state.messages.get(key) ?? [];
    const last = queue[queue.length - 1] ?? "";
    return `mock-reply -> ${last}`;
  }
}
