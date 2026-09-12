import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PiSessionStore } from "../agent/session-store.js";
import type { PiSessionIdentity } from "../agent/types.js";
import { PostgresPiSessionBackend } from "../persistence/postgres-session-backend.js";

type SmokeRole = "holder" | "waiter";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function role(): SmokeRole {
  const value = required("WTR_SESSION_LOCK_SMOKE_ROLE");
  if (value !== "holder" && value !== "waiter") {
    throw new Error("WTR_SESSION_LOCK_SMOKE_ROLE must be holder or waiter");
  }
  return value;
}

function holdMilliseconds(value: string | undefined, currentRole: SmokeRole): number {
  if (!value?.trim()) return currentRole === "holder" ? 600_000 : 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("WTR_SESSION_LOCK_SMOKE_HOLD_MS must be a non-negative integer");
  }
  return parsed;
}

function optionalMilliseconds(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function phase(): string {
  const value = process.env.WTR_SESSION_LOCK_SMOKE_PHASE?.trim() || "takeover";
  if (!/^[a-z0-9-]{1,32}$/.test(value)) {
    throw new Error("WTR_SESSION_LOCK_SMOKE_PHASE must use lowercase letters, digits, or hyphens");
  }
  return value;
}

function event(currentRole: SmokeRole, name: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    event: name,
    role: currentRole,
    pid: process.pid,
    at: new Date().toISOString(),
    ...extra,
  })}\n`);
}

async function main(): Promise<void> {
  const currentRole = role();
  const currentPhase = phase();
  const databaseUrl = required("DATABASE_URL");
  const sessionId = required("WTR_SESSION_LOCK_SMOKE_SESSION_ID");
  const ownerId = required("WTR_SESSION_LOCK_SMOKE_OWNER_ID");
  const projectId = required("WTR_SESSION_LOCK_SMOKE_PROJECT_ID");
  const holdMs = holdMilliseconds(process.env.WTR_SESSION_LOCK_SMOKE_HOLD_MS, currentRole);
  const abortAfterMs = optionalMilliseconds("WTR_SESSION_LOCK_SMOKE_ABORT_AFTER_MS");
  const waitTimeoutMs = optionalMilliseconds("WTR_SESSION_LOCK_SMOKE_WAIT_TIMEOUT_MS");
  const expectedError = process.env.WTR_SESSION_LOCK_SMOKE_EXPECT_ERROR?.trim() || null;
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: `what-the-repo:session-lock-smoke:${currentPhase}:${currentRole}`,
    connectionTimeoutMillis: 10_000,
    max: 1,
  });
  const backend = new PostgresPiSessionBackend(pool);
  const sessions = new PiSessionStore(backend);
  const identity: PiSessionIdentity = {
    sessionId,
    ownerId,
    projectId,
    snapshotId: `session-lock-smoke:${currentPhase}:${currentRole}`,
    skillId: "primary-supervisor",
    skillVersion: `session-lock-smoke:${currentPhase}:${currentRole}`,
  };
  const controller = new AbortController();
  const abortTimer = abortAfterMs === undefined
    ? null
    : setTimeout(() => controller.abort(new Error("session_lock_smoke_cancelled")), abortAfterMs);
  abortTimer?.unref();

  event(currentRole, "started", {
    phase: currentPhase,
    session_id: sessionId,
    abort_after_ms: abortAfterMs ?? null,
    wait_timeout_ms: waitTimeoutMs ?? null,
  });
  try {
    await sessions.withSession(identity, async () => {
      event(currentRole, "entered", { phase: currentPhase, hold_ms: holdMs });
      if (holdMs > 0) await delay(holdMs);
    }, {
      signal: controller.signal,
      waitTimeoutMs,
    });
    if (expectedError) throw new Error(`expected_error_not_raised:${expectedError}`);
    event(currentRole, "completed", { phase: currentPhase });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (expectedError && message === expectedError) {
      event(currentRole, "rejected", { phase: currentPhase, message });
    } else {
      event(currentRole, "failed", { phase: currentPhase, message });
      process.exitCode = 1;
    }
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    await pool.end().catch(() => undefined);
  }
}

await main();
