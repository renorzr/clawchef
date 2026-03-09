import { Command } from "commander";
import { ClawChefError } from "./errors.js";
import { Logger } from "./logger.js";
import { runRecipe } from "./orchestrator.js";
import { loadRecipe, loadRecipeText } from "./recipe.js";
import { recipeSchema } from "./schema.js";
import { scaffoldProject } from "./scaffold.js";
import type { RunOptions } from "./types.js";
import YAML from "js-yaml";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

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

function parsePluginFlags(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProvider(value: string): "command" | "mock" | "remote" {
  if (value === "command" || value === "mock" || value === "remote") {
    return value;
  }
  throw new ClawChefError(`Invalid --provider value: ${value}. Expected command, remote, or mock`);
}

function parseOptionalInt(value: string | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ClawChefError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

async function promptProjectName(defaultValue: string): Promise<string> {
  if (!input.isTTY) {
    return defaultValue;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Project name [${defaultValue}]: `);
    const value = answer.trim();
    return value || defaultValue;
  } finally {
    rl.close();
  }
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("clawchef")
    .description("Run OpenClaw environment recipes")
    .version("0.1.0");

  program
    .command("cook")
    .argument("<recipe>", "Recipe path/URL/dir/archive[:file]")
    .option("--var <key=value>", "Template variable", (v, p: string[]) => p.concat([v]), [])
    .option("--dry-run", "Print actions without executing", false)
    .option("--allow-missing", "Allow unresolved template variables", false)
    .option("--verbose", "Verbose logging", false)
    .option("-s, --silent", "Skip reset confirmation prompt", false)
    .option("--provider <provider>", "Execution provider: command | remote | mock")
    .option("--plugin <npm-spec>", "Preinstall plugin package (repeatable)", (v, p: string[]) => p.concat([v]), [])
    .option("--remote-base-url <url>", "Remote OpenClaw API base URL")
    .option("--remote-api-key <key>", "Remote OpenClaw API key")
    .option("--remote-api-header <header>", "Remote auth header name")
    .option("--remote-api-scheme <scheme>", "Remote auth scheme (default: Bearer)")
    .option("--remote-timeout-ms <ms>", "Remote operation timeout in milliseconds")
    .option("--remote-operation-path <path>", "Remote operation endpoint path")
    .action(async (recipeRef: string, opts) => {
      const provider = parseProvider(opts.provider ?? readEnv("CLAWCHEF_PROVIDER") ?? "command");
      const options: RunOptions = {
        vars: parseVarFlags(opts.var),
        plugins: parsePluginFlags(opts.plugin),
        dryRun: Boolean(opts.dryRun),
        allowMissing: Boolean(opts.allowMissing),
        verbose: Boolean(opts.verbose),
        silent: Boolean(opts.silent),
        provider,
        remote: {
          base_url: opts.remoteBaseUrl ?? readEnv("CLAWCHEF_REMOTE_BASE_URL"),
          api_key: opts.remoteApiKey ?? readEnv("CLAWCHEF_REMOTE_API_KEY"),
          api_header: opts.remoteApiHeader ?? readEnv("CLAWCHEF_REMOTE_API_HEADER"),
          api_scheme: opts.remoteApiScheme ?? readEnv("CLAWCHEF_REMOTE_API_SCHEME"),
          timeout_ms: parseOptionalInt(opts.remoteTimeoutMs ?? readEnv("CLAWCHEF_REMOTE_TIMEOUT_MS"), "remote-timeout-ms"),
          operation_path: opts.remoteOperationPath ?? readEnv("CLAWCHEF_REMOTE_OPERATION_PATH"),
        },
      };
      const logger = new Logger(options.verbose);
      const loaded = await loadRecipe(recipeRef, options);
      try {
        await runRecipe(loaded.recipe, loaded.origin, options, logger);
      } finally {
        if (loaded.cleanup) {
          await loaded.cleanup();
        }
      }
    });

  program
    .command("scaffold")
    .argument("[dir]", "Target directory (default: current directory)")
    .option("--name <project-name>", "Project name (default: directory name)")
    .action(async (dir: string | undefined, opts) => {
      const resolvedDir = path.resolve(dir?.trim() ? dir : process.cwd());
      const defaultName = path.basename(resolvedDir);
      const projectName = opts.name?.trim() ? opts.name.trim() : await promptProjectName(defaultName);
      const result = await scaffoldProject(resolvedDir, { projectName });
      process.stdout.write(`Scaffold created at ${result.targetDir}\n`);
      process.stdout.write(`Project name: ${result.projectName}\n`);
      process.stdout.write("Next: run npm install\n");
    });

  program
    .command("validate")
    .argument("<recipe>", "Recipe path/URL/dir/archive[:file]")
    .action(async (recipeRef: string) => {
      const loaded = await loadRecipeText(recipeRef);
      try {
        const raw = YAML.load(loaded.source);
        const result = recipeSchema.safeParse(raw);
        if (!result.success) {
          throw new ClawChefError(`Validation failed: ${result.error.message}`);
        }
        process.stdout.write("Recipe structure is valid\n");
      } finally {
        if (loaded.cleanup) {
          await loaded.cleanup();
        }
      }
    });

  return program;
}
