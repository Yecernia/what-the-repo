import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConnectionCapacityIdentity,
  isPostgresConnectionCapacityError,
  postgresConnectionErrorCode,
} from "./postgres-connection-capacity.js";

test("PostgreSQL connection capacity errors use SQLSTATE 53300", () => {
  const error = Object.assign(new Error("remaining connection slots are reserved"), { code: "53300" });
  assert.equal(postgresConnectionErrorCode(error), "53300");
  assert.equal(isPostgresConnectionCapacityError(error), true);
  assert.equal(isPostgresConnectionCapacityError(Object.assign(new Error("starting up"), { code: "57P03" })), false);
});

test("connection capacity identity rejects accidental superuser runtime sessions", () => {
  assert.doesNotThrow(() => assertConnectionCapacityIdentity({
    backendPid: 42,
    user: "wtr_runtime",
    superuser: false,
    applicationName: "what-the-repo:api-replica-1",
  }, "what-the-repo:api-replica-1", false));
  assert.throws(() => assertConnectionCapacityIdentity({
    backendPid: 42,
    user: "wtr_admin",
    superuser: true,
    applicationName: "what-the-repo:api-replica-1",
  }, "what-the-repo:api-replica-1", false), /connection_capacity_superuser_mismatch/);
});
