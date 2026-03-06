import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import YAML from "js-yaml";
import { recipeSchema } from "./schema.js";
import { ClawChefError } from "./errors.js";
import { deepResolveTemplates } from "./template.js";
import type { Recipe, RunOptions } from "./types.js";

const AUTH_CHOICE_TO_FIELD: Record<string, string> = {
  "openai-api-key": "openai_api_key",
  "anthropic-api-key": "anthropic_api_key",
  "openrouter-api-key": "openrouter_api_key",
  "xai-api-key": "xai_api_key",
  "gemini-api-key": "gemini_api_key",
  "ai-gateway-api-key": "ai_gateway_api_key",
  "cloudflare-ai-gateway-api-key": "cloudflare_ai_gateway_api_key",
  token: "token",
};

const SECRET_BOOTSTRAP_FIELDS = [
  "openai_api_key",
  "anthropic_api_key",
  "openrouter_api_key",
  "xai_api_key",
  "gemini_api_key",
  "ai_gateway_api_key",
  "cloudflare_ai_gateway_api_key",
  "token",
] as const;

const ALLOWED_CHANNELS = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "feishu",
  "nostr",
  "msteams",
  "mattermost",
  "nextcloud-talk",
  "matrix",
  "bluebubbles",
  "line",
  "zalo",
  "zalouser",
  "tlon",
]);

const CHANNEL_SECRET_FIELDS = ["token", "bot_token", "access_token", "app_token", "password"] as const;

const TEMPLATE_TOKEN_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

function assertNoInlineSecrets(recipe: Recipe): void {
  const bootstrap = recipe.openclaw.bootstrap;
  if (bootstrap) {
    for (const field of SECRET_BOOTSTRAP_FIELDS) {
      const value = bootstrap[field];
      if (!value) {
        continue;
      }
      if (!TEMPLATE_TOKEN_RE.test(value)) {
        throw new ClawChefError(
          `Inline secret in openclaw.bootstrap.${field} is not allowed. Use \${var} and pass it via --var or CLAWCHEF_VAR_*`,
        );
      }
    }
  }

  for (const channel of recipe.channels ?? []) {
    for (const field of CHANNEL_SECRET_FIELDS) {
      const value = channel[field];
      if (!value) {
        continue;
      }
      if (!TEMPLATE_TOKEN_RE.test(value)) {
        throw new ClawChefError(
          `Inline secret in channels[].${field} is not allowed. Use \${var} and pass it via --var or CLAWCHEF_VAR_*`,
        );
      }
    }

    for (const [key, value] of Object.entries(channel.extra_flags ?? {})) {
      if (typeof value !== "string") {
        continue;
      }
      if (!/(token|password|secret|api[_-]?key)/i.test(key)) {
        continue;
      }
      if (!TEMPLATE_TOKEN_RE.test(value)) {
        throw new ClawChefError(
          `Inline secret in channels[].extra_flags.${key} is not allowed. Use \${var} and pass it via --var or CLAWCHEF_VAR_*`,
        );
      }
    }
  }
}

function collectVars(recipe: Recipe, cliVars: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  const params = recipe.params ?? {};

  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith("CLAWCHEF_VAR_") || envValue === undefined) {
      continue;
    }
    const suffix = envKey.slice("CLAWCHEF_VAR_".length).trim();
    if (!suffix) {
      continue;
    }
    vars[suffix.toLowerCase()] = envValue;
  }

  for (const [key, def] of Object.entries(params)) {
    const envKey = `CLAWCHEF_VAR_${key.toUpperCase()}`;
    const envValue = process.env[envKey];

    if (Object.prototype.hasOwnProperty.call(cliVars, key)) {
      vars[key] = cliVars[key];
      continue;
    }
    if (envValue !== undefined) {
      vars[key] = envValue;
      continue;
    }
    if (def.default !== undefined) {
      vars[key] = def.default;
      continue;
    }
    if (def.required) {
      throw new ClawChefError(`Parameter ${key} is required but was not provided via --var or environment`);
    }
  }

  for (const [k, v] of Object.entries(cliVars)) {
    vars[k] = v;
  }

  return vars;
}

function semanticValidate(recipe: Recipe): void {
  const ws = new Set((recipe.workspaces ?? []).map((w) => w.name));
  for (const agent of recipe.agents ?? []) {
    if (!ws.has(agent.workspace)) {
      throw new ClawChefError(`Agent ${agent.name} references missing workspace: ${agent.workspace}`);
    }
  }
  for (const file of recipe.files ?? []) {
    if (!ws.has(file.workspace)) {
      throw new ClawChefError(`File ${file.path} references missing workspace: ${file.workspace}`);
    }
  }
  const agents = new Set((recipe.agents ?? []).map((a) => `${a.workspace}::${a.name}`));
  for (const conv of recipe.conversations ?? []) {
    if (!ws.has(conv.workspace)) {
      throw new ClawChefError(`Conversation references missing workspace: ${conv.workspace}`);
    }
    if (!agents.has(`${conv.workspace}::${conv.agent}`)) {
      throw new ClawChefError(
        `Conversation references missing agent: ${conv.agent} (workspace: ${conv.workspace})`,
      );
    }
  }

  for (const channel of recipe.channels ?? []) {
    if (!ALLOWED_CHANNELS.has(channel.channel)) {
      throw new ClawChefError(
        `Unsupported channel: ${channel.channel}. Allowed: ${Array.from(ALLOWED_CHANNELS).join(", ")}`,
      );
    }

    const hasAuth =
      Boolean(channel.use_env) ||
      Boolean(channel.token?.trim()) ||
      Boolean(channel.token_file?.trim()) ||
      Boolean(channel.bot_token?.trim()) ||
      Boolean(channel.access_token?.trim()) ||
      Boolean(channel.app_token?.trim()) ||
      Boolean(channel.password?.trim()) ||
      Boolean(channel.webhook_url?.trim()) ||
      Object.entries(channel.extra_flags ?? {}).some(([key, value]) => {
        if (typeof value === "boolean") {
          return false;
        }
        return /(token|password|secret|api[_-]?key|webhook)/i.test(key) && String(value).trim().length > 0;
      });

    if (!hasAuth) {
      throw new ClawChefError(
        `channels[] entry for ${channel.channel} requires at least one auth input (for example token/bot_token/access_token/token_file/use_env)`,
      );
    }
  }

  const bootstrap = recipe.openclaw.bootstrap;
  const authChoice = bootstrap?.auth_choice;
  if (authChoice) {
    const requiredField = AUTH_CHOICE_TO_FIELD[authChoice];
    if (requiredField) {
      const value = (bootstrap as Record<string, string | undefined>)[requiredField];
      if (!value || !value.trim()) {
        throw new ClawChefError(
          `openclaw.bootstrap.auth_choice=${authChoice} requires openclaw.bootstrap.${requiredField}`,
        );
      }
    }
    if (authChoice === "token") {
      if (!bootstrap?.token_provider || !bootstrap.token_profile_id) {
        throw new ClawChefError(
          "openclaw.bootstrap.auth_choice=token requires token_provider and token_profile_id",
        );
      }
    }
  }
}

export async function loadRecipe(recipePath: string, options: RunOptions): Promise<Recipe> {
  const absoluteRecipePath = path.resolve(recipePath);
  const source = await readFile(absoluteRecipePath, "utf8");
  const raw = YAML.load(source);
  const firstParse = recipeSchema.safeParse(raw);
  if (!firstParse.success) {
    throw new ClawChefError(`Recipe format is invalid: ${firstParse.error.message}`);
  }

  assertNoInlineSecrets(firstParse.data);

  const vars = collectVars(firstParse.data, options.vars);
  const resolved = deepResolveTemplates(firstParse.data, vars, options.allowMissing);
  const secondParse = recipeSchema.safeParse(resolved);
  if (!secondParse.success) {
    throw new ClawChefError(`Recipe is invalid after parameter resolution: ${secondParse.error.message}`);
  }

  semanticValidate(secondParse.data);
  return secondParse.data;
}
