export type InstallPolicy = "auto" | "always" | "never";
export type OpenClawProvider = "command" | "mock" | "remote";
export type RunScope = "full" | "files" | "workspace";

export interface OpenClawRemoteConfig {
  base_url: string;
  api_key?: string;
  api_header?: string;
  api_scheme?: string;
  timeout_ms?: number;
  operation_path?: string;
}

export interface ParamDef {
  default?: string;
  required?: boolean;
  description?: string;
}

export interface OpenClawCommandOverrides {
  use_version?: string;
  install_version?: string;
  uninstall_version?: string;
  install_plugin?: string;
  factory_reset?: string;
  start_gateway?: string;
  enable_plugin?: string;
  login_channel?: string;
  create_workspace?: string;
  create_agent?: string;
  install_skill?: string;
  send_message?: string;
  run_agent?: string;
}

export interface OpenClawBootstrap {
  non_interactive?: boolean;
  accept_risk?: boolean;
  mode?: "local" | "remote";
  flow?: "quickstart" | "advanced" | "manual";
  auth_choice?: string;
  workspace?: string;
  reset?: boolean;
  skip_channels?: boolean;
  skip_skills?: boolean;
  skip_health?: boolean;
  skip_ui?: boolean;
  skip_daemon?: boolean;
  install_daemon?: boolean;
  llm_api_key?: string;
  cloudflare_ai_gateway_account_id?: string;
  cloudflare_ai_gateway_gateway_id?: string;
  token?: string;
  token_provider?: string;
  token_profile_id?: string;
}

export interface OpenClawSection {
  bin?: string;
  version: string;
  install?: InstallPolicy;
  plugins?: string[];
  bootstrap?: OpenClawBootstrap;
  commands?: OpenClawCommandOverrides;
}

export interface WorkspaceDef {
  name: string;
  path?: string;
  assets?: string;
  files?: WorkspaceFileDef[];
}

export interface ChannelDef {
  channel: string;
  account?: string;
  login?: boolean;
  login_mode?: "interactive";
  login_account?: string;
  name?: string;
  token?: string;
  token_file?: string;
  use_env?: boolean;
  bot_token?: string;
  access_token?: string;
  app_token?: string;
  webhook_url?: string;
  webhook_path?: string;
  signal_number?: string;
  password?: string;
  extra_flags?: Record<string, string | number | boolean>;
}

export interface AgentDef {
  workspace: string;
  name: string;
  model?: string;
  skills?: string[];
}

export interface WorkspaceFileDef {
  path: string;
  content?: string;
  content_from?: string;
  source?: string;
  overwrite?: boolean;
}

export interface MessageDef {
  content: string;
  expect?: ConversationExpectDef;
}

export interface ConversationExpectDef {
  contains?: string[];
  not_contains?: string[];
  regex?: string[];
  equals?: string;
}

export interface ConversationDef {
  workspace: string;
  agent: string;
  messages: MessageDef[];
  run?: boolean;
}

export interface Recipe {
  version: string;
  name: string;
  params?: Record<string, ParamDef>;
  openclaw: OpenClawSection;
  workspaces?: WorkspaceDef[];
  channels?: ChannelDef[];
  agents?: AgentDef[];
  conversations?: ConversationDef[];
}

export interface RunOptions {
  vars: Record<string, string>;
  plugins: string[];
  scope: RunScope;
  workspaceName?: string;
  dryRun: boolean;
  allowMissing: boolean;
  verbose: boolean;
  silent: boolean;
  provider: OpenClawProvider;
  remote: Partial<OpenClawRemoteConfig>;
}
