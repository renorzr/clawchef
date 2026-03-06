import { ClawChefError } from "./errors.js";

const TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveTemplate(
  value: string,
  vars: Record<string, string>,
  allowMissing: boolean,
): string {
  return value.replace(TOKEN_RE, (_, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key];
    }
    if (allowMissing) {
      return `\${${key}}`;
    }
    throw new ClawChefError(`Missing parameter: ${key}`);
  });
}

export function deepResolveTemplates<T>(
  input: T,
  vars: Record<string, string>,
  allowMissing: boolean,
): T {
  if (typeof input === "string") {
    return resolveTemplate(input, vars, allowMissing) as T;
  }
  if (Array.isArray(input)) {
    return input.map((v) => deepResolveTemplates(v, vars, allowMissing)) as T;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = deepResolveTemplates(value, vars, allowMissing);
    }
    return out as T;
  }
  return input;
}
