import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { languageById } from "./languages.js";
import { LSP_POLICY_VERSION } from './lsp-policy.js';

const MAX_ATTESTATION_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const LSP_TRUTH_FIXTURE_DIGESTS: Readonly<Record<string, string>> = {
  "cpp": "0540a3eaee92bba0beaaabefb85fa48b07cbb855ecc8b338cc15ca23ec644941",
  "csharp": "923afa3e3d3b8c609e9bab8842a28b355f33e0cafaf8c7deb81b3654290e1603",
  "go": "c6494b818127f1556dc20c35c4b733769cd37f397ecf8b91d6909be090e0931b",
  "java": "9b7ac5fd7378cd66b2f9b1fcd9aa76af34a8259e07e848e2e96a91d8e318e851",
  "javascript": "2934c346127be1e88e0b28d0588b85d1ca69eeb25c3909163d2cb8b940c78990",
  "php": "477a6ec986d9b9093325c5e219b65cf99da4f214336e05f35a44e0c20898c50e",
  "python": "2b05f71be8fdcae1d57f634056d4c2b4b1d6c1a8b9fa00c8a8a9a3952856e57d",
  "rust": "225b16341cd7aba4422e6a6767ee920990ea27683c89003fbc3d0d406ba9ce17",
  "typescript": "3d4f543b2f8f19a445cb5e25902e729d08c20c50df3a3f11393435d298e7e234"
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
  runtimeBundle?: RuntimeBundle;
}

export interface RuntimeBundle {
  root: string;
  files: Array<{ path: string; sha256: string }>;
}
export function runtimeBundleDigest(bundle: RuntimeBundle | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        bundle
          ? [...bundle.files].sort((a, b) => a.path.localeCompare(b.path))
          : "standalone",
      ),
    )
    .digest("hex");
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
    readonly wrapperRuntimeBundle?: RuntimeBundle,
  ) {}

  commandFor(language: string): string[] | null {
    return this.languages.get(language)?.command ?? null;
  }

  async stageForExecution(
    language: string,
    destination: string,
  ): Promise<StagedLspCommands> {
    const binding = this.languages.get(language);
    if (!binding)
      throw new LspAttestationError(
        `${language} language server is not attested`,
      );
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const wrapperCommand = await stageCommand(
      this.wrapperCommand,
      this.wrapperSha256,
      this.wrapperRuntimeBundle,
      destination,
      "sandbox-wrapper",
    );
    const stagedBundle = binding.runtimeBundle
      ? await stageRuntimeBundle(
          binding.runtimeBundle,
          join(destination, "runtime"),
        )
      : null;
    const serverPath = stagedBundle
      ? join(
          stagedBundle,
          relative(binding.runtimeBundle!.root, binding.command[0]!),
        )
      : await stageExecutable(
          binding.command[0] as string,
          binding.serverSha256,
          join(
            destination,
            executableName("language-server", binding.command[0] as string),
          ),
        );
    if (process.platform !== "win32") await chmod(destination, 0o500);
    return {
      wrapperCommand,
      serverCommand: [
        serverPath,
        ...binding.command.slice(1).map((argument) => {
          if (!stagedBundle || !isAbsolute(argument)) return argument;
          const path = relative(binding.runtimeBundle!.root, argument);
          if (path.startsWith("..") || isAbsolute(path))
            throw new LspAttestationError(
              "server argument outside runtime bundle",
            );
          return join(stagedBundle, path);
        }),
      ],
    };
  }
}

export async function loadLspAttestationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedLspAttestation | null> {
  const rawPath = environment.WHAT_THE_REPO_LSP_ATTESTATION?.trim() ?? "";
  const rawDigest =
    environment.WHAT_THE_REPO_LSP_ATTESTATION_SHA256?.trim().toLowerCase() ??
    "";
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
  if (!SHA256_PATTERN.test(expectedSha256))
    throw new LspAttestationError("LSP attestation SHA-256 is malformed");
  const attestationPath = await trustedRegularPath(
    path,
    "attestation",
    MAX_ATTESTATION_BYTES,
  );
  const document = asRecord(
    await readVerifiedJson(
      attestationPath,
      expectedSha256,
      MAX_ATTESTATION_BYTES,
    ),
    "attestation",
  );
  if (document.schema_version !== "lsp-attestation-v2")
    throw new LspAttestationError("unsupported LSP attestation schema");

  const implementation = requiredText(
    document.implementation,
    "attestation implementation",
    200,
  );
  const wrapperCommand = command(document.wrapper_command, "sandbox wrapper");
  const wrapperSha256 = sha(document.wrapper_sha256, "sandbox wrapper SHA-256");
  const wrapperVersion = requiredText(
    document.wrapper_version,
    "sandbox wrapper version",
    200,
  );
  if (!["standalone", "bundle"].includes(String(document.wrapper_runtime_mode)))
    throw new LspAttestationError("explicit wrapper runtime mode required");
  const wrapperRuntimeBundle =
    document.wrapper_runtime_mode === "bundle"
      ? await readRuntimeBundle(document.wrapper_runtime_bundle)
      : undefined;
  const verifiedWrapper = await verifiedExecutable(
    wrapperCommand[0] as string,
    wrapperSha256,
    "sandbox wrapper",
  );
  wrapperCommand[0] = verifiedWrapper;
  if (
    wrapperRuntimeBundle &&
    !wrapperRuntimeBundle.files.some(
      (file) =>
        resolve(wrapperRuntimeBundle.root, file.path) === verifiedWrapper,
    )
  )
    throw new LspAttestationError("wrapper inventory omits executable");

  const probePath = await trustedRegularPath(
    requiredText(document.sandbox_probe_path, "sandbox probe path", 4096),
    "sandbox probe",
    MAX_ATTESTATION_BYTES,
  );
  const probe = asRecord(
    await readVerifiedJson(
      probePath,
      sha(document.sandbox_probe_sha256, "sandbox probe SHA-256"),
      MAX_ATTESTATION_BYTES,
    ),
    "sandbox probe",
  );
  if (probe.schema_version !== "lsp-sandbox-probe-v1")
    throw new LspAttestationError("unsupported LSP sandbox probe schema");
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
    throw new LspAttestationError(
      "LSP sandbox probe did not pass every required boundary",
    );
  }
  if (probe.platform !== process.platform)
    throw new LspAttestationError(
      "LSP sandbox probe was produced for another platform",
    );
  if (
    probe.wrapper_sha256 !== wrapperSha256 ||
    probe.wrapper_version !== wrapperVersion ||
    probe.wrapper_command_digest !== lspCommandDigest(wrapperCommand) ||
    probe.wrapper_runtime_digest !== runtimeBundleDigest(wrapperRuntimeBundle)
  ) {
    throw new LspAttestationError(
      "LSP sandbox probe does not bind the declared wrapper",
    );
  }

  const rawLanguages = asRecord(document.languages, "attested languages");
  const languages = new Map<string, VerifiedLanguageAttestation>();
  for (const [language, rawBinding] of Object.entries(rawLanguages)) {
    if (!languageById(language))
      throw new LspAttestationError(
        `unsupported attested LSP language: ${language}`,
      );
    const binding = asRecord(rawBinding, `${language} language attestation`);
    if (!["standalone", "bundle"].includes(String(binding.runtime_mode)))
      throw new LspAttestationError("explicit runtime mode required");
    const runtimeBundle =
      binding.runtime_mode === "bundle"
        ? await readRuntimeBundle(binding.runtime_bundle)
        : undefined;
    const serverCommand = command(
      binding.server_command,
      `${language} language server`,
    );
    const serverSha256 = sha(
      binding.server_sha256,
      `${language} server SHA-256`,
    );
    serverCommand[0] = await verifiedExecutable(
      serverCommand[0] as string,
      serverSha256,
      `${language} language server`,
    );
    if (
      runtimeBundle &&
      !runtimeBundle.files.some(
        (file) =>
          resolve(runtimeBundle.root, file.path) === resolve(serverCommand[0]!),
      )
    )
      throw new LspAttestationError("runtime inventory omits executable");
    const truthPath = await trustedRegularPath(
      requiredText(
        binding.truth_artifact_path,
        `${language} truth artifact path`,
        4096,
      ),
      `${language} truth artifact`,
      MAX_ATTESTATION_BYTES,
    );
    const truthArtifactSha256 = sha(
      binding.truth_artifact_sha256,
      `${language} truth artifact SHA-256`,
    );
    const truth = asRecord(
      await readVerifiedJson(
        truthPath,
        truthArtifactSha256,
        MAX_ATTESTATION_BYTES,
      ),
      `${language} truth artifact`,
    );
    if (
      truth.schema_version !== "lsp-language-truth-v1" ||
      truth.passed !== true ||
      truth.execution_policy !== LSP_POLICY_VERSION ||
      truth.language !== language
    ) {
      throw new LspAttestationError(`${language} LSP truth suite did not pass`);
    }
    const expectedFixture = LSP_TRUTH_FIXTURE_DIGESTS[language];
    if (!expectedFixture || truth.fixture_digest !== expectedFixture) {
      throw new LspAttestationError(
        `${language} LSP truth artifact uses another fixture suite`,
      );
    }
    const serverVersion = requiredText(
      binding.server_version,
      `${language} server version`,
      200,
    );
    if (
      truth.server_sha256 !== serverSha256 ||
      truth.runtime_digest !== runtimeBundleDigest(runtimeBundle) ||
      truth.server_version !== serverVersion ||
      truth.server_command_digest !== lspCommandDigest(serverCommand)
    ) {
      throw new LspAttestationError(
        `${language} LSP truth artifact does not bind the declared server`,
      );
    }
    const capabilities = textArray(
      truth.capabilities,
      `${language} truth capabilities`,
      20,
    );
    languages.set(language, {
      command: serverCommand,
      serverSha256,
      serverVersion,
      capabilities,
      truthArtifactSha256,
      runtimeBundle,
    });
  }
  if (!languages.size || languages.size > 9)
    throw new LspAttestationError(
      "LSP attestation must bind between one and nine languages",
    );

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
    wrapperRuntimeBundle,
  );
}

export function lspCommandDigest(value: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readVerifiedJson(
  path: string,
  expectedSha256: string,
  maxBytes: number,
): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new LspAttestationError(
      "attestation artifact is not a bounded regular file",
    );
  const raw = await readFile(path);
  if (createHash("sha256").update(raw).digest("hex") !== expectedSha256)
    throw new LspAttestationError("attestation artifact digest changed");
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new LspAttestationError("attestation artifact is not valid JSON");
  }
}

async function trustedRegularPath(
  path: string,
  label: string,
  maxBytes: number,
): Promise<string> {
  if (!isAbsolute(path))
    throw new LspAttestationError(`${label} path must be absolute`);
  const info = await lstat(path).catch(() => null);
  if (
    !info ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maxBytes
  ) {
    throw new LspAttestationError(`${label} must be a bounded regular file`);
  }
  return realpath(path);
}

async function verifiedExecutable(
  path: string,
  expectedSha256: string,
  label: string,
): Promise<string> {
  const verifiedPath = await trustedRegularPath(
    path,
    label,
    MAX_EXECUTABLE_BYTES,
  );
  if ((await sha256File(verifiedPath)) !== expectedSha256)
    throw new LspAttestationError(`${label} digest changed`);
  return verifiedPath;
}

async function stageExecutable(
  source: string,
  expectedSha256: string,
  destination: string,
): Promise<string> {
  if ((await sha256File(source)) !== expectedSha256)
    throw new LspAttestationError("attested executable changed before staging");
  await copyFile(source, destination);
  if ((await sha256File(destination)) !== expectedSha256)
    throw new LspAttestationError("staged executable digest mismatch");
  if (process.platform !== "win32") await chmod(destination, 0o500);
  return realpath(destination);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function executableName(role: string, source: string): string {
  const suffix =
    process.platform === "win32" && source.toLowerCase().endsWith(".exe")
      ? ".exe"
      : "";
  return `${role}${suffix}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LspAttestationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw new LspAttestationError(`${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const text = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(text))
    throw new LspAttestationError(`${label} is malformed`);
  return text;
}

function textArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems)
    throw new LspAttestationError(`${label} is invalid`);
  return value.map((item, index) =>
    requiredText(item, `${label}[${index}]`, 200),
  );
}

function command(value: unknown, label: string): string[] {
  const items = textArray(value, `${label} command`, 20);
  if (!isAbsolute(items[0] as string))
    throw new LspAttestationError(`${label} executable path must be absolute`);
  return items;
}

async function readRuntimeBundle(value: unknown): Promise<RuntimeBundle> {
  const row = asRecord(value, "runtime bundle");
  const root = await realpath(requiredText(row.root, "runtime root", 4096));
  if (
    !Array.isArray(row.files) ||
    !row.files.length ||
    row.files.length > 30000
  )
    throw new LspAttestationError("runtime inventory invalid");
  const files: RuntimeBundle["files"] = [];
  const paths = new Set<string>();
  let bytes = 0;
  for (const value of row.files) {
    const entry = asRecord(value, "runtime file"),
      path = requiredText(entry.path, "runtime path", 4096);
    if (
      path.includes("\\") ||
      path.includes(":") ||
      path.startsWith("/") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      paths.has(path)
    )
      throw new LspAttestationError("unsafe runtime path");
    paths.add(path);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new LspAttestationError("runtime symlink forbidden");
    }
    bytes += (await lstat(current)).size;
    if (bytes > MAX_RUNTIME_BYTES)
      throw new LspAttestationError("runtime size limit exceeded");
    const digest = sha(entry.sha256, "runtime file digest");
    await verifiedExecutable(current, digest, "runtime file");
    files.push({ path, sha256: digest });
  }
  return { root, files };
}
async function stageRuntimeBundle(
  bundle: RuntimeBundle,
  destination: string,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  for (const file of bundle.files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await stageExecutable(
      join(bundle.root, ...file.path.split("/")),
      file.sha256,
      target,
    );
  }
  return realpath(destination);
}

async function stageCommand(
  command: string[],
  digest: string,
  bundle: RuntimeBundle | undefined,
  destination: string,
  role: string,
): Promise<string[]> {
  if (!bundle)
    return [
      await stageExecutable(
        command[0]!,
        digest,
        join(destination, executableName(role, command[0]!)),
      ),
      ...command.slice(1),
    ];
  const root = await stageRuntimeBundle(bundle, join(destination, role));
  return command.map((argument, index) => {
    if (index && !isAbsolute(argument)) return argument;
    const path = relative(bundle.root, argument);
    if (path.startsWith("..") || isAbsolute(path))
      throw new LspAttestationError("command argument outside runtime bundle");
    return join(root, path);
  });
}
