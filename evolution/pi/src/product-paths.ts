import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ProductEvolutionPaths {
  root: string;
  dataRoot: string;
  queueRoot: string;
  stateRoot: string;
  versionsRoot: string;
  workspaceRoot: string;
  skillsRoot: string;
}

/** Keep the standalone evolution worker on the same roots the TypeScript API uses. */
export function productEvolutionPaths(env: NodeJS.ProcessEnv = process.env): ProductEvolutionPaths {
  const discoveredRoot = discoverRoot(process.cwd());
  const root = resolve(env.WHAT_THE_REPO_ROOT ?? discoveredRoot);
  const dataRoot = resolve(env.WHAT_THE_REPO_DATA_DIR ?? join(root, ".local", "what-the-repo-data"));
  const stateRoot = resolve(nonEmpty(env.WHAT_THE_REPO_EVOLUTION_STATE_ROOT) ?? join(dataRoot, "evolution-state"));
  const versionsRoot = resolve(nonEmpty(env.WHAT_THE_REPO_SKILL_VERSIONS_ROOT) ?? join(dataRoot, "skill-versions"));
  const workspaceRoot = resolve(nonEmpty(env.WHAT_THE_REPO_EVOLUTION_WORKSPACE_ROOT) ?? join(dataRoot, "evolution-workspaces"));
  return {
    root,
    dataRoot,
    queueRoot: join(dataRoot, "evolution-feedback-requests"),
    stateRoot,
    versionsRoot,
    workspaceRoot,
    skillsRoot: join(root, "server", "skills"),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function discoverRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "server", "package.json")) && existsSync(join(current, "web", "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function assertAbsoluteProductPath(value: string, label: string): string {
  const result = resolve(value);
  if (!isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return result;
}
