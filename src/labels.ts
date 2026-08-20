import { runCommand, type CommandResult } from "./process.ts";
import type { Config } from "./types.ts";

type LabelConfig = Pick<Config, "readyLabel" | "claimedLabel" | "completedLabel">;
type CommandRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2]
) => Promise<CommandResult>;

const labelDetails = [
  { key: "readyLabel", color: "0E8A16", description: "Ready for agent orchestration" },
  { key: "claimedLabel", color: "FBCA04", description: "Agent orchestration in progress" },
  { key: "completedLabel", color: "1D76DB", description: "Completed by the agent orchestrator" }
] as const;

export async function ensureGitHubLabels(
  repository: string,
  config: LabelConfig,
  runner: CommandRunner = runCommand
): Promise<string[]> {
  const result = await runner("gh", ["label", "list", "--limit", "1000", "--json", "name"], {
    cwd: repository,
    quiet: true
  });
  const existing = new Set(
    (JSON.parse(result.stdout) as Array<{ name: string }>).map((label) => label.name.toLowerCase())
  );
  const handled = new Set<string>();
  const created: string[] = [];

  for (const details of labelDetails) {
    const name = config[details.key];
    const normalized = name.toLowerCase();
    if (handled.has(normalized) || existing.has(normalized)) continue;
    await runner("gh", [
      "label", "create", name,
      "--color", details.color,
      "--description", details.description
    ], { cwd: repository });
    handled.add(normalized);
    created.push(name);
  }
  return created;
}
