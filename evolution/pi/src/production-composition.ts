import { createDecipheriv, scryptSync } from 'node:crypto';
import { createPlatformBudget, consumeAdminEvolutionCommand } from './platform-budget.js';
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createProductionEvolutionRuntime,
  type ProductionEvolutionRuntime,
} from "./composition.js";
import type { CheckDefinition } from "./contracts.js";
import type { FeedbackEvolutionPolicy } from "./feedback-queue.js";
import { createPiSdkSessionFactory } from "./pi-sdk.js";
import { PostgresEvolutionPersistence } from "./postgres-state.js";
import { productEvolutionPaths } from "./product-paths.js";

const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PROVIDER_KEY_BYTES = 16 * 1024;
const MAX_DATABASE_URL_BYTES = 64 * 1024;

export const PRODUCTION_FEEDBACK_TARGET_SKILL_IDS = [
  "primary-conversational-supervisor",
  "component-explanation",
  "architecture-planning",
  "understanding-assessment",
  "citation-review",
  "memory-maintenance",
  "repository-value-discovery",
  "learning-route",
] as const;

interface HostCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function textEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(textEnv(name));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveCost(name: string, fallback: number): number {
  const value = Number(textEnv(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function httpsUrl(name: string, fallback: string): string {
  const value = textEnv(name, fallback) as string;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

async function readSecretValue(
  root: string,
  env: NodeJS.ProcessEnv,
  directName: string,
  fileName: string,
  label: string,
  maxBytes: number,
  required: boolean,
): Promise<string | undefined> {
  const direct = env[directName]?.trim();
  const configuredFile = env[fileName]?.trim();
  if (direct && configuredFile) throw new Error(`${directName} and ${fileName} cannot both be configured`);
  if (direct) {
    if (Buffer.byteLength(direct, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds its byte budget`);
    }
    return direct;
  }
  if (!configuredFile) {
    if (required) throw new Error(`${directName} or ${fileName} is required for the evolution worker`);
    return undefined;
  }
  const path = isAbsolute(configuredFile) ? configuredFile : resolve(root, configuredFile);
  const value = (await readFile(path, "utf8")).trim();
  if (!value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} file is empty or exceeds its byte budget`);
  }
  return value;
}

export async function readEvolutionProviderKey(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return await readSecretValue(
    root,
    env,
    "WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY",
    "WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY_FILE",
    "evolution Provider key",
    MAX_PROVIDER_KEY_BYTES,
    true,
  ) as string;
}

export async function readEvolutionDatabaseUrl(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return await readSecretValue(
    root,
    env,
    "DATABASE_URL",
    "DATABASE_URL_FILE",
    "evolution database URL",
    MAX_DATABASE_URL_BYTES,
    false,
  );
}

async function dockerExecutablePath(): Promise<string> {
  const configured = textEnv("WHAT_THE_REPO_DOCKER");
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("WHAT_THE_REPO_DOCKER must be an absolute path");
    await access(configured, constants.X_OK);
    return configured;
  }
  const names = process.platform === "win32" ? ["docker.exe", "docker.cmd"] : ["docker"];
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error("Docker CLI is unavailable for the evolution worker");
}

async function runHost(
  executable: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<HostCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function prepareDockerConfigDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
    resolve(await realpath(directory)) !== directory || (await readdir(directory)).length !== 0) {
    throw new Error("evolution Docker config directory must be an empty non-linked directory");
  }
  return directory;
}

async function resolveImageDigest(
  dockerExecutable: string,
  dockerConfigDirectory: string,
  imageReference: string,
): Promise<string> {
  const configuredDigest = textEnv("WHAT_THE_REPO_EVOLUTION_SANDBOX_IMAGE_DIGEST");
  if (configuredDigest && !IMAGE_DIGEST.test(configuredDigest)) {
    throw new Error("WHAT_THE_REPO_EVOLUTION_SANDBOX_IMAGE_DIGEST must be sha256:<64 hex chars>");
  }
  const env = {
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.platform === "win32" && process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    DOCKER_CONFIG: dockerConfigDirectory,
  };
  const result = await runHost(
    dockerExecutable,
    ["image", "inspect", "--format", "{{.Id}}", imageReference],
    env,
    30_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`evolution sandbox image is unavailable: ${result.stderr.trim().slice(-500)}`);
  }
  const localDigest = result.stdout.trim();
  if (!IMAGE_DIGEST.test(localDigest)) throw new Error("Docker did not return an immutable sandbox image ID");
  if (configuredDigest && configuredDigest !== localDigest) {
    throw new Error("configured evolution sandbox image digest does not match the local image");
  }
  return configuredDigest ?? localDigest;
}

export function productionCheckDefinitions(nodeExecutable: string): CheckDefinition[] {
  return PRODUCTION_FEEDBACK_TARGET_SKILL_IDS.flatMap((skillId) => [
    {
      id: `skill-contract-${skillId}`,
      cwd: { kind: "workspace" } as const,
      argv: [nodeExecutable, "/opt/what-the-repo/checks/skill-contract.mjs", "/workspace/SKILL.md"],
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
      env: { EXPECTED_SKILL_ID: skillId },
    },
    {
      id: `skill-eval-${skillId}`,
      cwd: { kind: "workspace" } as const,
      argv: [nodeExecutable, "/opt/what-the-repo/checks/skill-eval.mjs", "/workspace/SKILL.md"],
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
      env: { EXPECTED_SKILL_ID: skillId },
    },
  ]);
}

function policies(
  checks: { definitionDigest(id: string): string },
): Record<string, FeedbackEvolutionPolicy> {
  return Object.fromEntries(PRODUCTION_FEEDBACK_TARGET_SKILL_IDS.map((skillId) => {
    const contractId = `skill-contract-${skillId}`;
    const evaluationId = `skill-eval-${skillId}`;
    return [skillId, {
      whitelist: ["SKILL.md"],
      checkIds: [contractId],
      checkDefinitionDigests: { [contractId]: checks.definitionDigest(contractId) },
      evaluation: {
        checkId: evaluationId,
        suiteId: `${skillId}-method-hygiene`,
        datasetVersion: "v2",
        definitionDigest: checks.definitionDigest(evaluationId),
        metrics: { method_hygiene_score: { direction: "higher", maxRegression: 0 } },
      },
      maxSteps: positiveInt("WHAT_THE_REPO_EVOLUTION_MAX_STEPS", 40),
      maxTimeMs: positiveInt("WHAT_THE_REPO_EVOLUTION_MAX_TIME_MS", 15 * 60_000),
      maxTokens: positiveInt("WHAT_THE_REPO_EVOLUTION_MAX_TOKENS", 120_000),
      // Monetary admission is authoritative in the shared platform ledger.
      maxCostUsd: null,
      maxCandidateBytes: positiveInt("WHAT_THE_REPO_EVOLUTION_MAX_CANDIDATE_BYTES", 512 * 1024),
    }];
  }));
}

async function modelSessionFactory(
  root: string,
  dataRoot: string,
  global?: Awaited<ReturnType<typeof createPlatformBudget>>,
  taskId?: string,
): Promise<ReturnType<typeof createPiSdkSessionFactory>> {
  let provider = textEnv("WHAT_THE_REPO_EVOLUTION_PROVIDER_ID", "deepseek") as string;
  if (!PROVIDER_ID.test(provider)) throw new Error("invalid evolution Provider ID");
  let baseUrl = httpsUrl("WHAT_THE_REPO_EVOLUTION_PROVIDER_BASE_URL", "https://api.deepseek.com");
  let modelId = textEnv("WHAT_THE_REPO_EVOLUTION_PROVIDER_MODEL", "deepseek-v4-flash") as string;
  let apiKey: string | undefined;
  let evolutionModel: {model: NonNullable<ReturnType<ModelRuntime['getModel']>>;authHeader?:string}|undefined;
  let configVersion=0, connectionId="platform-evolution";
  if(global && taskId) {
    const history=(await global.pool.query("SELECT value FROM admin_documents WHERE key=$1",["platform"])).rows[0]?.value;
    const taskRow=(await global.pool.query("SELECT created_at,config_version FROM evolution_tasks WHERE task_id=$1",[taskId])).rows[0];
    const created=taskRow?.created_at;
    const version=history?.versions.filter((v:{createdAt:string;version:number})=>taskRow?.config_version!==null&&taskRow?.config_version!==undefined?v.version===taskRow.config_version:!created||Date.parse(v.createdAt)<=new Date(created).getTime()).at(-1);
    if(taskRow?.config_version&&!version)throw new Error('platform_config_version_missing');
    configVersion=version?.version??0;const selection=version?.agents.evolution;
    if(selection) {
      const c=version.connections.find((c:{id:string})=>c.id===selection.connectionId);
      const secret=await readSecretValue(root,process.env,"WHAT_THE_REPO_KEY_ENCRYPTION_SECRET","WHAT_THE_REPO_KEY_ENCRYPTION_SECRET_FILE","key encryption",MAX_PROVIDER_KEY_BYTES,true);
      const [ciphertext,iv,tag]=c.secret.split(".").map((x:string)=>Buffer.from(x,"base64"));
      const decipher=createDecipheriv("aes-256-gcm",scryptSync(secret!,"repo-onboarding-provider-keys:v1",32),iv);
      decipher.setAAD(Buffer.from("admin\0connection:"+c.id));decipher.setAuthTag(tag);
      apiKey=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8");
      evolutionModel=version.evolutionModel;
      provider=evolutionModel?.model.provider??c.provider;baseUrl=c.baseUrl;modelId=selection.model;connectionId=c.id;
    }
  }
  apiKey ??= await readEvolutionProviderKey(root);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(dataRoot, "evolution-provider-auth.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider(provider, { baseUrl, apiKey,...(evolutionModel?{api:evolutionModel.model.api,models:[evolutionModel.model],headers:evolutionModel.authHeader==='api-key'?{'api-key':apiKey}:undefined}:{}) });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`evolution model is unavailable: ${provider}:${modelId}`);

  const thinkingLevel = textEnv("WHAT_THE_REPO_EVOLUTION_THINKING_LEVEL", "medium");
  if (!thinkingLevel || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel)) {
    throw new Error("invalid WHAT_THE_REPO_EVOLUTION_THINKING_LEVEL");
  }
  return createPiSdkSessionFactory({
    globalReservation: global && taskId ? global.forTask(taskId,configVersion,connectionId) : undefined,
    modelRuntime: runtime,
    model,
    thinkingLevel: thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  });
}

/**
 * Repository-owned production composition. Deployments can override it with
 * WHAT_THE_REPO_EVOLUTION_COMPOSITION without changing the online API.
 */
export async function createEvolutionRuntime(): Promise<ProductionEvolutionRuntime> {
  const paths = productEvolutionPaths();
  await mkdir(paths.dataRoot, { recursive: true });
  await mkdir(paths.stateRoot, { recursive: true });
  await mkdir(paths.versionsRoot, { recursive: true });
  await mkdir(paths.workspaceRoot, { recursive: true });

  const dockerConfigDirectory = await prepareDockerConfigDirectory(
    textEnv("WHAT_THE_REPO_EVOLUTION_DOCKER_CONFIG") ?? join(paths.dataRoot, "evolution-docker-config"),
  );
  const dockerExecutable = await dockerExecutablePath();
  const imageReference = textEnv(
    "WHAT_THE_REPO_EVOLUTION_SANDBOX_IMAGE",
    "what-the-repo-pi-sandbox:local",
  ) as string;
  const imageDigest = await resolveImageDigest(dockerExecutable, dockerConfigDirectory, imageReference);
  const definitions = productionCheckDefinitions(process.execPath);
  const databaseUrl = await readEvolutionDatabaseUrl(paths.root);
  const global = await createPlatformBudget(paths.root, databaseUrl ?? null);
  const sessionFactory: import("./contracts.js").PiSessionFactory = async input => {
    const factory = await modelSessionFactory(paths.root, paths.dataRoot, global, input.taskId);
    return factory({ ...input, budget: { ...input.budget, maxCostUsd: global ? null : input.budget.maxCostUsd } });
  };
  const postgres = databaseUrl
    ? PostgresEvolutionPersistence.connect(
        databaseUrl,
        positiveInt("WHAT_THE_REPO_EVOLUTION_DB_POOL_MAX", 4),
      )
    : undefined;

  const result = createProductionEvolutionRuntime({
    sandbox: {
      dockerExecutable,
      dockerConfigDirectory,
      imageReference: imageDigest,
      imageDigest,
      platform: textEnv("WHAT_THE_REPO_EVOLUTION_SANDBOX_PLATFORM", "linux/amd64") as
        "linux/amd64" | "linux/arm64",
      commands: [{ hostExecutable: process.execPath, containerExecutable: "/usr/local/bin/node" }],
      allowedEnvironmentKeys: ["EXPECTED_SKILL_ID"],
    },
    checks: definitions,
    stateRoot: paths.stateRoot,
    stateJournal: postgres,
    versionsRoot: paths.versionsRoot,
    workspaceRoot: paths.workspaceRoot,
    forbiddenWorkspaceRoots: [paths.queueRoot, paths.skillsRoot],
    sessionFactory,
    feedback: {
      queueRoot: paths.queueRoot,
      requestStore: postgres,
      skillsRoot: paths.skillsRoot,
      policies: (checks) => policies(checks),
      intervalMs: positiveInt("WHAT_THE_REPO_EVOLUTION_INTERVAL_MS", 30_000),
      taskLimit: positiveInt("WHAT_THE_REPO_EVOLUTION_TASK_LIMIT", 4),
      limit: positiveInt("WHAT_THE_REPO_EVOLUTION_QUEUE_LIMIT", 20),
      redisUrl: textEnv("WHAT_THE_REPO_REDIS_URL"),
      redisPrefix: textEnv("WHAT_THE_REPO_REDIS_PREFIX", "what-the-repo"),
    },
  });
  let processing:Promise<unknown>|undefined;
  const timer=global?setInterval(()=>{if(processing)return;processing=consumeAdminEvolutionCommand(global.pool,result).catch(()=>undefined).finally(()=>{processing=undefined;});},2000):undefined;
  timer?.unref();
  const close=result.close;result.close=async()=>{if(timer)clearInterval(timer);await processing;await close?.();await global?.close();};
  return result;
}

export default createEvolutionRuntime;
