import { z } from "zod";

const paramDefSchema = z.object({
  default: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

const openClawCommandsSchema = z
  .object({
    use_version: z.string().optional(),
    install_version: z.string().optional(),
    uninstall_version: z.string().optional(),
    install_plugin: z.string().optional(),
    factory_reset: z.string().optional(),
    start_gateway: z.string().optional(),
    run_gateway: z.string().optional(),
    enable_plugin: z.string().optional(),
    bind_channel_agent: z.string().optional(),
    login_channel: z.string().optional(),
    create_workspace: z.string().optional(),
    create_agent: z.string().optional(),
    install_skill: z.string().optional(),
    send_message: z.string().optional(),
    run_agent: z.string().optional(),
  })
  .strict();

const openClawBootstrapSchema = z
  .object({
    non_interactive: z.boolean().optional(),
    accept_risk: z.boolean().optional(),
    mode: z.enum(["local", "remote"]).optional(),
    flow: z.enum(["quickstart", "advanced", "manual"]).optional(),
    auth_choice: z.string().optional(),
    workspace: z.string().optional(),
    reset: z.boolean().optional(),
    skip_channels: z.boolean().optional(),
    skip_skills: z.boolean().optional(),
    skip_health: z.boolean().optional(),
    skip_ui: z.boolean().optional(),
    skip_daemon: z.boolean().optional(),
    install_daemon: z.boolean().optional(),
    llm_api_key: z.string().optional(),
    cloudflare_ai_gateway_account_id: z.string().optional(),
    cloudflare_ai_gateway_gateway_id: z.string().optional(),
    token: z.string().optional(),
    token_provider: z.string().optional(),
    token_profile_id: z.string().optional(),
  })
  .strict();

const rootFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    content_from: z.string().min(1).optional(),
    source: z.string().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict()
  .refine((v) => [v.content, v.content_from, v.source].filter((item) => item !== undefined).length === 1, {
    message: "openclaw.root.files[] requires exactly one of content, content_from, or source",
  });

const openClawRootSchema = z
  .object({
    path: z.string().min(1).optional(),
    assets: z.string().min(1).optional(),
    files: z.array(rootFileSchema).optional(),
  })
  .strict();

const openClawSchema = z
  .object({
    bin: z.string().optional(),
    version: z.string(),
    install: z.enum(["auto", "always", "never"]).optional(),
    plugins: z.array(z.string().min(1)).optional(),
    root: openClawRootSchema.optional(),
    bootstrap: openClawBootstrapSchema.optional(),
    commands: openClawCommandsSchema.optional(),
  })
  .strict();

const workspaceSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1).optional(),
    assets: z.string().min(1).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            content: z.string().optional(),
            content_from: z.string().min(1).optional(),
            source: z.string().optional(),
            overwrite: z.boolean().optional(),
          })
          .strict()
          .refine((v) => [v.content, v.content_from, v.source].filter((item) => item !== undefined).length === 1, {
            message: "workspaces[].files[] requires exactly one of content, content_from, or source",
          }),
      )
      .optional(),
  })
  .strict();

const channelSchema = z
  .object({
    channel: z.string().min(1),
    account: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    group_policy: z.enum(["open", "allowlist", "disabled"]).optional(),
    login: z.boolean().optional(),
    login_mode: z.enum(["interactive"]).optional(),
    login_account: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    token_file: z.string().min(1).optional(),
    use_env: z.boolean().optional(),
    bot_token: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
    app_token: z.string().min(1).optional(),
    webhook_url: z.string().min(1).optional(),
    webhook_path: z.string().min(1).optional(),
    signal_number: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    extra_flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

const agentSchema = z
  .object({
    workspace: z.string().min(1),
    name: z.string().min(1),
    model: z.string().optional(),
    skills: z.array(z.string().min(1)).optional(),
  })
  .strict();

const conversationExpectSchema = z
  .object({
    contains: z.array(z.string()).optional(),
    not_contains: z.array(z.string()).optional(),
    regex: z.array(z.string()).optional(),
    equals: z.string().optional(),
  })
  .strict();

const messageSchema = z
  .object({
    content: z.string(),
    expect: conversationExpectSchema.optional(),
  })
  .strict();

const conversationSchema = z
  .object({
    workspace: z.string().min(1),
    agent: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    run: z.boolean().optional(),
  })
  .strict();

export const recipeSchema = z
  .object({
    version: z.string().min(1),
    name: z.string().min(1),
    params: z.record(z.string(), paramDefSchema).optional(),
    openclaw: openClawSchema,
    workspaces: z.array(workspaceSchema).optional(),
    channels: z.array(channelSchema).optional(),
    agents: z.array(agentSchema).optional(),
    conversations: z.array(conversationSchema).optional(),
  })
  .strict();

export type RecipeSchema = z.infer<typeof recipeSchema>;
