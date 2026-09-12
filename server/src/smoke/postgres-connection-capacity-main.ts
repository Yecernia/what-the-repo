import { Pool, type PoolClient } from "pg";
import {
  assertConnectionCapacityIdentity,
  isPostgresConnectionCapacityError,
  postgresConnectionErrorCode,
  readConnectionCapacityIdentity,
  type ConnectionCapacityExpectation,
  type ConnectionCapacityMode,
} from "./postgres-connection-capacity.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mode(): ConnectionCapacityMode {
  const value = process.env.WTR_CONNECTION_CAPACITY_MODE?.trim() || "probe";
  if (value !== "hold" && value !== "probe") {
    throw new Error("WTR_CONNECTION_CAPACITY_MODE must be hold or probe");
  }
  return value;
}

function expectation(): ConnectionCapacityExpectation {
  const value = process.env.WTR_CONNECTION_CAPACITY_EXPECT?.trim() || "success";
  if (value !== "success" && value !== "exhausted") {
    throw new Error("WTR_CONNECTION_CAPACITY_EXPECT must be success or exhausted");
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function expectedSuperuser(): boolean {
  const value = required("WTR_CONNECTION_CAPACITY_EXPECT_SUPERUSER");
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("WTR_CONNECTION_CAPACITY_EXPECT_SUPERUSER must be true or false");
}

function applicationName(): string {
  const value = required("WTR_CONNECTION_CAPACITY_APPLICATION_NAME");
  if (!/^[A-Za-z0-9:_-]{1,63}$/.test(value)) {
    throw new Error("WTR_CONNECTION_CAPACITY_APPLICATION_NAME is invalid");
  }
  return value;
}

function event(name: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: name, at: new Date().toISOString(), ...extra })}\n`);
}

function waitForStop(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

async function main(): Promise<void> {
  const currentMode = mode();
  const expected = expectation();
  const databaseUrl = required("DATABASE_URL");
  const currentApplicationName = applicationName();
  const shouldBeSuperuser = expectedSuperuser();
  const connections = currentMode === "hold"
    ? positiveInteger("WTR_CONNECTION_CAPACITY_CONNECTIONS", 1)
    : 1;
  const connectionTimeoutMs = positiveInteger("WTR_CONNECTION_CAPACITY_TIMEOUT_MS", 2_000);
  const holdMs = positiveInteger("WTR_CONNECTION_CAPACITY_HOLD_MS", 600_000);
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: currentApplicationName,
    max: connections,
    connectionTimeoutMillis: connectionTimeoutMs,
  });
  const clients: PoolClient[] = [];
  try {
    if (currentMode === "probe") {
      try {
        const client = await pool.connect();
        clients.push(client);
        const identity = await readConnectionCapacityIdentity(client);
        assertConnectionCapacityIdentity(identity, currentApplicationName, shouldBeSuperuser);
        if (expected === "exhausted") throw new Error("connection_capacity_expected_exhaustion_not_observed");
        event("probe_succeeded", {
          application_name: identity.applicationName,
          user: identity.user,
          superuser: identity.superuser,
          backend_pid: identity.backendPid,
        });
      } catch (error) {
        if (expected !== "exhausted" || !isPostgresConnectionCapacityError(error)) throw error;
        event("probe_exhausted", { error_code: postgresConnectionErrorCode(error) });
      }
      return;
    }

    if (expected !== "success") throw new Error("connection_capacity_holder_expectation_must_be_success");
    for (let index = 0; index < connections; index += 1) clients.push(await pool.connect());
    const identities = await Promise.all(clients.map(async (client) => readConnectionCapacityIdentity(client)));
    for (const identity of identities) {
      assertConnectionCapacityIdentity(identity, currentApplicationName, shouldBeSuperuser);
    }
    event("holder_ready", {
      application_name: currentApplicationName,
      user: identities[0]?.user ?? null,
      superuser: identities[0]?.superuser ?? null,
      connections: identities.length,
      backend_pids: identities.map((identity) => identity.backendPid),
    });
    await waitForStop(holdMs, stop.signal);
    event("holder_stopped", { application_name: currentApplicationName });
  } finally {
    for (const client of clients) client.release();
    await pool.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  event("failed", {
    error_code: postgresConnectionErrorCode(error)
      ?? (error instanceof Error ? error.message : "connection_capacity_unknown_error"),
  });
  process.exitCode = 1;
}
