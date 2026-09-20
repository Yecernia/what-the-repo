import assert from 'node:assert/strict';
import test from 'node:test';
import { lspConfiguration, lspInitializationOptions, lspSafeCommand, unsafeLspWorkspaceConfiguration } from './lsp-policy.js';
import { analyzeLspRequest } from './lsp-worker.js';

test('untrusted LSP policy disables build execution in initialization and configuration replies', () => {
  const rust = lspInitializationOptions('rust') as { cargo: { buildScripts: { enable: boolean } }; procMacro: { enable: boolean }; checkOnSave: boolean };
  assert.equal(rust.cargo.buildScripts.enable, false);
  assert.equal(rust.procMacro.enable, false);
  assert.equal(rust.checkOnSave, false);
  assert.equal(lspConfiguration('rust', 'rust-analyzer.procMacro.enable'), false);
  assert.equal(lspConfiguration('java', 'java.import.gradle.enabled'), false);
  assert.equal(lspConfiguration('java', 'java.import.maven.enabled'), false);
  assert.equal(lspConfiguration('java', 'java.autobuild.enabled'), false);
  assert.equal(lspConfiguration('go', 'gopls.env.GOTOOLCHAIN'), 'local');
  assert.equal(lspConfiguration('rust', '__proto__'), null);
  assert.equal(lspConfiguration('rust', 'constructor'), null);
  assert.deepEqual(lspSafeCommand('cpp', ['/trusted/clangd']).slice(1),
    ['--enable-config=0', '--background-index=0', '--clang-tidy=0', '--query-driver=']);
});

test('unsafe project execution overrides decline enrichment before launching any process', async () => {
  for (const [language, config] of [['rust', 'nested/.cargo/config.toml'], ['rust', 'rust-toolchain'],
    ['cpp', 'compile_commands.json'], ['cpp', 'nested/.clangd'], ['csharp', 'demo.csproj']]) {
    const reason = unsafeLspWorkspaceConfiguration(language!, [config!]);
    assert.ok(reason);
    const result = await analyzeLspRequest({ language: language!, serverCommand: ['/nonexistent/server'],
      sourceRoot: '/nonexistent/source', files: [config!], workspaceFiles: [config!],
      requestTimeoutMs: 1000, maxSymbols: 10, maxRelations: 10 });
    assert.equal(result.completed, false);
    assert.ok(result.reasonCodes.includes(reason));
  }
  assert.equal(unsafeLspWorkspaceConfiguration('rust', ['Cargo.toml', 'build.rs', 'src/lib.rs']), null);
});
