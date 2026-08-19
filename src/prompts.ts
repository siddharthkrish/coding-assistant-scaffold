import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./types.ts";

export function renderPrompt(
  config: Config,
  name: string,
  values: Record<string, string>,
  fallback: string
): string {
  const customPath = resolve(config.repository, ".agent-orchestrator", "prompts", `${name}.md`);
  let source = existsSync(customPath) ? readFileSync(customPath, "utf8") : fallback;
  for (const [key, value] of Object.entries(values)) {
    source = source.replaceAll(`{{${key}}}`, value);
  }
  return source;
}
