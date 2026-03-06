#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { buildCli } from "./cli.js";
import { ClawChefError } from "./errors.js";

function importDotEnvFromCwd(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const result = loadDotenv({ path: envPath, override: false });
  if (result.error) {
    throw new ClawChefError(`Failed to load .env from current directory: ${result.error.message}`);
  }
}

async function main(): Promise<void> {
  importDotEnvFromCwd();
  const program = buildCli();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof ClawChefError) {
    process.stderr.write(`[ERROR] ${err.message}\n`);
    process.exit(1);
  }
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[FATAL] ${msg}\n`);
  process.exit(1);
});
