import { loadConfig } from "./config.js";
import { importFileStoreData } from "./persistence/import-file-store.js";
import { PostgresStore } from "./persistence/postgres-store.js";
import { createProductStore } from "./persistence/factory.js";

const command = process.argv[2] ?? "migrate";
const config = loadConfig();
const store = createProductStore(config, "migration");
if (!(store instanceof PostgresStore)) {
  throw new Error("DATABASE_URL is required for database commands");
}
await store.init();
try {
  if (command === "migrate") {
    process.stdout.write(`${JSON.stringify({ ok: true, command, storage: "postgres" })}\n`);
  } else if (command === "import-files") {
    const counts = await importFileStoreData({
      root: config.dataDir,
      sessionRoot: config.sessionDir,
      memoryRoot: config.memoryDir,
      target: store,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, command, counts })}\n`);
  } else {
    throw new Error("unknown database command; use migrate or import-files");
  }
} finally {
  await store.close();
}
