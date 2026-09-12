import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMetrics } from "./metrics.js";
import { startMetricsServer } from "./metrics-server.js";

test("metrics server stays disabled without a bearer token", async () => {
  const server = await startMetricsServer({
    host: "127.0.0.1",
    port: 0,
    metrics: new RuntimeMetrics(),
  });
  assert.equal(server, null);
});

test("metrics server hides unauthorized requests and refreshes authorized output", async () => {
  const metrics = new RuntimeMetrics();
  metrics.increment("test_counter_total", 1);
  let refreshes = 0;
  const server = await startMetricsServer({
    host: "127.0.0.1",
    port: 0,
    token: "metrics-test-token",
    metrics,
    refresh: async () => {
      refreshes += 1;
      metrics.setGauge("test_refresh", refreshes);
    },
  });
  assert.ok(server);

  try {
    const denied = await fetch(`http://${server.host}:${server.port}/metrics`);
    assert.equal(denied.status, 404);

    const allowed = await fetch(`http://${server.host}:${server.port}/metrics`, {
      headers: { authorization: "Bearer metrics-test-token" },
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.text();
    assert.match(body, /test_counter_total 1/);
    assert.match(body, /test_refresh 1/);
    assert.equal(refreshes, 1);
  } finally {
    await server.close();
  }
});
