import path from "node:path";
import { homedir } from "node:os";
import { mkdir, access, copyFile, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateReply } from "./assertions.js";
import { ClawChefError } from "./errors.js";
import { Logger } from "./logger.js";
import { createProvider } from "./openclaw/factory.js";
import type { Recipe, RunOptions } from "./types.js";
import type { RecipeOrigin } from "./recipe.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function truncateForLog(text: string, maxLength = 500): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function resolveWorkspacePath(recipeOrigin: RecipeOrigin, name: string, configuredPath?: string): string {
  if (configuredPath?.trim()) {
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }
    if (recipeOrigin.kind === "local") {
      return path.resolve(recipeOrigin.recipeDir, configuredPath);
    }
    return path.resolve(configuredPath);
  }
  const trimmedName = name.trim() || name;
  const workspaceName = trimmedName.startsWith("workspace-") ? trimmedName : `workspace-${trimmedName}`;
  return path.join(homedir(), ".openclaw", workspaceName);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveFileRef(recipeOrigin: RecipeOrigin, reference: string): { kind: "local" | "url"; value: string } {
  if (isHttpUrl(reference)) {
    return { kind: "url", value: reference };
  }
  if (path.isAbsolute(reference)) {
    return { kind: "local", value: reference };
  }
  if (recipeOrigin.kind === "local") {
    return { kind: "local", value: path.resolve(recipeOrigin.recipeDir, reference) };
  }
  return { kind: "url", value: new URL(reference, recipeOrigin.recipeUrl).toString() };
}

async function readTextFromRef(recipeOrigin: RecipeOrigin, reference: string): Promise<string> {
  const resolved = resolveFileRef(recipeOrigin, reference);
  if (resolved.kind === "local") {
    return readFile(resolved.value, "utf8");
  }
  const response = await fetch(resolved.value);
  if (!response.ok) {
    throw new ClawChefError(`Failed to fetch file content from ${resolved.value}: HTTP ${response.status}`);
  }
  return response.text();
}

async function readBinaryFromRef(recipeOrigin: RecipeOrigin, reference: string): Promise<Buffer> {
  const resolved = resolveFileRef(recipeOrigin, reference);
  if (resolved.kind === "local") {
    return readFile(resolved.value);
  }
  const response = await fetch(resolved.value);
  if (!response.ok) {
    throw new ClawChefError(`Failed to fetch file source from ${resolved.value}: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

interface LocalAssetFile {
  absolutePath: string;
  relativePath: string;
}

async function collectLocalAssetFiles(rootDir: string, relDir = ""): Promise<LocalAssetFile[]> {
  const currentDir = relDir ? path.join(rootDir, relDir) : rootDir;
  const entries = await readdir(currentDir, { withFileTypes: true });
  const out: LocalAssetFile[] = [];

  for (const entry of entries) {
    const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...await collectLocalAssetFiles(rootDir, nextRel));
      continue;
    }
    if (entry.isFile()) {
      out.push({
        absolutePath: path.join(rootDir, nextRel),
        relativePath: nextRel,
      });
      continue;
    }
    throw new ClawChefError(`Unsupported entry in assets directory: ${path.join(rootDir, nextRel)}`);
  }

  return out;
}

async function confirmFactoryReset(options: RunOptions): Promise<boolean> {
  if (options.silent || options.dryRun) {
    return true;
  }
  if (!input.isTTY) {
    throw new ClawChefError("Reset confirmation requires an interactive terminal. Use --silent to skip prompt.");
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "This run will factory-reset existing OpenClaw state before execution. Continue? [y/N] ",
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export async function runRecipe(
  recipe: Recipe,
  recipeOrigin: RecipeOrigin,
  options: RunOptions,
  logger: Logger,
): Promise<void> {
  const provider = createProvider(options);
  const remoteMode = options.provider === "remote";
  const workspacePaths = new Map<string, string>();

  logger.info(`Running recipe: ${recipe.name}`);
  const versionResult = await provider.ensureVersion(
    recipe.openclaw,
    options.dryRun,
    options.silent,
    options.keepOpenClawState,
  );
  logger.info(`OpenClaw version ready: ${recipe.openclaw.version}`);

  if (versionResult.installedThisRun) {
    logger.info("OpenClaw was installed in this run; skipping factory reset");
  } else if (options.keepOpenClawState) {
    logger.info("Keeping existing OpenClaw state; skipping factory reset");
  } else {
    const confirmed = await confirmFactoryReset(options);
    if (!confirmed) {
      throw new ClawChefError("Aborted by user before factory reset");
    }
    await provider.factoryReset(recipe.openclaw, options.dryRun);
    logger.info("Factory reset completed");
  }

  const pluginSpecs = Array.from(new Set([...(recipe.openclaw.plugins ?? []), ...options.plugins].map((v) => v.trim())))
    .filter((v) => v.length > 0);
  for (const pluginSpec of pluginSpecs) {
    await provider.installPlugin(recipe.openclaw, pluginSpec, options.dryRun);
    logger.info(`Plugin preinstalled: ${pluginSpec}`);
  }

  for (const ws of recipe.workspaces ?? []) {
    const absPath = resolveWorkspacePath(recipeOrigin, ws.name, ws.path);
    workspacePaths.set(ws.name, absPath);
    if (!options.dryRun && !remoteMode) {
      await mkdir(absPath, { recursive: true });
    }
    await provider.createWorkspace(recipe.openclaw, { ...ws, path: absPath }, options.dryRun);
    logger.info(`Workspace created: ${ws.name}`);

    if (!ws.assets?.trim()) {
      continue;
    }

    const resolvedAssets = resolveFileRef(recipeOrigin, ws.assets);
    if (resolvedAssets.kind !== "local") {
      throw new ClawChefError(
        `Workspace assets must resolve to a local directory: ${ws.assets}. Direct URL recipes cannot use workspaces[].assets.`,
      );
    }

    let assetDirStat;
    try {
      assetDirStat = await stat(resolvedAssets.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClawChefError(`Workspace assets path is not accessible: ${resolvedAssets.value} (${message})`);
    }
    if (!assetDirStat.isDirectory()) {
      throw new ClawChefError(`Workspace assets must be a directory: ${resolvedAssets.value}`);
    }

    const assetFiles = await collectLocalAssetFiles(resolvedAssets.value);
    for (const assetFile of assetFiles) {
      if (provider.materializeFile) {
        const content = await readFile(assetFile.absolutePath, "utf8");
        await provider.materializeFile(
          recipe.openclaw,
          ws.name,
          assetFile.relativePath,
          content,
          true,
          options.dryRun,
        );
      } else {
        const target = path.resolve(absPath, assetFile.relativePath);
        if (!options.dryRun) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(assetFile.absolutePath, target);
        }
      }
      logger.info(`Workspace asset copied: ${ws.name}/${assetFile.relativePath}`);
    }
  }

  for (const agent of recipe.agents ?? []) {
    const workspacePath = workspacePaths.get(agent.workspace);
    if (!workspacePath) {
      throw new ClawChefError(`Agent references missing workspace: ${agent.workspace}`);
    }
    await provider.createAgent(recipe.openclaw, agent, workspacePath, options.dryRun);
    logger.info(`Agent created: ${agent.workspace}/${agent.name}`);
  }

  for (const channel of recipe.channels ?? []) {
    await provider.configureChannel(recipe.openclaw, channel, options.dryRun);
    logger.info(`Channel configured: ${channel.channel}${channel.account ? `/${channel.account}` : ""}`);
  }

  for (const file of recipe.files ?? []) {
    const wsPath = workspacePaths.get(file.workspace);
    if (!wsPath) {
      throw new ClawChefError(`File target workspace does not exist: ${file.workspace}`);
    }

    if (provider.materializeFile) {
      let content = file.content;
      if (content === undefined && file.content_from) {
        if (!options.dryRun) {
          content = await readTextFromRef(recipeOrigin, file.content_from);
        } else {
          const resolved = resolveFileRef(recipeOrigin, file.content_from);
          content = `__dry_run_content_from__:${resolved.value}`;
        }
      }
      if (content === undefined && file.source) {
        if (!options.dryRun) {
          content = await readTextFromRef(recipeOrigin, file.source);
        } else {
          const resolved = resolveFileRef(recipeOrigin, file.source);
          content = `__dry_run_source__:${resolved.value}`;
        }
      }
      if (content === undefined) {
        throw new ClawChefError(`File ${file.path} requires content, content_from, or source`);
      }

      await provider.materializeFile(recipe.openclaw, file.workspace, file.path, content, file.overwrite, options.dryRun);
      logger.info(`File materialized: ${file.workspace}/${file.path}`);
      continue;
    }

    const target = path.resolve(wsPath, file.path);
    const targetDir = path.dirname(target);

    if (!options.dryRun) {
      await mkdir(targetDir, { recursive: true });
      const alreadyExists = await exists(target);
      if (alreadyExists && file.overwrite === false) {
        logger.warn(`Skipping existing file: ${target}`);
      } else if (file.content !== undefined) {
        await writeFile(target, file.content, "utf8");
      } else if (file.content_from) {
        const content = await readTextFromRef(recipeOrigin, file.content_from);
        await writeFile(target, content, "utf8");
      } else if (file.source) {
        const resolved = resolveFileRef(recipeOrigin, file.source);
        if (resolved.kind === "local") {
          await copyFile(resolved.value, target);
        } else {
          const content = await readBinaryFromRef(recipeOrigin, file.source);
          await writeFile(target, content);
        }
      }
    }
    logger.info(`File materialized: ${file.workspace}/${file.path}`);
  }

  for (const agent of recipe.agents ?? []) {
    for (const skill of agent.skills ?? []) {
      await provider.installSkill(recipe.openclaw, agent.workspace, agent.name, skill, options.dryRun);
      logger.info(`Skill installed: ${agent.workspace}/${agent.name} -> ${skill}`);
    }
  }

  for (const conv of recipe.conversations ?? []) {
    for (const msg of conv.messages) {
      await provider.sendMessage(recipe.openclaw, conv, msg.content, options.dryRun);

      const shouldRun = conv.run ?? Boolean(msg.expect);
      if (shouldRun) {
        if (options.dryRun) {
          logger.info(`dry-run: skipping execution and output assertions: ${conv.workspace}/${conv.agent}`);
          continue;
        }
        const reply = await provider.runAgent(recipe.openclaw, conv, options.dryRun);
        if (msg.expect) {
          try {
            validateReply(reply, msg.expect);
            logger.info(`Output assertions passed: ${conv.workspace}/${conv.agent}`);
          } catch (err) {
            logger.warn(
              `Assertion failed reply (truncated): ${truncateForLog(reply)}`,
            );
            throw err;
          }
        } else {
          logger.info(`Agent executed: ${conv.workspace}/${conv.agent}`);
        }
        logger.debug(`Agent output: ${reply}`);
      }
    }
    logger.info(`Preset messages sent: ${conv.workspace}/${conv.agent}`);
  }

  await provider.startGateway(recipe.openclaw, options.dryRun);
  logger.info("Gateway started");

  for (const channel of recipe.channels ?? []) {
    if (!channel.login) {
      continue;
    }
    if (!options.dryRun && !input.isTTY) {
      throw new ClawChefError(
        `Channel login for ${channel.channel} requires an interactive terminal session`,
      );
    }
    await provider.loginChannel(recipe.openclaw, channel, options.dryRun);
    logger.info(`Channel login completed: ${channel.channel}${channel.account ? `/${channel.account}` : ""}`);
  }

  logger.info("Recipe execution completed");
}
