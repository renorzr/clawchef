import type { RunOptions } from "../types.js";
import { CommandOpenClawProvider } from "./command-provider.js";
import { MockOpenClawProvider } from "./mock-provider.js";
import { RemoteOpenClawProvider } from "./remote-provider.js";
import type { OpenClawProvider } from "./provider.js";

export function createProvider(options: RunOptions): OpenClawProvider {
  const provider = options.provider;
  if (provider === "mock") {
    return new MockOpenClawProvider();
  }
  if (provider === "remote") {
    return new RemoteOpenClawProvider(options.remote);
  }
  return new CommandOpenClawProvider();
}
