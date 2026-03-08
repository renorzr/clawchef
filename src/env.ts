import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { ClawChefError } from "./errors.js";

export function importDotEnvFromCwd(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const result = loadDotenv({ path: envPath, override: false });
  if (result.error) {
    throw new ClawChefError(`Failed to load .env from current directory: ${result.error.message}`);
  }
}
