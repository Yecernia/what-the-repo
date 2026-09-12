import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readEvolutionDatabaseUrl,
  readEvolutionProviderKey,
} from "../src/production-composition.js";

async function secretRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "what-the-repo-evolution-secrets-"));
}

test("evolution production composition reads database and Provider secrets from files", async () => {
  const root = await secretRoot();
  await writeFile(join(root, "database-url"), "postgresql://runtime:secret@postgres/what_the_repo\n", { mode: 0o600 });
  await writeFile(join(root, "provider-key"), "provider-secret\n", { mode: 0o600 });

  assert.equal(await readEvolutionDatabaseUrl(root, {
    DATABASE_URL_FILE: "database-url",
  }), "postgresql://runtime:secret@postgres/what_the_repo");
  assert.equal(await readEvolutionProviderKey(root, {
    WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY_FILE: "provider-key",
  }), "provider-secret");
});

test("evolution production composition rejects direct and file secrets together", async () => {
  const root = await secretRoot();
  await writeFile(join(root, "database-url"), "postgresql://runtime:secret@postgres/what_the_repo\n", { mode: 0o600 });
  await assert.rejects(
    readEvolutionDatabaseUrl(root, {
      DATABASE_URL: "postgresql://direct/production",
      DATABASE_URL_FILE: "database-url",
    }),
    /DATABASE_URL and DATABASE_URL_FILE cannot both be configured/,
  );
});

test("evolution production composition keeps the database optional for file-store tests", async () => {
  assert.equal(await readEvolutionDatabaseUrl(await secretRoot(), {}), undefined);
});
