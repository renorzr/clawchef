import { Command } from "commander";
import { ClawChefError } from "./errors.js";
import { Logger } from "./logger.js";
import { runRecipe } from "./orchestrator.js";
import { loadRecipe } from "./recipe.js";
import { recipeSchema } from "./schema.js";
import type { RunOptions } from "./types.js";
import YAML from "js-yaml";
import { readFile } from "node:fs/promises";

function parseVarFlags(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values) {
    const idx = item.indexOf("=");
    if (idx <= 0 || idx === item.length - 1) {
      throw new ClawChefError(`Invalid --var format: ${item}. Expected key=value`);
    }
    const k = item.slice(0, idx).trim();
    const v = item.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("clawchef")
    .description("Run OpenClaw environment recipes")
    .version("0.1.0");

  program
    .command("cook")
    .argument("<recipe>", "Recipe YAML path")
    .option("--var <key=value>", "Template variable", (v, p: string[]) => p.concat([v]), [])
    .option("--dry-run", "Print actions without executing", false)
    .option("--allow-missing", "Allow unresolved template variables", false)
    .option("--verbose", "Verbose logging", false)
    .option("-s, --silent", "Skip reset confirmation prompt", false)
    .action(async (recipePath: string, opts) => {
      const options: RunOptions = {
        vars: parseVarFlags(opts.var),
        dryRun: Boolean(opts.dryRun),
        allowMissing: Boolean(opts.allowMissing),
        verbose: Boolean(opts.verbose),
        silent: Boolean(opts.silent),
      };
      const logger = new Logger(options.verbose);
      const recipe = await loadRecipe(recipePath, options);
      await runRecipe(recipe, recipePath, options, logger);
    });

  program
    .command("validate")
    .argument("<recipe>", "Recipe YAML path")
    .action(async (recipePath: string) => {
      const source = await readFile(recipePath, "utf8");
      const raw = YAML.load(source);
      const result = recipeSchema.safeParse(raw);
      if (!result.success) {
        throw new ClawChefError(`Validation failed: ${result.error.message}`);
      }
      process.stdout.write("Recipe structure is valid\n");
    });

  return program;
}
