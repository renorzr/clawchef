import { ClawChefError } from "./errors.js";
import type { ConversationExpectDef } from "./types.js";

export function validateReply(reply: string, expect?: ConversationExpectDef): void {
  if (!expect) {
    return;
  }

  for (const text of expect.contains ?? []) {
    if (!reply.includes(text)) {
      throw new ClawChefError(`Output assertion failed: must contain -> ${text}`);
    }
  }

  for (const text of expect.not_contains ?? []) {
    if (reply.includes(text)) {
      throw new ClawChefError(`Output assertion failed: must not contain -> ${text}`);
    }
  }

  for (const pattern of expect.regex ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "m");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ClawChefError(`Output assertion failed: invalid regex ${pattern} (${msg})`);
    }
    if (!re.test(reply)) {
      throw new ClawChefError(`Output assertion failed: regex mismatch -> ${pattern}`);
    }
  }

  if (expect.equals !== undefined && reply !== expect.equals) {
    throw new ClawChefError("Output assertion failed: equals mismatch");
  }
}
