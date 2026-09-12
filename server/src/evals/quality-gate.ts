import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type GateStatus = "passed" | "failed" | "skipped";

interface GateResult {
  name: string;
  status: GateStatus;
  command: string[];
  duration_ms: number;
  output: string;
  reason: string | null;
}

interface Command {
  file: string;
  args: string[];
}

const OUTPUT_LIMIT = 12_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function npmCommand(args: string[]): Command {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli) return { file: process.execPath, args: [npmCli, ...args] };
  return { file: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

function nodeCommand(args: string[]): Command {
  return { file: process.execPath, args };
}

function displayCommand(command: Command): string[] {
  return [command.file, ...command.args];
}

function runGate(
  name: string,
  command: Command,
  cwd: string,
  options: { timeoutMs?: number; environment?: NodeJS.ProcessEnv } = {},
): GateResult {
  const startedAt = performance.now();
  const result = spawnSync(command.file, command.args, {
    cwd,
    env: options.environment ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: MAX_BUFFER,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-OUTPUT_LIMIT);
  const durationMs = Math.round(performance.now() - startedAt);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      name,
      status: "skipped",
      command: displayCommand(command),
      duration_ms: durationMs,
      output,
      reason: "executable unavailable",
    };
  }
  if (result.error) {
    return {
      name,
      status: "failed",
      command: displayCommand(command),
      duration_ms: durationMs,
      output,
      reason: result.error.message,
    };
  }
  return {
    name,
    status: result.status === 0 ? "passed" : "failed",
    command: displayCommand(command),
    duration_ms: durationMs,
    output,
    reason: result.status === 0 ? null : `exit code ${result.status ?? "unknown"}`,
  };
}

function skipped(name: string, reason: string): GateResult {
  return {
    name,
    status: "skipped",
    command: [],
    duration_ms: 0,
    output: "",
    reason,
  };
}

function executableAvailable(command: Command, cwd: string): boolean {
  const result = spawnSync(command.file, command.args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
  });
  return !result.error && result.status === 0;
}

function parseArguments(args: string[]): {
  all: boolean;
  allowSkips: boolean;
  output: string;
} {
  const all = args.includes("--all");
  const allowSkips = args.includes("--allow-skips");
  if (allowSkips && !all) throw new Error("--allow-skips 只能与 --all 一起使用");
  const outputIndex = args.indexOf("--output");
  return {
    all,
    allowSkips,
    output: outputIndex >= 0
      ? args[outputIndex + 1] ?? ""
      : "out/quality-gate/report.json",
  };
}

async function main(): Promise<void> {
  const root = repositoryRoot();
  const server = join(root, "server");
  const web = join(root, "web");
  const evolution = join(root, "evolution", "pi");
  const options = parseArguments(process.argv.slice(2));
  if (!options.output) throw new Error("--output 需要文件路径");

  const gates: GateResult[] = [
    runGate("server_build", npmCommand(["run", "build"]), server),
    runGate("server_test", npmCommand(["test"]), server),
    runGate(
      "evidence_graph_v2_eval",
      nodeCommand([
        "--import",
        "tsx",
        "src/evals/evidence-graph-v2.ts",
        "--output",
        join(root, "out", "quality-gate-evidence-graph", "report.json"),
      ]),
      server,
      { timeoutMs: 5 * 60_000 },
    ),
    runGate(
      "fixed_product_eval",
      nodeCommand([
        "--import",
        "tsx",
        "src/evals/product-run.ts",
        "fixture",
        "--output-dir",
        join(root, "out", "quality-gate-eval"),
      ]),
      server,
      { timeoutMs: 15 * 60_000 },
    ),
    runGate(
      "fixed_conversation_eval",
      nodeCommand([
        "--import",
        "tsx",
        "src/evals/conversation-run.ts",
        "--output-dir",
        join(root, "out", "quality-gate-conversation-eval"),
      ]),
      server,
    ),
    runGate("web_lint", npmCommand(["run", "lint"]), web),
    runGate("web_test", npmCommand(["test"]), web),
    runGate("web_build", npmCommand(["run", "build"]), web),
  ];

  if (options.all) {
    gates.push(
      runGate("web_e2e", npmCommand(["run", "test:e2e"]), web, { timeoutMs: 20 * 60_000 }),
      runGate("pi_evolution_test", npmCommand(["test"]), evolution, { timeoutMs: 10 * 60_000 }),
    );
    const docker = { file: process.platform === "win32" ? "docker.exe" : "docker", args: ["--version"] };
    if (!executableAvailable(docker, root)) {
      gates.push(
        skipped("pi_docker_runtime_probe", "Docker CLI unavailable"),
        skipped("docker_compose_config", "Docker CLI unavailable"),
      );
    } else {
      gates.push(
        runGate(
          "pi_docker_runtime_probe",
          npmCommand([
            "run",
            "probe:docker",
            "--",
            "--output",
            join(root, "out", "pi-runtime-probe", "report.json"),
          ]),
          evolution,
          { timeoutMs: 15 * 60_000 },
        ),
        runGate(
          "docker_compose_config",
          { file: docker.file, args: ["compose", "-f", "compose.dev-deps.yaml", "config", "--quiet"] },
          root,
          {
            timeoutMs: 120_000,
            environment: {
              ...process.env,
              POSTGRES_PASSWORD: "quality-gate-postgres-password",
              GITHUB_OAUTH_CLIENT_ID: "quality-gate-client-id",
              GITHUB_OAUTH_CLIENT_SECRET: "quality-gate-client-secret",
              GITHUB_OAUTH_CALLBACK_URL: "http://127.0.0.1:8307/api/auth/github/callback",
              WHAT_THE_REPO_WEB_URL: "http://127.0.0.1:5307",
              WHAT_THE_REPO_SESSION_SECRET: "quality-gate-session-secret-0123456789012345",
              WHAT_THE_REPO_KEY_ENCRYPTION_SECRET: "quality-gate-key-secret-012345678901234567",
              WHAT_THE_REPO_MCP_TOKEN: "quality-gate-mcp-token-01234567890123456789",
              WHAT_THE_REPO_MCP_OWNER_ID: "github:quality-gate-owner",
            },
          },
        ),
      );
    }
  } else {
    gates.push(
      skipped("web_e2e", "not requested; pass --all"),
      skipped("pi_evolution_test", "not requested; pass --all"),
      skipped("pi_docker_runtime_probe", "not requested; pass --all"),
      skipped("docker_compose_config", "not requested; pass --all"),
    );
  }

  const failed = gates.filter((gate) => gate.status === "failed").map((gate) => gate.name);
  const skippedGates = gates.filter((gate) => gate.status === "skipped").map((gate) => gate.name);
  const report = {
    schema_version: "typescript-quality-gate-v1",
    generated_at: new Date().toISOString(),
    root,
    passed: failed.length === 0,
    complete: skippedGates.length === 0,
    failed,
    skipped: skippedGates,
    gates,
  };
  const output = resolve(root, options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    complete: report.complete,
    output,
  })}\n`);
  if (!report.passed || (options.all && !options.allowSkips && !report.complete)) {
    process.exitCode = 1;
  }
}

await main();
