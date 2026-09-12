import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContainerSandboxExecutor } from "../.build/src/container-sandbox.js";
import { sha256 } from "../.build/src/integrity.js";
import {
  sandboxRequestDigest,
  TrustedIsolationPolicy,
} from "../.build/src/isolation.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_HOST_OUTPUT_BYTES = 4 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findDocker() {
  const configured = argument("--docker") ?? process.env.WHAT_THE_REPO_DOCKER;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("configured Docker CLI must be an absolute path");
    }
    const candidate = resolve(configured);
    if (!(await executable(candidate))) {
      throw new Error("configured Docker CLI is not an executable absolute path");
    }
    return candidate;
  }
  const names = process.platform === "win32" ? ["docker.exe", "docker.cmd"] : ["docker"];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (await executable(candidate)) return candidate;
    }
  }
  throw new Error("Docker CLI unavailable");
}

function dockerEnvironment(configDirectory) {
  return Object.fromEntries([
    ["DOCKER_CONFIG", configDirectory],
    ["SystemRoot", process.env.SystemRoot],
    ["WINDIR", process.env.WINDIR],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].length > 0));
}

async function run(executablePath, args, { env, timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      cwd: packageRoot,
      env: env ?? {},
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Docker command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_HOST_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      output.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(output).toString("utf8");
      if (bytes > MAX_HOST_OUTPUT_BYTES) {
        reject(new Error("Docker command output exceeded byte limit"));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`Docker command failed with exit code ${exitCode}: ${text.slice(-2_000)}`));
        return;
      }
      resolvePromise({ stdout: text, elapsedMs: Date.now() - started });
    });
  });
}

function platformFromInfo(info) {
  if (info?.OSType !== "linux") throw new Error("Pi sandbox requires a Linux Docker daemon");
  if (info.Architecture === "amd64" || info.Architecture === "x86_64") return "linux/amd64";
  if (info.Architecture === "arm64" || info.Architecture === "aarch64") return "linux/arm64";
  throw new Error("Docker daemon architecture is unsupported");
}

async function main() {
  const docker = await findDocker();
  const buildConfig = await mkdtemp(join(tmpdir(), "what-the-repo-pi-build-docker-"));
  const executorConfig = await mkdtemp(join(tmpdir(), "what-the-repo-pi-runtime-docker-"));
  const imageTag = `what-the-repo-pi-runtime-probe:${randomUUID()}`;
  const buildEnv = dockerEnvironment(buildConfig);
  let built = false;
  try {
    const infoResult = await run(docker, ["info", "--format", "{{json .}}"], {
      env: buildEnv,
      timeoutMs: 30_000,
    });
    const platform = platformFromInfo(JSON.parse(infoResult.stdout));
    const build = await run(docker, [
      "build",
      "--pull",
      "--platform", platform,
      "--tag", imageTag,
      join(packageRoot, "sandbox"),
    ], { env: buildEnv, timeoutMs: 600_000 });
    built = true;
    const inspection = await run(docker, [
      "image", "inspect", "--format", "{{json .}}", imageTag,
    ], { env: buildEnv, timeoutMs: 30_000 });
    const image = JSON.parse(inspection.stdout);
    const imageDigest = image?.Id;
    if (typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
      throw new Error("Docker image did not return an immutable content ID");
    }

    const probeSource = [
      "import assert from 'node:assert/strict';",
      "import { readFile, writeFile } from 'node:fs/promises';",
      "await writeFile('probe-output.txt', 'tmpfs-ok\\n', { flag: 'wx' });",
      "assert.equal(await readFile('probe-output.txt', 'utf8'), 'tmpfs-ok\\n');",
      "process.stdout.write('pi-sandbox-runtime-ok\\n');",
      "",
    ].join("\n");
    const content = Buffer.from(probeSource, "utf8");
    const request = {
      definition: {
        id: "pi-docker-runtime-probe",
        cwd: { kind: "workspace" },
        argv: [process.execPath, "probe.mjs"],
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
        env: {},
      },
      workspaceFiles: [{
        path: "probe.mjs",
        contentBase64: content.toString("base64"),
        sha256: sha256(probeSource),
        bytes: content.length,
      }],
      scope: {
        allowedFiles: ["probe.mjs"],
        maxWorkspaceBytes: 64 * 1024,
        maxFileCount: 1,
      },
    };
    const sandbox = new ContainerSandboxExecutor({
      dockerExecutable: docker,
      dockerConfigDirectory: executorConfig,
      imageReference: imageDigest,
      imageDigest,
      platform,
      commands: [{ hostExecutable: process.execPath, containerExecutable: "/usr/local/bin/node" }],
    });
    const execution = await sandbox.execute(request);
    new TrustedIsolationPolicy(sandbox.isolationPolicy).assertAttestation(execution.isolation, {
      requestDigest: sandboxRequestDigest(request),
      timeoutMs: request.definition.timeoutMs,
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.timedOut, false);
    assert.equal(execution.stdout, "pi-sandbox-runtime-ok\n");
    assert.equal(execution.stderr, "");

    const remaining = await run(docker, [
      "ps", "--all", "--quiet", "--filter", `name=^/${execution.isolation.sandboxId}$`,
    ], { env: buildEnv, timeoutMs: 30_000 });
    assert.equal(remaining.stdout.trim(), "", "sandbox container was not removed");

    const report = {
      schema_version: "1.0.0",
      passed: true,
      image_digest: imageDigest,
      platform,
      build_elapsed_ms: build.elapsedMs,
      execution_elapsed_ms: execution.elapsedMs,
      container_removed: true,
      isolation: execution.isolation,
    };
    const serialized = JSON.stringify(report, null, 2) + "\n";
    const output = argument("--output");
    if (output) {
      const target = resolve(process.cwd(), output);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serialized, "utf8");
    }
    process.stdout.write(serialized);
  } finally {
    if (built) {
      await run(docker, ["image", "rm", "--force", imageTag], {
        env: buildEnv,
        timeoutMs: 60_000,
      }).catch(() => undefined);
    }
    await rm(buildConfig, { recursive: true, force: true });
    await rm(executorConfig, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Pi Docker runtime probe failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
