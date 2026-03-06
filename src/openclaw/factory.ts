import type { OpenClawSection } from "../types.js";
import { CommandOpenClawProvider } from "./command-provider.js";
import { MockOpenClawProvider } from "./mock-provider.js";
import type { OpenClawProvider } from "./provider.js";

export function createProvider(config: OpenClawSection): OpenClawProvider {
  const provider = config.provider ?? "command";
  if (provider === "mock") {
    return new MockOpenClawProvider();
  }
  return new CommandOpenClawProvider();
}
