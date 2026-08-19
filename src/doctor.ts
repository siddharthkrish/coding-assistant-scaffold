import { existsSync } from "node:fs";
import { commandExists, runCommand } from "./process.ts";
import type { Config } from "./types.ts";

export async function doctor(config: Config): Promise<boolean> {
  const checks: Array<[string, boolean, string]> = [];
  for (const command of ["git", "gh", "claude", "codex"]) {
    checks.push([command, await commandExists(command), `Install and authenticate ${command}`]);
  }
  checks.push(["repository", existsSync(config.repository), `Path not found: ${config.repository}`]);
  if (existsSync(config.repository)) {
    try {
      await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: config.repository, quiet: true });
      checks.push(["git repository", true, ""]);
    } catch {
      checks.push(["git repository", false, "Target path is not a Git worktree"]);
    }
    try {
      await runCommand("gh", ["auth", "status"], { cwd: config.repository, quiet: true });
      checks.push(["GitHub authentication", true, ""]);
    } catch {
      checks.push(["GitHub authentication", false, "Run gh auth login"]);
    }
  }
  for (const [name, ok, hint] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}${ok || !hint ? "" : ` — ${hint}`}`);
  }
  return checks.every(([, ok]) => ok);
}
