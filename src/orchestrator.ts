import path from "node:path";
import { homedir } from "node:os";
import { mkdir, access, copyFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { validateReply } from "./assertions.js";
import { ClawChefError } from "./errors.js";
import { Logger } from "./logger.js";
import { createProvider } from "./openclaw/factory.js";
import type { Recipe, RunOptions } from "./types.js";

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

function resolveWorkspacePath(recipeDir: string, name: string, configuredPath?: string): string {
  if (configuredPath?.trim()) {
    return path.resolve(recipeDir, configuredPath);
  }
  return path.join(homedir(), ".openclaw", "workspaces", name);
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
  recipePath: string,
  options: RunOptions,
  logger: Logger,
): Promise<void> {
  const provider = createProvider(recipe.openclaw);
  const recipeDir = path.dirname(path.resolve(recipePath));
  const workspacePaths = new Map<string, string>();

  logger.info(`Running recipe: ${recipe.name}`);
  const versionResult = await provider.ensureVersion(recipe.openclaw, options.dryRun);
  logger.info(`OpenClaw version ready: ${recipe.openclaw.version}`);

  if (versionResult.installedThisRun) {
    logger.info("OpenClaw was installed in this run; skipping factory reset");
  } else {
    const confirmed = await confirmFactoryReset(options);
    if (!confirmed) {
      throw new ClawChefError("Aborted by user before factory reset");
    }
    await provider.factoryReset(recipe.openclaw, options.dryRun);
    logger.info("Factory reset completed");
  }

  for (const ws of recipe.workspaces ?? []) {
    const absPath = resolveWorkspacePath(recipeDir, ws.name, ws.path);
    workspacePaths.set(ws.name, absPath);
    if (!options.dryRun) {
      await mkdir(absPath, { recursive: true });
    }
    await provider.createWorkspace(recipe.openclaw, { ...ws, path: absPath }, options.dryRun);
    logger.info(`Workspace created: ${ws.name}`);
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
    const target = path.resolve(wsPath, file.path);
    const targetDir = path.dirname(target);

    if (!options.dryRun) {
      await mkdir(targetDir, { recursive: true });
      const alreadyExists = await exists(target);
      if (alreadyExists && file.overwrite === false) {
        logger.warn(`Skipping existing file: ${target}`);
      } else if (file.content !== undefined) {
        await writeFile(target, file.content, "utf8");
      } else if (file.source) {
        const src = path.resolve(recipeDir, file.source);
        await copyFile(src, target);
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
