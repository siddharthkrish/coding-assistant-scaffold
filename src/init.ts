import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configDirectory, configFileName } from "./config.ts";
import { ensureGitHubLabels } from "./labels.ts";
import { runCommand } from "./process.ts";
import { discoverProject, type ProjectInfo } from "./project.ts";

type PackageManifest = { name: string; version: string };

const packageRoot = resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as PackageManifest;

export type InitOptions = {
  directory?: string;
  force?: boolean;
  install?: boolean;
  labels?: boolean;
  createPackageJson?: boolean;
};

export type InitResult = {
  project: ProjectInfo;
  configPath: string;
  installed: boolean;
  labelsCreated: string[] | null;
  packageJsonCreated: boolean;
};

export async function initializeProject(options: InitOptions = {}): Promise<InitResult> {
  let project = await discoverProject(options.directory ?? process.cwd());
  const settingsDirectory = resolve(project.root, configDirectory);
  const configPath = resolve(settingsDirectory, configFileName);
  if (existsSync(configPath) && !options.force) {
    throw new Error(`${configPath} already exists; use --force to replace it`);
  }

  const template = JSON.parse(readFileSync(resolve(packageRoot, "templates", "config.json"), "utf8"));
  const labelsCreated = options.labels === false
    ? null
    : await ensureGitHubLabels(project.root, template);
  const packageJsonCreated = !project.hasPackageJson && options.createPackageJson === true;
  if (packageJsonCreated) {
    createToolingPackageJson(project.root, project.name);
    project = await discoverProject(project.root);
  }
  const config = { ...template, baseBranch: project.baseBranch, testCommand: project.testCommand };
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  updateGitignore(project.root);
  let installed = false;
  if (project.hasPackageJson) {
    addPackageScripts(project.root);
    if (options.install !== false) installed = await installPackage(project);
  }
  return { project, configPath, installed, labelsCreated, packageJsonCreated };
}

export function ejectPrompts(repository: string, force = false): string[] {
  const destination = resolve(repository, configDirectory, "prompts");
  mkdirSync(destination, { recursive: true });
  const names = ["implement", "review", "fix", "ci-fix"];
  const written: string[] = [];
  for (const name of names) {
    const target = resolve(destination, `${name}.md`);
    if (existsSync(target) && !force) continue;
    const source = resolve(packageRoot, "templates", "prompts", `${name}.md`);
    writeFileSync(target, readFileSync(source, "utf8"));
    written.push(target);
  }
  return written;
}

function updateGitignore(root: string): void {
  const path = resolve(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const entries = [
    ".agent-orchestrator/*.sqlite*",
    ".agent-orchestrator/reviews/",
    ".agent-orchestrator/logs/",
    ".agent-orchestrator/artifacts/",
    ".agent-orchestrator/last-checks.txt"
  ];
  const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (!missing.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${missing.join("\n")}\n`);
}

function addPackageScripts(root: string): void {
  const path = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.scripts = {
    ...manifest.scripts,
    agents: "agent-orchestrator start",
    "agents:once": "agent-orchestrator run",
    "agents:doctor": "agent-orchestrator doctor",
    "agents:status": "agent-orchestrator status",
    "agents:logs": "agent-orchestrator logs"
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function createToolingPackageJson(root: string, repositoryName: string): void {
  const normalized = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  const manifest = {
    name: `${normalized || "repository"}-tooling`,
    private: true
  };
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installPackage(project: ProjectInfo): Promise<boolean> {
  const manifest = JSON.parse(readFileSync(resolve(project.root, "package.json"), "utf8"));
  if (manifest.name === packageManifest.name) return false;
  if (manifest.dependencies?.[packageManifest.name] || manifest.devDependencies?.[packageManifest.name]) return false;
  const spec = `${packageManifest.name}@${packageManifest.version}`;
  const commands: Record<NonNullable<ProjectInfo["packageManager"]>, [string, string[]]> = {
    npm: ["npm", ["install", "--save-dev", "--save-exact", spec]],
    pnpm: ["pnpm", ["add", "--save-dev", "--save-exact", spec]],
    yarn: ["yarn", ["add", "--dev", "--exact", spec]],
    bun: ["bun", ["add", "--dev", "--exact", spec]]
  };
  const selected = project.packageManager ? commands[project.packageManager] : null;
  if (!selected) return false;
  await runCommand(selected[0], selected[1], { cwd: project.root });
  return true;
}
