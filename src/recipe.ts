import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, stat, writeFile, rm, mkdir } from "node:fs/promises";
import YAML from "js-yaml";
import { recipeSchema } from "./schema.js";
import { ClawChefError } from "./errors.js";
import { deepResolveTemplates } from "./template.js";
import type { Recipe, RunOptions } from "./types.js";

export type RecipeOrigin =
  | {
      kind: "local";
      recipePath: string;
      recipeDir: string;
    }
  | {
      kind: "url";
      recipeUrl: string;
    };

export interface LoadedRecipe {
  recipe: Recipe;
  origin: RecipeOrigin;
  cleanup?: () => Promise<void>;
}

export interface LoadedRecipeText {
  source: string;
  cleanup?: () => Promise<void>;
}

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

const DEFAULT_RECIPE_FILE = "recipe.yaml";
const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".zip", ".tar"] as const;

interface ResolvedRecipeReference {
  recipePath: string;
  origin: RecipeOrigin;
  cleanupPaths: string[];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function archiveExtensionFromPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  return ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext));
}

function splitLocalReference(input: string): { base: string; inner: string } | undefined {
  const idx = input.lastIndexOf(":");
  if (idx <= 0 || idx >= input.length - 1) {
    return undefined;
  }
  return {
    base: input.slice(0, idx),
    inner: input.slice(idx + 1),
  };
}

function parseUrlReference(input: string): { archiveUrl: string; inner?: string; directUrl?: string } {
  const parsed = new URL(input);
  const lowerPath = parsed.pathname.toLowerCase();

  for (const ext of ARCHIVE_EXTENSIONS) {
    const marker = `${ext}:`;
    const idx = lowerPath.lastIndexOf(marker);
    if (idx >= 0) {
      const archivePath = parsed.pathname.slice(0, idx + ext.length);
      const inner = parsed.pathname.slice(idx + ext.length + 1);
      const archiveUrl = new URL(input);
      archiveUrl.pathname = archivePath;
      return {
        archiveUrl: archiveUrl.toString(),
        inner,
      };
    }
  }

  const archiveExt = archiveExtensionFromPath(parsed.pathname);
  if (archiveExt) {
    return {
      archiveUrl: parsed.toString(),
    };
  }

  return {
    archiveUrl: "",
    directUrl: parsed.toString(),
  };
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on("data", (buf) => {
      stdoutChunks.push(String(buf));
    });
    child.stderr.on("data", (buf) => {
      stderrChunks.push(String(buf));
    });

    child.on("error", (err) => {
      reject(new ClawChefError(`Failed to run ${command}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join("").trim();
      const stdout = stdoutChunks.join("").trim();
      const details = stderr || stdout || "unknown error";
      reject(new ClawChefError(`Failed to run ${command}: ${details}`));
    });
  });
}

async function extractArchive(archivePath: string, extractDir: string): Promise<void> {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    await runCommand("unzip", ["-oq", archivePath, "-d", extractDir]);
    return;
  }
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    await runCommand("tar", ["-xf", archivePath, "-C", extractDir]);
    return;
  }
  throw new ClawChefError(`Unsupported archive format: ${archivePath}`);
}

async function resolveRecipeReference(recipeInput: string): Promise<ResolvedRecipeReference> {
  if (isHttpUrl(recipeInput)) {
    const parsed = parseUrlReference(recipeInput);
    if (parsed.directUrl) {
      let response: Response;
      try {
        response = await fetch(parsed.directUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ClawChefError(`Failed to fetch recipe URL ${parsed.directUrl}: ${message}`);
      }
      if (!response.ok) {
        throw new ClawChefError(`Failed to fetch recipe URL ${parsed.directUrl}: HTTP ${response.status}`);
      }

      const tempDir = await mkdtemp(path.join(tmpdir(), "clawchef-recipe-"));
      const recipePath = path.join(tempDir, DEFAULT_RECIPE_FILE);
      await writeFile(recipePath, await response.text(), "utf8");

      return {
        recipePath,
        origin: {
          kind: "url",
          recipeUrl: parsed.directUrl,
        },
        cleanupPaths: [tempDir],
      };
    }

    const archiveUrl = parsed.archiveUrl;
    const recipeInArchive = parsed.inner?.trim() || DEFAULT_RECIPE_FILE;
    const tempDir = await mkdtemp(path.join(tmpdir(), "clawchef-recipe-"));
    const archiveExt = archiveExtensionFromPath(new URL(archiveUrl).pathname) ?? ".archive";
    const downloadedArchivePath = path.join(tempDir, `archive${archiveExt}`);

    let response: Response;
    try {
      response = await fetch(archiveUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClawChefError(`Failed to fetch recipe archive URL ${archiveUrl}: ${message}`);
    }
    if (!response.ok) {
      throw new ClawChefError(`Failed to fetch recipe archive URL ${archiveUrl}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(downloadedArchivePath, bytes);

    const extractDir = path.join(tempDir, "extracted");
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await extractArchive(downloadedArchivePath, extractDir);

    const recipePath = path.join(extractDir, recipeInArchive);
    try {
      const s = await stat(recipePath);
      if (!s.isFile()) {
        throw new ClawChefError(`Recipe in archive is not a file: ${recipeInArchive}`);
      }
    } catch {
      throw new ClawChefError(`Recipe file not found in archive: ${recipeInArchive}`);
    }

    return {
      recipePath,
      origin: {
        kind: "local",
        recipePath,
        recipeDir: path.dirname(recipePath),
      },
      cleanupPaths: [tempDir],
    };
  }

  const localPath = path.resolve(recipeInput);
  let localEntry: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    localEntry = await stat(localPath);
  } catch {
    localEntry = undefined;
  }

  if (localEntry?.isDirectory()) {
    const recipePath = path.join(localPath, DEFAULT_RECIPE_FILE);
    return {
      recipePath,
      origin: {
        kind: "local",
        recipePath,
        recipeDir: path.dirname(recipePath),
      },
      cleanupPaths: [],
    };
  }

  if (localEntry?.isFile()) {
    const archiveExt = archiveExtensionFromPath(localPath);
    if (archiveExt) {
      const tempDir = await mkdtemp(path.join(tmpdir(), "clawchef-recipe-"));
      const extractDir = path.join(tempDir, "extracted");
      await mkdir(extractDir, { recursive: true });
      await extractArchive(localPath, extractDir);
      const recipePath = path.join(extractDir, DEFAULT_RECIPE_FILE);
      try {
        const s = await stat(recipePath);
        if (!s.isFile()) {
          throw new ClawChefError(`Recipe in archive is not a file: ${DEFAULT_RECIPE_FILE}`);
        }
      } catch {
        throw new ClawChefError(`Recipe file not found in archive: ${DEFAULT_RECIPE_FILE}`);
      }
      return {
        recipePath,
        origin: {
          kind: "local",
          recipePath,
          recipeDir: path.dirname(recipePath),
        },
        cleanupPaths: [tempDir],
      };
    }

    return {
      recipePath: localPath,
      origin: {
        kind: "local",
        recipePath: localPath,
        recipeDir: path.dirname(localPath),
      },
      cleanupPaths: [],
    };
  }

  const split = splitLocalReference(recipeInput);
  if (!split) {
    throw new ClawChefError(`Recipe not found: ${recipeInput}`);
  }

  const basePath = path.resolve(split.base);
  const selector = split.inner;
  let entry;
  try {
    entry = await stat(basePath);
  } catch {
    throw new ClawChefError(`Recipe base not found: ${split.base}`);
  }

  if (entry.isDirectory()) {
    const recipePath = path.join(basePath, selector);
    return {
      recipePath,
      origin: {
        kind: "local",
        recipePath,
        recipeDir: path.dirname(recipePath),
      },
      cleanupPaths: [],
    };
  }

  if (entry.isFile()) {
    const archiveExt = archiveExtensionFromPath(basePath);
    if (!archiveExt) {
      throw new ClawChefError(`Recipe selector with ':' is only supported for directories or archives: ${recipeInput}`);
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "clawchef-recipe-"));
    const extractDir = path.join(tempDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    await extractArchive(basePath, extractDir);
    const recipePath = path.join(extractDir, selector);
    try {
      const s = await stat(recipePath);
      if (!s.isFile()) {
        throw new ClawChefError(`Recipe in archive is not a file: ${selector}`);
      }
    } catch {
      throw new ClawChefError(`Recipe file not found in archive: ${selector}`);
    }
    return {
      recipePath,
      origin: {
        kind: "local",
        recipePath,
        recipeDir: path.dirname(recipePath),
      },
      cleanupPaths: [tempDir],
    };
  }

  throw new ClawChefError(`Unsupported recipe reference: ${recipeInput}`);
}

async function withResolvedRecipe<T>(
  recipeInput: string,
  fn: (resolved: ResolvedRecipeReference) => Promise<T>,
): Promise<{ result: T; cleanup?: () => Promise<void> }> {
  const resolved = await resolveRecipeReference(recipeInput);
  let shouldCleanup = true;
  const cleanup = async (): Promise<void> => {
    if (!shouldCleanup) {
      return;
    }
    shouldCleanup = false;
    for (const cleanupPath of resolved.cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
  };

  try {
    const result = await fn(resolved);
    if (resolved.cleanupPaths.length === 0) {
      shouldCleanup = false;
      return { result };
    }
    return { result, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function loadRecipeText(recipeRef: string): Promise<LoadedRecipeText> {
  const { result, cleanup } = await withResolvedRecipe(recipeRef, async (resolved) => {
    const source = await readFile(resolved.recipePath, "utf8");
    return { source };
  });

  return {
    source: result.source,
    cleanup,
  };
}

export async function loadRecipe(recipePath: string, options: RunOptions): Promise<LoadedRecipe> {
  const { result, cleanup } = await withResolvedRecipe(recipePath, async (recipeRef) => {
    const source = await readFile(recipeRef.recipePath, "utf8");
    const raw = YAML.load(source);
    const firstParse = recipeSchema.safeParse(raw);
    if (!firstParse.success) {
      throw new ClawChefError(`Recipe format is invalid: ${firstParse.error.message}`);
    }

    assertNoInlineSecrets(firstParse.data);

    const vars = collectVars(firstParse.data, options.vars);
    const rendered = deepResolveTemplates(firstParse.data, vars, options.allowMissing);
    const secondParse = recipeSchema.safeParse(rendered);
    if (!secondParse.success) {
      throw new ClawChefError(`Recipe is invalid after parameter resolution: ${secondParse.error.message}`);
    }

    semanticValidate(secondParse.data);
    return {
      recipe: secondParse.data,
      origin: recipeRef.origin,
    };
  });

  return {
    recipe: result.recipe,
    origin: result.origin,
    cleanup,
  };
}
