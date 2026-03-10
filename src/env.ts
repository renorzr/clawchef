import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function applyEnv(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function importDotEnvFromRef(ref: string): Promise<void> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new ClawChefError("--env-file cannot be empty");
  }

  if (isHttpUrl(trimmed)) {
    let response: Response;
    try {
      response = await fetch(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClawChefError(`Failed to fetch env file URL ${trimmed}: ${message}`);
    }
    if (!response.ok) {
      throw new ClawChefError(`Failed to fetch env file URL ${trimmed}: HTTP ${response.status}`);
    }
    const content = await response.text();
    applyEnv(parseDotenv(content));
    return;
  }

  const envPath = path.resolve(trimmed);
  let content: string;
  try {
    content = await readFile(envPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ClawChefError(`Failed to load env file ${envPath}: ${message}`);
  }
  applyEnv(parseDotenv(content));
}
