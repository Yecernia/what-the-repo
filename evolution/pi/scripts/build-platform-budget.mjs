import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import ts from 'typescript';

// Package the shared admission implementation and its relative runtime imports.
// Do not execute source modules or depend on a prebuilt server/dist directory.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = join(root, 'server/src');
const outputRoot = join(root, 'server/dist');
const pending = ['agent/provider-budget.ts', 'agent/mutex.ts', 'agent/provider-gate.ts', 'scheduling/config.ts'];
const written = new Set();
while (pending.length) {
  const name = pending.pop();
  if (written.has(name)) continue;
  const sourcePath = resolve(sourceRoot, name);
  const sourceRelative = relative(sourceRoot, sourcePath);
  if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || !name.endsWith('.ts')) {
    throw new Error(`Shared runtime import is outside server/src: ${name}`);
  }
  const source = await readFile(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const outputPath = resolve(outputRoot, name.replace(/\.ts$/, '.js'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.outputText);
  written.add(name);
  for (const imported of ts.preProcessFile(result.outputText).importedFiles) {
    if (!imported.fileName.startsWith('.')) continue;
    if (!imported.fileName.endsWith('.js')) {
      throw new Error(`Unsupported shared runtime import: ${imported.fileName}`);
    }
    pending.push(relative(sourceRoot, resolve(dirname(sourcePath), imported.fileName.replace(/\.js$/, '.ts'))));
  }
}
console.log(`Shared runtime packaged: ${written.size} source modules.`);
