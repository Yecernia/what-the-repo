import assert from "node:assert/strict";
import test from "node:test";
import type { ServerConfig } from "../config.js";
import { createSnapshotObjectStore } from "./factory.js";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir: "C:/tmp/what-the-repo-data",
    ...overrides,
  } as ServerConfig;
}

test("snapshot object storage uses local data only when COS is entirely absent", () => {
  assert.equal(createSnapshotObjectStore(config()).kind, "local");
  assert.equal(createSnapshotObjectStore(config({ cosRegion: "ap-guangzhou" })).kind, "local");
  assert.throws(
    () => createSnapshotObjectStore(config({
      cosBucket: "example-1234567890",
      cosRegion: "ap-guangzhou",
    })),
    /COS 配置不完整/,
  );
  assert.throws(
    () => createSnapshotObjectStore(config({
      cosSecurityToken: "temporary-token",
    })),
    /COS 配置不完整/,
  );
  assert.equal(createSnapshotObjectStore(config({
    cosBucket: "example-1234567890",
    cosRegion: "ap-guangzhou",
    cosSecretId: "secret-id",
    cosSecretKey: "secret-key",
    cosSecurityToken: "temporary-token",
  })).kind, "cos");
});
