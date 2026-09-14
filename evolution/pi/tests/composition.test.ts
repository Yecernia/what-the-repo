import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProductionEvolutionRuntime } from "../src/composition.js";
import type { HostProcessRunner } from "../src/container-sandbox.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REFERENCE = `registry.example.invalid/what-the-repo/pi-checks@${IMAGE_DIGEST}`;
const DOCKER = process.platform === "win32"
  ? "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"
  : "/usr/bin/docker";
const HOST_NODE = process.platform === "win32" ? "C:\\trusted\\node.exe" : "/trusted/node";

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-production-runtime-"));
  return {
    root,
    dockerConfig: await mkdtemp(join(tmpdir(), "what-the-repo-docker-config-")),
  };
}

test("production composition wires the built-in container executor into the evolution runner", async () => {
  const { root, dockerConfig } = await roots();
  const runtime = createProductionEvolutionRuntime({
    sandbox: {
      dockerExecutable: DOCKER,
      dockerConfigDirectory: dockerConfig,
      imageReference: IMAGE_REFERENCE,
      imageDigest: IMAGE_DIGEST,
      commands: [{
        hostExecutable: HOST_NODE,
        containerExecutable: "/usr/local/bin/node",
      }],
    },
    checks: [{
      id: "fixed-eval",
      cwd: { kind: "workspace" },
      argv: [HOST_NODE, "--test", "skill.test.mjs"],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    }],
    stateRoot: join(root, "state"),
    versionsRoot: join(root, "versions"),
    workspaceRoot: join(root, "workspaces"),
  });

  assert.deepEqual(Object.keys(runtime).sort(), ["close", "runner", "store", "versions"]);
  assert.ok(runtime.runner);
  await runtime.close?.();
});

test("production composition rejects a runtime-injected process runner", async () => {
  const { root, dockerConfig } = await roots();
  const injected: HostProcessRunner = {
    async run() {
      throw new Error("must not run");
    },
  };
  assert.throws(
    () => createProductionEvolutionRuntime({
      sandbox: {
        dockerExecutable: DOCKER,
        dockerConfigDirectory: dockerConfig,
        imageReference: IMAGE_REFERENCE,
        imageDigest: IMAGE_DIGEST,
        commands: [{
          hostExecutable: HOST_NODE,
          containerExecutable: "/usr/local/bin/node",
        }],
        processRunner: injected,
      } as never,
      checks: [],
      stateRoot: join(root, "state"),
      versionsRoot: join(root, "versions"),
      workspaceRoot: join(root, "workspaces"),
    }),
    /does not accept a custom process runner/,
  );
});
