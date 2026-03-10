#!/usr/bin/env node
import { buildCli } from "./cli.js";
import { ClawChefError } from "./errors.js";

async function main(): Promise<void> {
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
