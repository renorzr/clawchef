import type { AgentDef, ChannelDef, ConversationDef, GatewayMode, OpenClawSection, WorkspaceDef } from "../types.js";

export type ResolvedWorkspaceDef = WorkspaceDef & { path: string };

export interface EnsureVersionResult {
  installedThisRun: boolean;
}

export interface ChannelAgentBinding {
  channel: ChannelDef;
  agent: string;
}

export interface OpenClawProvider {
  ensureVersion(
    config: OpenClawSection,
    dryRun: boolean,
    silent: boolean,
    preserveExistingState: boolean,
  ): Promise<EnsureVersionResult>;
  installPlugin(config: OpenClawSection, pluginSpec: string, dryRun: boolean): Promise<void>;
  factoryReset(config: OpenClawSection, dryRun: boolean): Promise<void>;
  startGateway(config: OpenClawSection, mode: GatewayMode, dryRun: boolean): Promise<void>;
  createWorkspace(config: OpenClawSection, workspace: ResolvedWorkspaceDef, dryRun: boolean): Promise<void>;
  configureChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void>;
  applyConfigPatch(config: OpenClawSection, patch: Record<string, unknown>, dryRun: boolean): Promise<void>;
  bindChannelAgents?(config: OpenClawSection, bindings: ChannelAgentBinding[], dryRun: boolean): Promise<void>;
  bindChannelAgent(config: OpenClawSection, channel: ChannelDef, agent: string, dryRun: boolean): Promise<void>;
  loginChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void>;
  materializeFile?(
    config: OpenClawSection,
    workspace: string,
    filePath: string,
    content: string,
    overwrite: boolean | undefined,
    dryRun: boolean,
  ): Promise<void>;
  createAgent(
    config: OpenClawSection,
    agent: AgentDef,
    workspacePath: string,
    dryRun: boolean,
  ): Promise<void>;
  installSkill(
    config: OpenClawSection,
    workspace: string,
    agent: string,
    skill: string,
    dryRun: boolean,
  ): Promise<void>;
  sendMessage(
    config: OpenClawSection,
    conversation: ConversationDef,
    content: string,
    dryRun: boolean,
  ): Promise<void>;
  runAgent(config: OpenClawSection, conversation: ConversationDef, dryRun: boolean): Promise<string>;
}
