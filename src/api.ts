import YAML from "js-yaml";
import { ClawChefError } from "./errors.js";
import { importDotEnvFromCwd } from "./env.js";
import { Logger } from "./logger.js";
import { runRecipe } from "./orchestrator.js";
import { loadRecipe, loadRecipeText } from "./recipe.js";
import { scaffoldProject } from "./scaffold.js";
import { recipeSchema } from "./schema.js";
import type { OpenClawProvider, OpenClawRemoteConfig, RunOptions } from "./types.js";
import type { ScaffoldOptions, ScaffoldResult } from "./scaffold.js";

export interface CookOptions {
  vars?: Record<string, string>;
  plugins?: string[];
  dryRun?: boolean;
  allowMissing?: boolean;
  verbose?: boolean;
  silent?: boolean;
  provider?: OpenClawProvider;
  remote?: Partial<OpenClawRemoteConfig>;
  loadDotEnvFromCwd?: boolean;
}

function normalizeCookOptions(options: CookOptions): RunOptions {
  const plugins = Array.from(new Set((options.plugins ?? []).map((value) => value.trim()).filter((value) => value.length > 0)));
  return {
    vars: options.vars ?? {},
    plugins,
    dryRun: Boolean(options.dryRun),
    allowMissing: Boolean(options.allowMissing),
    verbose: Boolean(options.verbose),
    silent: options.silent ?? true,
    keepOpenClawState: false,
    provider: options.provider ?? "command",
    remote: options.remote ?? {},
  };
}

export async function cook(recipeRef: string, options: CookOptions = {}): Promise<void> {
  if (options.loadDotEnvFromCwd ?? true) {
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
