import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxedLspRunner } from './lsp.js';
import { VerifiedLspAttestation } from './lsp-attestation.js';
import { decodeSource } from './source-input.js';

test('attested runner distinguishes omitted LSP version from conflicting version/capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-lsp-identity-'));
  const source = join(root, 'source');
  await mkdir(source);
  const raw = Buffer.from('def run(): pass\n');
  await writeFile(join(source, 'main.py'), raw);
  try {
    for (const [version, expectedVersion, capabilities, verified] of [[null, '1.0', ['document_symbols'], true], ['1.0', '1.0', ['document_symbols'], true],
      ['2.0', '1.0', ['document_symbols'], false], ['1.0', '1.0', [], false],
      ['v'.repeat(500), 'v'.repeat(500), ['document_symbols'], true],
      ['v'.repeat(500) + 'a', 'v'.repeat(500) + 'b', ['document_symbols'], false]] as const) {
      const result = { language: 'python', serverName: 'fixture', serverVersion: version, capabilities,
        completed: true, reasonCodes: [], symbols: [], relations: [] };
      const wrapper = join(root, 'wrapper.cjs');
      // Controlled transport fixture: it writes a result instead of launching a
      // language server. This is not an OS isolation or attestation probe.
      await writeFile(wrapper, `require('fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify(result))});`);
      const attestation = new VerifiedLspAttestation('fixture', [], '', '', {
        implementation: 'fixture', version: 'fixture', networkDisabled: true, targetFilesystemHidden: true,
        writeRootEnforced: true, processLimitEnforced: true, memoryLimitEnforced: true, processTreeCleanupVerified: true,
      }, new Map([['python', { command: [process.execPath], serverSha256: '', serverVersion: expectedVersion,
        capabilities: ['document_symbols'], truthArtifactSha256: '' }]]));
      attestation.stageForExecution = async () => ({ wrapperCommand: [process.execPath, wrapper], serverCommand: [process.execPath] });
      const run = await new SandboxedLspRunner(attestation).analyze({ language: 'python',
        files: [decodeSource('main.py', raw).file], sourceRoot: source, runtimeRoot: join(root, 'runtime') });
      assert.equal(run.toolchainVerified, verified);
      assert.equal(run.completed, verified);
      if (version === null) assert.ok(run.reasonCodes.includes('lsp_server_version_not_reported'));
      if (version === '2.0') assert.ok(run.reasonCodes.includes('lsp_server_version_mismatch'));
      if (!capabilities.length) assert.ok(run.reasonCodes.includes('lsp_truth_capability_mismatch'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
