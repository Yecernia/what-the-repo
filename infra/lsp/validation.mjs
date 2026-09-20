import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, realpath, readdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { analyzeLspRequest } from './lsp-worker.js';
import { LSP_POLICY_VERSION } from './lsp-policy.js';

const mode = process.argv[2] ?? 'languages';
if (mode === 'memory') {
  const blocks = [];
  // Touch physical pages; do not mistake V8's virtual address reservation for RSS.
  for (;;) blocks.push(Buffer.alloc(16 * 1024 * 1024, 0xa5));
}
if (mode === 'cleanup') {
  const child = spawn('/bin/sleep', ['90'], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(JSON.stringify({ child: child.pid, parent: process.pid }));
  process.exit(0);
}
if (mode === 'bounds') {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
  const connected = await new Promise(resolve => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
  assert.equal(connected, false);
  assert.equal(process.env.WTR_SANDBOX_HOST_SENTINEL, undefined);
  await assert.rejects(access('/var/run/docker.sock'));
  await assert.rejects(access('/host-sentinel'));
  await assert.rejects(writeFile('/outside-write', 'forbidden'));
  await writeFile('/tmp/allowed-write', 'allowed');
  const memory = Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim());
  const pids = Number((await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim());
  assert.ok(memory > 0 && memory <= 1024 ** 3);
  assert.ok(pids > 0 && pids <= 128);
  const children = [];
  let refused = false;
  try {
    for (let i = 0; i < 150; i++) {
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      const started = await new Promise(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
      if (!started) { refused = true; break; }
      children.push(child);
    }
    assert.equal(refused, true);
  } finally { for (const child of children) child.kill('SIGKILL'); }
  console.log(JSON.stringify({ mode, passed: true, network_disabled: true, host_hidden: true,
    write_root_enforced: true, pids_enforced: refused, memory_max: memory, pids_max: pids }));
  process.exit(0);
}

await mkdir('/tmp/home', { recursive: true });
const cases = [
  { language: 'python', files: { 'main.py': 'def target():\n    return 1\n\ndef run():\n    return target()\n' },
    command: ['/usr/local/bin/node', '/opt/lsp/node_modules/pyright/langserver.index.js', '--stdio'] },
  { language: 'php', files: { 'main.php': '<?php function target() { return 1; } function run() { return target(); }' },
    command: ['/usr/local/bin/node', '/opt/lsp/node_modules/intelephense/lib/intelephense.js', '--stdio'] },
  { language: 'go', files: { 'go.mod': 'module fixture\n\ngo 1.23\n', 'main.go': 'package main\nfunc target() int {return 1}\nfunc run() int {return target()}\n' },
    command: ['/usr/bin/gopls', 'serve'] },
  { language: 'rust', files: { 'Cargo.toml': '[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'fn target()->i32 {1}\nfn run()->i32 {target()}\n',
      'build.rs': 'fn main() { std::fs::write("/tmp/UNTRUSTED_BUILD_EXECUTED", "unsafe").unwrap(); }' },
    command: ['/usr/bin/rust-analyzer'] },
  { language: 'cpp', files: { 'main.cpp': 'int target() {return 1;}\nint run() {return target();}\n' },
    command: ['/usr/local/bin/clangd'] },
];
if (process.env.WTR_TEST_JDTLS === '1') {
  const launcher = (await readdir('/opt/jdtls/plugins')).find(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
  assert.ok(launcher);
  await cp('/opt/jdtls/config_linux', '/tmp/jdt-config', { recursive: true });
  cases.push({ language: 'java', files: {
    '.project': '<projectDescription><name>fixture</name><projects/><buildSpec/><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>',
    '.classpath': '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>',
    'src/Main.java': 'class Main { static int target(){return 1;} static int run(){return target();} }' },
    command: ['/usr/bin/java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx512m', '-jar', '/opt/jdtls/plugins/' + launcher,
      '-configuration', '/tmp/jdt-config', '-data', '/tmp/jdt-data'] });
}
console.log(JSON.stringify({ mode, execution_policy: LSP_POLICY_VERSION,
  tools: Object.fromEntries([['go', '/usr/bin/go'], ['cargo', '/usr/bin/cargo'], ['rustc', '/usr/bin/rustc'], ['clangd', '/usr/local/bin/clangd']]
    .map(([name, command]) => [name, execFileSync(command, name === 'go' ? ['version'] : ['--version'], { encoding: 'utf8' }).trim()])) }));
for (const item of cases) {
  const root = await mkdtemp('/tmp/lsp-workspace-');
  for (const [path, content] of Object.entries(item.files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const paths = Object.keys(item.files);
  const result = await analyzeLspRequest({ language: item.language, serverCommand: [await realpath(item.command[0]), ...item.command.slice(1)],
    sourceRoot: root, files: paths.filter(path => /\.(py|php|go|rs|cpp|java)$/.test(path) && path !== 'build.rs'),
    workspaceFiles: paths, requestTimeoutMs: 20000, totalBudgetMs: 90000, maxSymbols: 100, maxRelations: 100 });
  console.log(JSON.stringify({ language: item.language, ...result }));
  // LSP names are display labels (JDT LS includes signatures). Validate exact
  // source selections and relation locations instead of comparing those labels.
  const selectionText = symbol => {
    const range = symbol.selection;
    if (!range || range.startLine !== range.endLine) return '';
    return item.files[symbol.path]?.split('\n')[range.startLine - 1]?.slice(range.startColumn, range.endColumn);
  };
  const caller = result.symbols.find(symbol => selectionText(symbol) === 'run');
  const callee = result.symbols.find(symbol => selectionText(symbol) === 'target');
  assert.ok(caller, `${item.language}: run declaration missing`);
  assert.ok(callee, `${item.language}: target declaration missing`);
  assert.equal(result.completed, true, `${item.language}: incomplete requests`);
  if (result.capabilities.includes('call_hierarchy'))
    assert.ok(result.relations.some(edge => edge.sourcePath === caller.path &&
      edge.sourceSelection?.startLine === caller.selection.startLine &&
      edge.sourceSelection?.startColumn === caller.selection.startColumn &&
      edge.targetPath === callee.path && edge.targetLine === callee.selection.startLine &&
      edge.targetColumn === callee.selection.startColumn), `${item.language}: run→target missing`);
  if (item.language === 'rust') await assert.rejects(access(join(root, 'target/debug/build')));
}
await assert.rejects(access('/tmp/UNTRUSTED_BUILD_EXECUTED'));
console.log(JSON.stringify({ passed: true, build_script_executed: false }));
