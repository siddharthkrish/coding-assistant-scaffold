import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runCommand } from "./process.ts";

export type ProjectInfo = {
  root: string;
  name: string;
  baseBranch: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  testCommand: string;
  hasPackageJson: boolean;
};

export async function discoverProject(start = process.cwd()): Promise<ProjectInfo> {
  const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(start), quiet: true });
  const root = rootResult.stdout.trim();
  const packageManager = detectPackageManager(root);
  return {
    root,
    name: basename(root),
    baseBranch: await detectBaseBranch(root),
    packageManager,
    testCommand: detectTestCommand(root) ?? "auto",
    hasPackageJson: existsSync(resolve(root, "package.json"))
  };
}

async function detectBaseBranch(root: string): Promise<string> {
  const remote = await runCommand("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: root, quiet: true, allowNonZero: true
  });
  if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, "");
  const current = await runCommand("git", ["branch", "--show-current"], { cwd: root, quiet: true });
  return current.stdout.trim() || "main";
}

function detectPackageManager(root: string): ProjectInfo["packageManager"] {
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(root, "bun.lock")) || existsSync(resolve(root, "bun.lockb"))) return "bun";
  const packagePath = resolve(root, "package.json");
  if (existsSync(packagePath)) {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    const declared = String(manifest.packageManager ?? "").split("@")[0];
    if (["npm", "pnpm", "yarn", "bun"].includes(declared)) {
      return declared as NonNullable<ProjectInfo["packageManager"]>;
    }
    return "npm";
  }
  return null;
}

export function detectTestCommand(root: string): string | null {
  const packageManager = detectPackageManager(root);
  const packagePath = resolve(root, "package.json");
  if (existsSync(packagePath)) {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (manifest.scripts?.test && !String(manifest.scripts.test).includes("no test specified")) {
      if (packageManager === "pnpm") return "pnpm test";
      if (packageManager === "yarn") return "yarn test";
      if (packageManager === "bun") return "bun test";
      return "npm test";
    }
  }
  if (existsSync(resolve(root, "pyproject.toml"))) {
    return existsSync(resolve(root, "uv.lock")) ? "uv run pytest" : "pytest";
  }
  if (existsSync(resolve(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(resolve(root, "go.mod"))) return "go test ./...";
  return null;
}
