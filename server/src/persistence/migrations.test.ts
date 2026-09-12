import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_INLINE_PUBLIC_SNAPSHOT_BYTES,
  shouldInlinePublicSnapshotPayload,
} from "./postgres-store.js";

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

test("large public snapshot payloads stay outside PostgreSQL jsonb", () => {
  assert.equal(shouldInlinePublicSnapshotPayload(MAX_INLINE_PUBLIC_SNAPSHOT_BYTES), true);
  assert.equal(shouldInlinePublicSnapshotPayload(MAX_INLINE_PUBLIC_SNAPSHOT_BYTES + 1), false);
});
