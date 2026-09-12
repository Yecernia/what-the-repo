import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { loadConfig } from "../config.js";
import {
  TencentCosObjectStore,
  tencentCosClientOptions,
} from "../persistence/snapshot-object-store.js";
import {
  cosSmokeRunPrefix,
  runTencentCosObjectSmoke,
  TencentCosSmokeAdmin,
} from "./tencent-cos-object-store.js";

function required(value: string | null | undefined, code: string): string {
  if (!value?.trim()) throw Object.assign(new Error(code), { code });
  return value.trim();
}

function smokeRunId(value: string | undefined): string {
  if (value?.trim()) return value.trim();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").toLowerCase();
  return `${timestamp}-${randomUUID().toLowerCase()}`;
}

function safeFailure(error: unknown): { name: string; code: string; status_code: number | null } {
  if (!error || typeof error !== "object") {
    return { name: "Error", code: "cos_smoke_unknown_error", status_code: null };
  }
  const row = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  return {
    name: typeof row.name === "string" ? row.name : "Error",
    code: typeof row.code === "string" ? row.code : "cos_smoke_failed",
    status_code: Number.isInteger(Number(row.statusCode)) ? Number(row.statusCode) : null,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

let sourceRoot: string | null = null;
let reportPath = resolve(process.cwd(), "out", "tencent-cos-smoke", "report.json");
try {
  const env = { ...process.env, WHAT_THE_REPO_LOAD_LOCAL_ENV: "0" };
  const config = loadConfig(env);
  reportPath = resolve(
    process.env.WTR_COS_SMOKE_REPORT_PATH
      ?? join(config.root, "out", "tencent-cos-smoke", "report.json"),
  );
  const bucket = required(config.cosBucket, "cos_smoke_bucket_required");
  const region = required(config.cosRegion, "cos_smoke_region_required");
  const secretId = required(config.cosSecretId, "cos_smoke_secret_id_required");
  const secretKey = required(config.cosSecretKey, "cos_smoke_secret_key_required");
  const securityToken = required(config.cosSecurityToken, "cos_smoke_temporary_sts_token_required");
  const runId = smokeRunId(process.env.WTR_COS_SMOKE_RUN_ID);
  const runPrefix = cosSmokeRunPrefix(config.cosPrefix ?? "what-the-repo", runId);
  const objectOptions = {
    bucket,
    region,
    secretId,
    secretKey,
    securityToken,
    prefix: runPrefix,
    domain: config.cosDomain ?? undefined,
  };

  sourceRoot = await mkdtemp(join(tmpdir(), "what-the-repo-cos-smoke-"));
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "README.md"), "Tencent COS smoke source snapshot.\n", "utf8");
  await writeFile(join(sourceRoot, "src", "index.ts"), "export const smoke = true;\n", "utf8");
  await writeFile(join(sourceRoot, ".snapshot-meta.json"), "{}\n", "utf8");

  const client = new COS(tencentCosClientOptions(objectOptions));
  const report = await runTencentCosObjectSmoke({
    runId,
    bucket,
    region,
    runPrefix,
    sourceRoot,
    writer: new TencentCosObjectStore(objectOptions),
    reader: new TencentCosObjectStore(objectOptions),
    admin: new TencentCosSmokeAdmin(client, bucket, region),
  });
  await writeJson(reportPath, report);
  process.stdout.write(`Tencent COS smoke passed. Report: ${reportPath}\n`);
} catch (error) {
  const failure = safeFailure(error);
  await writeJson(reportPath, {
    ok: false,
    finished_at: new Date().toISOString(),
    error: failure,
  }).catch(() => undefined);
  process.stderr.write(`Tencent COS smoke failed: ${failure.code}${
    failure.status_code === null ? "" : ` (HTTP ${failure.status_code})`
  }\n`);
  process.exitCode = 1;
} finally {
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
}
