import YAML from "js-yaml";
import { ClawChefError } from "./errors.js";
import { importDotEnvFromCwd } from "./env.js";
import { Logger } from "./logger.js";
import { runRecipe } from "./orchestrator.js";
import { loadRecipe, loadRecipeText } from "./recipe.js";
import { recipeSchema } from "./schema.js";
import type { OpenClawProvider, OpenClawRemoteConfig, RunOptions } from "./types.js";

export interface CookOptions {
  vars?: Record<string, string>;
  dryRun?: boolean;
  allowMissing?: boolean;
  verbose?: boolean;
  silent?: boolean;
  provider?: OpenClawProvider;
  remote?: Partial<OpenClawRemoteConfig>;
  loadDotEnvFromCwd?: boolean;
}

function normalizeCookOptions(options: CookOptions): RunOptions {
  return {
    vars: options.vars ?? {},
    dryRun: Boolean(options.dryRun),
    allowMissing: Boolean(options.allowMissing),
    verbose: Boolean(options.verbose),
    silent: options.silent ?? true,
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

export type { OpenClawProvider, OpenClawRemoteConfig };
