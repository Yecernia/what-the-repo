/** Operator-owned settings; repository/editor settings never override these. */
export const LSP_POLICY_VERSION = 'untrusted-source-v1';

export function lspSettings(language: string): Record<string, unknown> {
  switch (language) {
    case 'rust': return { 'rust-analyzer': {
      cargo: { buildScripts: { enable: false } },
      procMacro: { enable: false }, checkOnSave: false,
      check: { command: 'check', overrideCommand: null },
      cachePriming: { enable: false },
    } };
    case 'go': return { gopls: { analyses: {}, staticcheck: false,
      buildFlags: ['-mod=readonly', '-buildvcs=false'],
      env: { CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOENV: 'off', GOPROXY: 'off', GOSUMDB: 'off' },
    } };
    case 'java': return { java: {
      autobuild: { enabled: false },
      import: { maven: { enabled: false }, gradle: { enabled: false, offline: { enabled: true } } },
      configuration: { updateBuildConfiguration: 'disabled' },
      maven: { downloadSources: false }, references: { includeDecompiledSources: false },
    } };
    case 'python': return { python: { analysis: { autoSearchPaths: false, diagnosticMode: 'openFilesOnly' } },
      pyright: { disableOrganizeImports: true } };
    case 'php': return { intelephense: { telemetry: { enabled: false } } };
    default: return {};
  }
}

export function lspConfiguration(language: string, section: unknown): unknown {
  let value: unknown = lspSettings(language);
  if (typeof section !== 'string' || !section) return value;
  // rust-analyzer is a section name, while individual settings use dotted paths.
  for (const key of section.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function lspInitializationOptions(language: string): Record<string, unknown> {
  const settings = lspSettings(language);
  if (language === 'java') return { settings, bundles: [], extendedClientCapabilities: {} };
  if (language === 'rust') return settings['rust-analyzer'] as Record<string, unknown>;
  if (language === 'go') return settings.gopls as Record<string, unknown>;
  return {};
}

export function unsafeLspWorkspaceConfiguration(language: string, paths: readonly string[]): string | null {
  if (language === 'csharp') return 'lsp_msbuild_execution_not_permitted';
  // Cargo can replace the compiler before LSP settings take effect. Keep the
  // original configuration in the snapshot; decline enrichment rather than run
  // a silently altered project. Native syntax remains available.
  if (language === 'rust' && paths.some(path => /(^|\/)(?:\.cargo\/config(?:\.toml)?|rust-toolchain(?:\.toml)?|rust-analyzer\.toml)$/.test(path)))
    return 'lsp_repository_tool_override_not_permitted';
  // Compile databases/response files can load arbitrary compiler plugins. A
  // future adapter may whitelist flags; generic clangd must not consume them.
  if (language === 'cpp' && paths.some(path => /(^|\/)(?:\.clangd|compile_commands\.json|compile_flags\.txt)$/.test(path)))
    return 'lsp_repository_compiler_flags_not_permitted';
  return null;
}

export function lspSafeCommand(language: string, command: readonly string[]): string[] {
  return language === 'cpp' ? [...command, '--enable-config=0', '--background-index=0', '--clang-tidy=0', '--query-driver='] : [...command];
}
