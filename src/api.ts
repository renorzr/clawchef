import YAML from "js-yaml";
import { ClawChefError } from "./errors.js";
import { importDotEnvFromCwd, importDotEnvFromRef } from "./env.js";
import { Logger } from "./logger.js";
import { runRecipe } from "./orchestrator.js";
import { loadRecipe, loadRecipeText } from "./recipe.js";
import { scaffoldProject } from "./scaffold.js";
import { recipeSchema } from "./schema.js";
import type { GatewayMode, OpenClawProvider, OpenClawRemoteConfig, RunOptions, RunScope } from "./types.js";
import type { ScaffoldOptions, ScaffoldResult } from "./scaffold.js";

export interface CookOptions {
  vars?: Record<string, string>;
  plugins?: string[];
  dryRun?: boolean;
  allowMissing?: boolean;
  verbose?: boolean;
  silent?: boolean;
  scope?: RunScope;
  workspaceName?: string;
  gatewayMode?: GatewayMode;
  provider?: OpenClawProvider;
  remote?: Partial<OpenClawRemoteConfig>;
  envFile?: string;
  loadDotEnvFromCwd?: boolean;
}

function normalizeCookOptions(options: CookOptions): RunOptions {
  const plugins = Array.from(new Set((options.plugins ?? []).map((value) => value.trim()).filter((value) => value.length > 0)));
  const scope = options.scope ?? "full";
  const workspaceName = options.workspaceName?.trim() || undefined;
  if (scope === "workspace" && !workspaceName) {
    throw new ClawChefError("scope=workspace requires workspaceName");
  }
  if (scope !== "workspace" && workspaceName) {
    throw new ClawChefError("workspaceName is only allowed when scope=workspace");
  }
  return {
    vars: options.vars ?? {},
    plugins,
    scope,
    workspaceName,
    gatewayMode: options.gatewayMode ?? "service",
    dryRun: Boolean(options.dryRun),
    allowMissing: Boolean(options.allowMissing),
    verbose: Boolean(options.verbose),
    silent: options.silent ?? true,
    provider: options.provider ?? "command",
    remote: options.remote ?? {},
  };
}

export async function cook(recipeRef: string, options: CookOptions = {}): Promise<void> {
  if (options.envFile) {
    await importDotEnvFromRef(options.envFile);
  } else if (options.loadDotEnvFromCwd ?? true) {
    importDotEnvFromCwd();
  }

  const runOptions = normalizeCookOptions(options);
  const logger = new Logger(runOptions.verbose);
  const loaded = await loadRecipe(recipeRef, runOptions);
  try {
    await runRecipe(loaded.recipe, loaded.origin, runOptions, logger);
  } finally {
    if (loaded.cleanup) {
      await loaded.cleanup();
    }
  }
}

export async function validate(recipeRef: string): Promise<void> {
  const loaded = await loadRecipeText(recipeRef);
  try {
    const raw = YAML.load(loaded.source);
    const result = recipeSchema.safeParse(raw);
    if (!result.success) {
      throw new ClawChefError(`Validation failed: ${result.error.message}`);
    }
  } finally {
    if (loaded.cleanup) {
      await loaded.cleanup();
    }
  }
}

export async function scaffold(targetDir?: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  return scaffoldProject(targetDir, options);
}

export type { OpenClawProvider, OpenClawRemoteConfig };
export type { ScaffoldOptions, ScaffoldResult };
