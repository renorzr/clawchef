import type { AgentDef, ChannelDef, ConversationDef, OpenClawSection, WorkspaceDef } from "../types.js";

export type ResolvedWorkspaceDef = WorkspaceDef & { path: string };

export interface EnsureVersionResult {
  installedThisRun: boolean;
}

export interface OpenClawProvider {
  ensureVersion(config: OpenClawSection, dryRun: boolean): Promise<EnsureVersionResult>;
  factoryReset(config: OpenClawSection, dryRun: boolean): Promise<void>;
  startGateway(config: OpenClawSection, dryRun: boolean): Promise<void>;
  createWorkspace(config: OpenClawSection, workspace: ResolvedWorkspaceDef, dryRun: boolean): Promise<void>;
  configureChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void>;
  loginChannel(config: OpenClawSection, channel: ChannelDef, dryRun: boolean): Promise<void>;
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
