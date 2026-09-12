import type {
  IsolationAttestation,
  IsolationPolicy,
  SandboxCheckExecution,
  SandboxCheckExecutor,
  SandboxCheckRequest,
} from "../src/contracts.js";
import { sha256, stableJson } from "../src/integrity.js";
import { isolationPolicyDigest, sandboxRequestDigest } from "../src/isolation.js";
import { TrustedIsolationPolicy } from "../src/isolation.js";

type Handler = (
  request: SandboxCheckRequest,
  signal?: AbortSignal,
) => SandboxCheckExecution | Promise<SandboxCheckExecution>;

const PENDING_REQUEST_DIGEST = sha256("pending-test-sandbox-request");

export const TEST_ISOLATION_POLICY: IsolationPolicy = {
  schemaVersion: 1,
  policyId: "test-sandbox-v1",
  trustDomain: "test",
  provider: "test-double",
  runtime: "in-process-test-double",
  executorConfigDigest: sha256("test-sandbox-executor-v1"),
  imageDigest: `sha256:${"1".repeat(64)}`,
  platform: "test/host",
  runAsUser: "65532:65532",
  network: "disabled",
  ipcNamespace: "private",
  cgroupNamespace: "private",
  hostFilesystem: "unavailable",
  rootFilesystem: "read-only",
  workspaceFilesystem: "tmpfs",
  capabilities: "dropped",
  noNewPrivileges: true,
  seccompProfile: "builtin",
  resourceLimits: {
    cpuCount: 1,
    memoryBytes: 64 * 1024 * 1024,
    pidsLimit: 32,
    workspaceBytes: 5 * 1024 * 1024,
    tempBytes: 5 * 1024 * 1024,
    sharedMemoryBytes: 1024 * 1024,
  },
};

export const TEST_TRUSTED_ISOLATION_POLICY = new TrustedIsolationPolicy(
  TEST_ISOLATION_POLICY,
  { allowTestPolicy: true },
);

function testAttestation(timeoutMs: number): IsolationAttestation {
  const runtimeProbe: IsolationAttestation["runtimeProbe"] = {
    schemaVersion: 1,
    uid: Number(TEST_ISOLATION_POLICY.runAsUser.split(":")[0]),
    gid: Number(TEST_ISOLATION_POLICY.runAsUser.split(":")[1]),
    noNewPrivileges: true,
    seccompMode: 2,
    effectiveCapabilities: "0000000000000000",
    boundingCapabilities: "0000000000000000",
    networkInterfaces: ["lo"],
    rootReadOnly: true,
    workspaceFilesystem: "tmpfs",
    workspaceBytes: TEST_ISOLATION_POLICY.resourceLimits.workspaceBytes,
    tempFilesystem: "tmpfs",
    tempBytes: TEST_ISOLATION_POLICY.resourceLimits.tempBytes,
    sharedMemoryFilesystem: "tmpfs",
    sharedMemoryBytes: TEST_ISOLATION_POLICY.resourceLimits.sharedMemoryBytes,
    cgroupVersion: 2,
    memoryMaxBytes: TEST_ISOLATION_POLICY.resourceLimits.memoryBytes,
    swapMaxBytes: 0,
    pidsMax: TEST_ISOLATION_POLICY.resourceLimits.pidsLimit,
    cpuQuota: 100_000,
    cpuPeriod: 100_000,
  };
  return {
    schemaVersion: 1,
    trustDomain: "test",
    provider: TEST_ISOLATION_POLICY.provider,
    runtime: TEST_ISOLATION_POLICY.runtime,
    sandboxId: "test-sandbox",
    policyDigest: isolationPolicyDigest(TEST_ISOLATION_POLICY),
    executorConfigDigest: TEST_ISOLATION_POLICY.executorConfigDigest,
    runtimeProbeDigest: sha256(stableJson(runtimeProbe)),
    requestDigest: PENDING_REQUEST_DIGEST,
    imageDigest: TEST_ISOLATION_POLICY.imageDigest,
    platform: TEST_ISOLATION_POLICY.platform,
    runAsUser: TEST_ISOLATION_POLICY.runAsUser,
    network: "disabled",
    ipcNamespace: "private",
    cgroupNamespace: "private",
    hostFilesystem: "unavailable",
    rootFilesystem: "read-only",
    workspaceFilesystem: "tmpfs",
    capabilities: "dropped",
    noNewPrivileges: true,
    seccompProfile: "builtin",
    resourceLimits: {
      ...TEST_ISOLATION_POLICY.resourceLimits,
      timeoutMs,
    },
    runtimeProbe,
  };
}

export function isolatedExecution(
  overrides: Partial<SandboxCheckExecution> = {},
): SandboxCheckExecution {
  const terminationReason = overrides.terminationReason ?? (overrides.timedOut ? "timeout" : "exit");
  return {
    exitCode: overrides.exitCode !== undefined
      ? overrides.exitCode
      : (terminationReason === "exit" ? 0 : null),
    timedOut: overrides.timedOut ?? terminationReason === "timeout",
    terminationReason,
    stdout: "",
    stderr: "",
    elapsedMs: 1,
    isolation: testAttestation(1_000),
    ...overrides,
  };
}

export class FakeSandboxExecutor implements SandboxCheckExecutor {
  readonly requests: SandboxCheckRequest[] = [];
  readonly isolationPolicy = structuredClone(TEST_ISOLATION_POLICY);
  readonly startupGraceMs = 0;
  readonly abortGraceMs = 50;

  constructor(private readonly handler: Handler = () => isolatedExecution()) {}

  async execute(request: SandboxCheckRequest, signal?: AbortSignal): Promise<SandboxCheckExecution> {
    this.requests.push(structuredClone(request));
    const execution = await this.handler(request, signal);
    if (execution.isolation.requestDigest === PENDING_REQUEST_DIGEST) {
      const runtimeProbe = execution.isolation.runtimeProbe;
      execution.isolation = {
        ...execution.isolation,
        runtimeProbeDigest: sha256(stableJson(runtimeProbe)),
        requestDigest: sandboxRequestDigest(request),
        resourceLimits: {
          ...execution.isolation.resourceLimits,
          timeoutMs: request.definition.timeoutMs,
        },
      };
    }
    return execution;
  }
}
