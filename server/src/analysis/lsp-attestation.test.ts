import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import {
  LSP_TRUTH_FIXTURE_DIGESTS,
  loadLspAttestation,
  lspCommandDigest,
} from "./lsp-attestation.js";

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("LSP truth fixture digests match the versioned TypeScript Eval fixtures", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixtures = join(root, "eval", "fixtures", "language-truth");
  const languages = (await readdir(fixtures, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const actual: Record<string, string> = {};
  for (const language of languages) {
    const languageRoot = join(fixtures, language);
    const files = await listFiles(languageRoot);
    const digest = createHash("sha256");
    for (const path of files) {
      digest.update(relative(languageRoot, path).replaceAll("\\", "/"), "utf8");
      digest.update("\0", "utf8");
      digest.update(await readFile(path));
      digest.update("\0", "utf8");
    }
    actual[language] = digest.digest("hex");
  }
  assert.deepEqual(actual, LSP_TRUTH_FIXTURE_DIGESTS);
});

test("LSP attestation binds sandbox, server and the fixed truth suite", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-lsp-attestation-"));
  const stagedRoot = join(root, "staged");
  try {
    const wrapper = join(root, process.platform === "win32" ? "wrapper.exe" : "wrapper");
    const server = join(root, process.platform === "win32" ? "server.exe" : "server");
    await writeFile(wrapper, "trusted-wrapper", "utf8");
    await writeFile(server, "trusted-server", "utf8");
    const wrapperPath = await realpath(wrapper);
    const serverPath = await realpath(server);
    const wrapperSha = sha(await readFile(wrapperPath));
    const serverSha = sha(await readFile(serverPath));
    const probePath = join(root, "probe.json");
    const probe = {
      schema_version: "lsp-sandbox-probe-v1",
      platform: process.platform,
      wrapper_sha256: wrapperSha,
      wrapper_version: "test-wrapper-1",
      wrapper_command_digest: lspCommandDigest([wrapperPath]),
      passed: true,
      network_disabled: true,
      target_filesystem_hidden: true,
      write_root_enforced: true,
      process_limit_enforced: true,
      memory_limit_enforced: true,
      process_tree_cleanup_verified: true,
    };
    await writeFile(probePath, JSON.stringify(probe), "utf8");
    const truthPath = join(root, "truth.json");
    const truth = {
      schema_version: "lsp-language-truth-v1",
      language: "typescript",
      server_sha256: serverSha,
      server_version: "test-server-1",
      server_command_digest: lspCommandDigest([serverPath]),
      fixture_digest: LSP_TRUTH_FIXTURE_DIGESTS.typescript,
      passed: true,
      capabilities: ["document_symbols", "call_hierarchy", "type_hierarchy"],
    };
    await writeFile(truthPath, JSON.stringify(truth), "utf8");
    const attestationPath = join(root, "attestation.json");
    const attestation = {
      schema_version: "lsp-attestation-v1",
      implementation: "test-sandbox",
      wrapper_command: [wrapperPath],
      wrapper_sha256: wrapperSha,
      wrapper_version: "test-wrapper-1",
      sandbox_probe_path: probePath,
      sandbox_probe_sha256: sha(await readFile(probePath)),
      languages: {
        typescript: {
          server_command: [serverPath],
          server_sha256: serverSha,
          server_version: "test-server-1",
          truth_artifact_path: truthPath,
          truth_artifact_sha256: sha(await readFile(truthPath)),
        },
      },
    };
    await writeFile(attestationPath, JSON.stringify(attestation), "utf8");
    const verified = await loadLspAttestation(
      attestationPath,
      sha(await readFile(attestationPath)),
    );
    assert.deepEqual(verified.commandFor("typescript"), [serverPath]);
    assert.equal(verified.sandboxCapabilities.networkDisabled, true);
    const staged = await verified.stageForExecution("typescript", stagedRoot);
    assert.equal(sha(await readFile(staged.wrapperCommand[0] as string)), wrapperSha);
    assert.equal(sha(await readFile(staged.serverCommand[0] as string)), serverSha);
    if (process.platform !== "win32") {
      for (const path of [stagedRoot, staged.wrapperCommand[0] as string, staged.serverCommand[0] as string]) {
        assert.equal((await stat(path)).mode & 0o777, 0o500);
      }
    }
  } finally {
    // Staging deliberately removes write permission; restore it only for test cleanup.
    if (process.platform !== "win32") {
      await chmod(stagedRoot, 0o700).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
