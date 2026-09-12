import type {
  CheckDefinition,
  IsolationAttestation,
  IsolationPolicy,
  SandboxCheckRequest,
} from "./contracts.js";
import { sha256, stableJson } from "./integrity.js";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.+/:@-]{0,190}$/;
const MAX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_WRITABLE_BYTES = 256 * 1024 * 1024;
const ZERO_CAPABILITIES = /^0+$/;
const POLICY_KEYS = new Set([
  "schemaVersion", "policyId", "trustDomain", "provider", "runtime", "executorConfigDigest",
  "imageDigest", "platform", "runAsUser", "network", "ipcNamespace", "cgroupNamespace",
  "hostFilesystem", "rootFilesystem", "workspaceFilesystem", "capabilities", "noNewPrivileges",
  "seccompProfile", "resourceLimits",
]);
const ATTESTATION_KEYS = new Set([
  "schemaVersion", "trustDomain", "provider", "runtime", "sandboxId", "policyDigest",
  "executorConfigDigest", "runtimeProbeDigest", "requestDigest", "imageDigest", "platform",
  "runAsUser", "network", "ipcNamespace", "cgroupNamespace", "hostFilesystem",
  "rootFilesystem", "workspaceFilesystem", "capabilities", "noNewPrivileges", "seccompProfile",
  "resourceLimits", "runtimeProbe",
]);
const LIMIT_KEYS = new Set([
  "cpuCount", "memoryBytes", "pidsLimit", "workspaceBytes", "tempBytes", "sharedMemoryBytes",
]);
const PROBE_KEYS = new Set([
  "schemaVersion", "uid", "gid", "noNewPrivileges", "seccompMode", "effectiveCapabilities",
  "boundingCapabilities", "networkInterfaces", "rootReadOnly", "workspaceFilesystem",
  "workspaceBytes", "tempFilesystem", "tempBytes", "sharedMemoryFilesystem", "sharedMemoryBytes",
  "cgroupVersion", "memoryMaxBytes", "swapMaxBytes", "pidsMax", "cpuQuota", "cpuPeriod",
]);

function exactKeys(value: unknown, expected: Set<string>): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function validCpuCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 4;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT.test(value);
}

export function isolationPolicyDigest(policy: IsolationPolicy): string {
  return sha256(stableJson(policy));
}

export function sandboxRequestDigest(request: SandboxCheckRequest): string {
  return sha256(stableJson(request));
}

export function checkDefinitionDigest(
  definition: CheckDefinition,
  policy: IsolationPolicy,
): string {
  return sha256(stableJson({
    definition,
    isolationPolicyDigest: isolationPolicyDigest(policy),
  }));
}

export function validateIsolationPolicy(
  policy: IsolationPolicy,
  options: { allowTestPolicy?: boolean } = {},
): IsolationPolicy {
  if (!exactKeys(policy, POLICY_KEYS) || policy.schemaVersion !== 1 ||
    !safeText(policy.policyId) || !safeText(policy.provider) || !safeText(policy.runtime) ||
    !safeText(policy.platform) || policy.runAsUser !== "65532:65532" ||
    !SHA256.test(policy.executorConfigDigest) || !IMAGE_DIGEST.test(policy.imageDigest) ||
    (policy.trustDomain !== "production" && policy.trustDomain !== "test") ||
    (policy.trustDomain === "test" && options.allowTestPolicy !== true) ||
    policy.network !== "disabled" || policy.ipcNamespace !== "private" ||
    policy.cgroupNamespace !== "private" || policy.hostFilesystem !== "unavailable" ||
    policy.rootFilesystem !== "read-only" || policy.workspaceFilesystem !== "tmpfs" ||
    policy.capabilities !== "dropped" || policy.noNewPrivileges !== true ||
    policy.seccompProfile !== "builtin") {
    throw new Error("invalid or untrusted sandbox isolation policy");
  }
  const limits = policy.resourceLimits;
  if (!exactKeys(limits, LIMIT_KEYS) || !validCpuCount(limits.cpuCount) ||
    !positiveInteger(limits.memoryBytes, MAX_MEMORY_BYTES) ||
    !positiveInteger(limits.pidsLimit, 1024) ||
    !positiveInteger(limits.workspaceBytes, MAX_WRITABLE_BYTES) ||
    !positiveInteger(limits.tempBytes, MAX_WRITABLE_BYTES) ||
    !positiveInteger(limits.sharedMemoryBytes, MAX_WRITABLE_BYTES)) {
    throw new Error("invalid sandbox isolation resource policy");
  }
  return structuredClone(policy);
}

export class TrustedIsolationPolicy {
  readonly policy: IsolationPolicy;
  readonly digest: string;

  constructor(policy: IsolationPolicy, options: { allowTestPolicy?: boolean } = {}) {
    this.policy = validateIsolationPolicy(policy, options);
    this.digest = isolationPolicyDigest(this.policy);
  }

  assertAttestation(
    attestation: IsolationAttestation,
    expected: { requestDigest?: string; timeoutMs?: number } = {},
  ): void {
    const policy = this.policy;
    const limits = attestation?.resourceLimits;
    const probe = attestation?.runtimeProbe;
    const [uid, gid] = policy.runAsUser.split(":").map(Number);
    const pageTolerance = 4_096;
    const probeShapeValid = exactKeys(probe, PROBE_KEYS) &&
      Number.isSafeInteger(probe?.uid) && (probe?.uid ?? -1) >= 0 &&
      Number.isSafeInteger(probe?.gid) && (probe?.gid ?? -1) >= 0 &&
      typeof probe?.effectiveCapabilities === "string" &&
      typeof probe?.boundingCapabilities === "string" &&
      Array.isArray(probe?.networkInterfaces) &&
      positiveInteger(probe?.workspaceBytes, MAX_WRITABLE_BYTES) &&
      positiveInteger(probe?.tempBytes, MAX_WRITABLE_BYTES) &&
      positiveInteger(probe?.sharedMemoryBytes, MAX_WRITABLE_BYTES) &&
      positiveInteger(probe?.memoryMaxBytes, MAX_MEMORY_BYTES) &&
      positiveInteger(probe?.pidsMax, 1024) &&
      positiveInteger(probe?.cpuQuota, Number.MAX_SAFE_INTEGER) &&
      positiveInteger(probe?.cpuPeriod, Number.MAX_SAFE_INTEGER);
    if (!exactKeys(attestation, ATTESTATION_KEYS) || attestation.schemaVersion !== 1 ||
      attestation.trustDomain !== policy.trustDomain ||
      attestation.provider !== policy.provider || attestation.runtime !== policy.runtime ||
      attestation.policyDigest !== this.digest ||
      attestation.executorConfigDigest !== policy.executorConfigDigest ||
      !SHA256.test(attestation.runtimeProbeDigest) ||
      attestation.imageDigest !== policy.imageDigest ||
      attestation.platform !== policy.platform || attestation.runAsUser !== policy.runAsUser ||
      !safeText(attestation.sandboxId) || !SHA256.test(attestation.requestDigest) ||
      (expected.requestDigest !== undefined && attestation.requestDigest !== expected.requestDigest) ||
      attestation.network !== policy.network ||
      attestation.ipcNamespace !== policy.ipcNamespace ||
      attestation.cgroupNamespace !== policy.cgroupNamespace ||
      attestation.hostFilesystem !== policy.hostFilesystem ||
      attestation.rootFilesystem !== policy.rootFilesystem ||
      attestation.workspaceFilesystem !== policy.workspaceFilesystem ||
      attestation.capabilities !== policy.capabilities ||
      attestation.noNewPrivileges !== policy.noNewPrivileges ||
      attestation.seccompProfile !== policy.seccompProfile ||
      !exactKeys(limits, new Set([...LIMIT_KEYS, "timeoutMs"])) ||
      limits.cpuCount !== policy.resourceLimits.cpuCount ||
      limits.memoryBytes !== policy.resourceLimits.memoryBytes ||
      limits.pidsLimit !== policy.resourceLimits.pidsLimit ||
      limits.workspaceBytes !== policy.resourceLimits.workspaceBytes ||
      limits.tempBytes !== policy.resourceLimits.tempBytes ||
      limits.sharedMemoryBytes !== policy.resourceLimits.sharedMemoryBytes ||
      !positiveInteger(limits.timeoutMs, 30 * 60_000) ||
      (expected.timeoutMs !== undefined && limits.timeoutMs !== expected.timeoutMs) ||
      !probeShapeValid || !probe || probe.schemaVersion !== 1 || probe.uid !== uid || probe.gid !== gid ||
      probe.noNewPrivileges !== true || probe.seccompMode !== 2 ||
      !ZERO_CAPABILITIES.test(probe.effectiveCapabilities) ||
      !ZERO_CAPABILITIES.test(probe.boundingCapabilities) ||
      probe.networkInterfaces.length !== 1 || probe.networkInterfaces[0] !== "lo" ||
      probe.rootReadOnly !== true || probe.workspaceFilesystem !== "tmpfs" ||
      Math.abs(probe.workspaceBytes - policy.resourceLimits.workspaceBytes) > pageTolerance ||
      probe.tempFilesystem !== "tmpfs" ||
      Math.abs(probe.tempBytes - policy.resourceLimits.tempBytes) > pageTolerance ||
      probe.sharedMemoryFilesystem !== "tmpfs" ||
      Math.abs(probe.sharedMemoryBytes - policy.resourceLimits.sharedMemoryBytes) > pageTolerance ||
      probe.cgroupVersion !== 2 || probe.memoryMaxBytes !== policy.resourceLimits.memoryBytes ||
      probe.swapMaxBytes !== 0 || probe.pidsMax !== policy.resourceLimits.pidsLimit ||
      !positiveInteger(probe.cpuQuota, Number.MAX_SAFE_INTEGER) ||
      !positiveInteger(probe.cpuPeriod, Number.MAX_SAFE_INTEGER) ||
      Math.abs((probe.cpuQuota / probe.cpuPeriod) - policy.resourceLimits.cpuCount) > 0.001 ||
      attestation.runtimeProbeDigest !== sha256(stableJson(probe))) {
      throw new Error("sandbox execution does not match the trusted isolation policy");
    }
  }
}
