import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

test("every forward migration records its own schema version", async () => {
  const root = join(process.cwd(), "migrations");
  const names = (await readdir(root))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .sort();

  assert.ok(names.length > 0);
  for (const name of names) {
    const version = name.replace(/\.sql$/, "");
    const sql = await readFile(join(root, name), "utf8");
    assert.match(sql, /INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*\)/i, `${name} must record its version`);
    assert.ok(sql.includes(`VALUES ('${version}')`), `${name} must record ${version}`);
  }
});

test("canonical payload migration removes persistent inline bodies and bounds chat context", async () => {
  const sql = await readFile(join(process.cwd(), "migrations", "0039_canonical_object_payloads.sql"), "utf8");
  assert.match(sql, /DROP COLUMN view_payload/);
  assert.match(sql, /DROP COLUMN analysis_payload/);
  assert.match(sql, /octet_length\(conversation_summary_payload::text\) <= 32768/);
  assert.match(sql, /storage_format_reset_required/);
  assert.doesNotMatch(sql, /UPDATE canonical_public_repository_snapshots/);
});
