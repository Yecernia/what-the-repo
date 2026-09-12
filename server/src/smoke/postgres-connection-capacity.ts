import type { PoolClient, QueryResultRow } from "pg";

export type ConnectionCapacityMode = "hold" | "probe";
export type ConnectionCapacityExpectation = "success" | "exhausted";

export interface ConnectionCapacityIdentity {
  backendPid: number;
  user: string;
  superuser: boolean;
  applicationName: string;
}

interface IdentityRow extends QueryResultRow {
  backend_pid: number | string;
  user_name: string;
  is_superuser: boolean;
  application_name: string;
}

export function postgresConnectionErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isPostgresConnectionCapacityError(error: unknown): boolean {
  return postgresConnectionErrorCode(error) === "53300";
}

export async function readConnectionCapacityIdentity(client: PoolClient): Promise<ConnectionCapacityIdentity> {
  const result = await client.query<IdentityRow>(
    `SELECT
       pg_backend_pid() AS backend_pid,
       current_user AS user_name,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
       current_setting('application_name') AS application_name`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("connection_capacity_identity_missing");
  return {
    backendPid: Number(row.backend_pid),
    user: row.user_name,
    superuser: row.is_superuser === true,
    applicationName: row.application_name,
  };
}

export function assertConnectionCapacityIdentity(
  identity: ConnectionCapacityIdentity,
  expectedApplicationName: string,
  expectedSuperuser: boolean,
): void {
  if (identity.applicationName !== expectedApplicationName) {
    throw new Error("connection_capacity_application_name_mismatch");
  }
  if (identity.superuser !== expectedSuperuser) {
    throw new Error("connection_capacity_superuser_mismatch");
  }
}
