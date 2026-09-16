// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Execute only the launcher's environment-import function, never its service startup.
for (const launcher of ['start-local-dev-deps.ps1', 'start-local.ps1']) {
  for (const bom of [false, true]) {
    it.skipIf(process.platform !== 'win32')(`${launcher} preserves Unicode into Node (UTF-8 BOM=${bom})`, () => {
      const source = readFileSync(new URL(`../../scripts/${launcher}`, import.meta.url), 'utf8');
      const start = source.indexOf('function Import-LocalEnvironment {');
      const end = source.indexOf('\nfunction ', start + 1);
      expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
      const folder = mkdtempSync(join(tmpdir(), 'wtr-env-encoding-'));
      const expected = '蜀ICP备2000000000号-1'; // Synthetic example, never a real account credential.
      const envFile = join(folder, 'local.env');
      const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
      try {
        writeFileSync(envFile, `${bom ? '\ufeff' : ''}VITE_ICP_RECORD=${expected}\n`, 'utf8');
        const command = source.slice(start, end) + `\nImport-LocalEnvironment -Path ${quote(envFile)}\n& ${quote(process.execPath)} -e "console.log(JSON.stringify([...process.env.VITE_ICP_RECORD].map(c=>c.codePointAt(0))))"`;
        const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000 });
        expect(JSON.parse(result.trim())).toEqual([...expected].map(c => c.codePointAt(0)));
      } finally { rmSync(folder, { recursive: true, force: true }); }
    });
  }
}
