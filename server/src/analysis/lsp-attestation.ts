import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { languageById } from "./languages.js";

const MAX_ATTESTATION_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const LSP_TRUTH_FIXTURE_DIGESTS: Readonly<Record<string, string>> = {
  cpp: "0540a3eaee92bba0beaaabefb85fa48b07cbb855ecc8b338cc15ca23ec644941",
  csharp: "923afa3e3d3b8c609e9bab8842a28b355f33e0cafaf8c7deb81b3654290e1603",
  go: "c6494b818127f1556dc20c35c4b733769cd37f397ecf8b91d6909be090e0931b",
  java: "9b7ac5fd7378cd66b2f9b1fcd9aa76af34a8259e07e848e2e96a91d8e318e851",
  javascript: "2934c346127be1e88e0b28d0588b85d1ca69eeb25c3909163d2cb8b940c78990",
  php: "477a6ec986d9b9093325c5e219b65cf99da4f214336e05f35a44e0c20898c50e",
  python: "2b05f71be8fdcae1d57f634056d4c2b4b1d6c1a8b9fa00c8a8a9a3952856e57d",
  rust: "225b16341cd7aba4422e6a6767ee920990ea27683c89003fbc3d0d406ba9ce17",
  typescript: "3d4f543b2f8f19a445cb5e25902e729d08c20c50df3a3f11393435d298e7e234",
};

export interface LspSandboxCapabilities {
  implementation: string;
  version: string;
  networkDisabled: true;
  targetFilesystemHidden: true;
  writeRootEnforced: true;
  processLimitEnforced: true;
  memoryLimitEnforced: true;
  processTreeCleanupVerified: true;
}

export interface VerifiedLanguageAttestation {
  command: string[];
  serverSha256: string;
  serverVersion: string;
  capabilities: string[];
  truthArtifactSha256: string;
}

export interface StagedLspCommands {
  wrapperCommand: string[];
  serverCommand: string[];
}

export class LspAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspAttestationError";
  }
}

export class VerifiedLspAttestation {
  constructor(
    readonly implementation: string,
    readonly wrapperCommand: string[],
    readonly wrapperSha256: string,
    readonly wrapperVersion: string,
    readonly sandboxCapabilities: LspSandboxCapabilities,
    readonly languages: ReadonlyMap<string, VerifiedLanguageAttestation>,
  ) {}

  commandFor(language: string): string[] | null {
    return this.languages.get(language)?.command ?? null;
  }

  async stageForExecution(language: string, destination: string): Promise<StagedLspCommands> {
    const binding = this.languages.get(language);
    if (!binding) throw new LspAttestationError(`${language} language server is not attested`);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const wrapperPath = await stageExecutable(
      this.wrapperCommand[0] as string,
      this.wrapperSha256,
      join(destination, executableName("sandbox-wrapper", this.wrapperCommand[0] as string)),
    );
    const serverPath = await stageExecutable(
      binding.command[0] as string,
      binding.serverSha256,
      join(destination, executableName("language-server", binding.command[0] as string)),
    );
    if (process.platform !== "win32") await chmod(destination, 0o500);
    return {
      wrapperCommand: [wrapperPath, ...this.wrapperCommand.slice(1)],
      serverCommand: [serverPath, ...binding.command.slice(1)],
    };
  }
}

export async function loadLspAttestationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedLspAttestation | null> {
  const rawPath = environment.WHAT_THE_REPO_LSP_ATTESTATION?.trim() ?? "";
  const rawDigest = environment.WHAT_THE_REPO_LSP_ATTESTATION_SHA256?.trim().toLowerCase() ?? "";
  if (!rawPath && !rawDigest) return null;
  if (!rawPath || !rawDigest) {
    throw new LspAttestationError(
      "WHAT_THE_REPO_LSP_ATTESTATION and WHAT_THE_REPO_LSP_ATTESTATION_SHA256 must be set together",
    );
  }
  return loadLspAttestation(rawPath, rawDigest);
}

export async function loadLspAttestation(
  path: string,
  expectedSha256: string,
): Promise<VerifiedLspAttestation> {
  if (!SHA256_PATTERN.test(expectedSha256)) throw new LspAttestationError("LSP attestation SHA-256 is malformed");
  const attestationPath = await trustedRegularPath(path, "attestation", MAX_ATTESTATION_BYTES);
  const document = asRecord(await readVerifiedJson(attestationPath, expectedSha256, MAX_ATTESTATION_BYTES), "attestation");
  if (document.schema_version !== "lsp-attestation-v1") throw new LspAttestationError("unsupported LSP attestation schema");

  const implementation = requiredText(document.implementation, "attestation implementation", 200);
  const wrapperCommand = command(document.wrapper_command, "sandbox wrapper");
  const wrapperSha256 = sha(document.wrapper_sha256, "sandbox wrapper SHA-256");
  const wrapperVersion = requiredText(document.wrapper_version, "sandbox wrapper version", 200);
  const verifiedWrapper = await verifiedExecutable(wrapperCommand[0] as string, wrapperSha256, "sandbox wrapper");
  wrapperCommand[0] = verifiedWrapper;

  const probePath = await trustedRegularPath(
    requiredText(document.sandbox_probe_path, "sandbox probe path", 4096),
    "sandbox probe",
    MAX_ATTESTATION_BYTES,
  );
  const probe = asRecord(await readVerifiedJson(
    probePath,
    sha(document.sandbox_probe_sha256, "sandbox probe SHA-256"),
    MAX_ATTESTATION_BYTES,
  ), "sandbox probe");
  if (probe.schema_version !== "lsp-sandbox-probe-v1") throw new LspAttestationError("unsupported LSP sandbox probe schema");
  const requiredBoundaries = [
    "passed",
    "network_disabled",
    "target_filesystem_hidden",
    "write_root_enforced",
    "process_limit_enforced",
    "memory_limit_enforced",
    "process_tree_cleanup_verified",
  ];
  if (!requiredBoundaries.every((field) => probe[field] === true)) {
    throw new LspAttestationError("LSP sandbox probe did not pass every required boundary");
  }
  if (probe.platform !== process.platform) throw new LspAttestationError("LSP sandbox probe was produced for another platform");
  if (
    probe.wrapper_sha256 !== wrapperSha256
    || probe.wrapper_version !== wrapperVersion
    || probe.wrapper_command_digest !== lspCommandDigest(wrapperCommand)
  ) {
    throw new LspAttestationError("LSP sandbox probe does not bind the declared wrapper");
  }

  const rawLanguages = asRecord(document.languages, "attested languages");
  const languages = new Map<string, VerifiedLanguageAttestation>();
  for (const [language, rawBinding] of Object.entries(rawLanguages)) {
    if (!languageById(language)) throw new LspAttestationError(`unsupported attested LSP language: ${language}`);
    const binding = asRecord(rawBinding, `${language} language attestation`);
    const serverCommand = command(binding.server_command, `${language} language server`);
    const serverSha256 = sha(binding.server_sha256, `${language} server SHA-256`);
    serverCommand[0] = await verifiedExecutable(
      serverCommand[0] as string,
      serverSha256,
      `${language} language server`,
    );
    const truthPath = await trustedRegularPath(
      requiredText(binding.truth_artifact_path, `${language} truth artifact path`, 4096),
      `${language} truth artifact`,
      MAX_ATTESTATION_BYTES,
    );
    const truthArtifactSha256 = sha(binding.truth_artifact_sha256, `${language} truth artifact SHA-256`);
    const truth = asRecord(await readVerifiedJson(truthPath, truthArtifactSha256, MAX_ATTESTATION_BYTES), `${language} truth artifact`);
    if (truth.schema_version !== "lsp-language-truth-v1" || truth.passed !== true || truth.language !== language) {
      throw new LspAttestationError(`${language} LSP truth suite did not pass`);
    }
    const expectedFixture = LSP_TRUTH_FIXTURE_DIGESTS[language];
    if (!expectedFixture || truth.fixture_digest !== expectedFixture) {
      throw new LspAttestationError(`${language} LSP truth artifact uses another fixture suite`);
    }
    const serverVersion = requiredText(binding.server_version, `${language} server version`, 200);
    if (
      truth.server_sha256 !== serverSha256
      || truth.server_version !== serverVersion
      || truth.server_command_digest !== lspCommandDigest(serverCommand)
    ) {
      throw new LspAttestationError(`${language} LSP truth artifact does not bind the declared server`);
    }
    const capabilities = textArray(truth.capabilities, `${language} truth capabilities`, 20);
    languages.set(language, {
      command: serverCommand,
      serverSha256,
      serverVersion,
      capabilities,
      truthArtifactSha256,
    });
  }
  if (!languages.size || languages.size > 9) throw new LspAttestationError("LSP attestation must bind between one and nine languages");

  return new VerifiedLspAttestation(
    implementation,
    wrapperCommand,
    wrapperSha256,
    wrapperVersion,
    {
      implementation,
      version: wrapperVersion,
      networkDisabled: true,
      targetFilesystemHidden: true,
      writeRootEnforced: true,
      processLimitEnforced: true,
      memoryLimitEnforced: true,
      processTreeCleanupVerified: true,
    },
    languages,
  );
}

export function lspCommandDigest(value: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readVerifiedJson(path: string, expectedSha256: string, maxBytes: number): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new LspAttestationError("attestation artifact is not a bounded regular file");
  const raw = await readFile(path);
  if (createHash("sha256").update(raw).digest("hex") !== expectedSha256) throw new LspAttestationError("attestation artifact digest changed");
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new LspAttestationError("attestation artifact is not valid JSON");
  }
}

async function trustedRegularPath(path: string, label: string, maxBytes: number): Promise<string> {
  if (!isAbsolute(path)) throw new LspAttestationError(`${label} path must be absolute`);
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new LspAttestationError(`${label} must be a bounded regular file`);
  }
  return realpath(path);
}

async function verifiedExecutable(path: string, expectedSha256: string, label: string): Promise<string> {
  const verifiedPath = await trustedRegularPath(path, label, MAX_EXECUTABLE_BYTES);
  if (await sha256File(verifiedPath) !== expectedSha256) throw new LspAttestationError(`${label} digest changed`);
  return verifiedPath;
}

async function stageExecutable(source: string, expectedSha256: string, destination: string): Promise<string> {
  if (await sha256File(source) !== expectedSha256) throw new LspAttestationError("attested executable changed before staging");
  await copyFile(source, destination);
  if (await sha256File(destination) !== expectedSha256) throw new LspAttestationError("staged executable digest mismatch");
  if (process.platform !== "win32") await chmod(destination, 0o500);
  return realpath(destination);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function executableName(role: string, source: string): string {
  const suffix = process.platform === "win32" && source.toLowerCase().endsWith(".exe") ? ".exe" : "";
  return `${role}${suffix}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LspAttestationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new LspAttestationError(`${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw new LspAttestationError(`${label} is malformed`);
  return text;
}

function textArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) throw new LspAttestationError(`${label} is invalid`);
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, 200));
}

function command(value: unknown, label: string): string[] {
  const items = textArray(value, `${label} command`, 20);
  if (!isAbsolute(items[0] as string)) throw new LspAttestationError(`${label} executable path must be absolute`);
  return items;
}
