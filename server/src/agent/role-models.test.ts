import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentModelOverrides } from "../agent-model-config.js";
import type { ServerConfig } from "../config.js";
import { resolveDeploymentProvider } from "./provider-resolver.js";
import { resolveAgentProvider, runtimeForSkill, withAgentModels } from "./role-models.js";
import { createModelRuntime } from "./model-runtime.js";
import { providerGateKey } from "./provider-gate.js";
import { resolveAnalysisExecution } from "../analysis/execution-identity.js";

const config = { freeProviderBaseUrl: "https://api.deepseek.com", freeProviderModel: "deepseek-flash",
  freeProviderApiKey: "test-secret-unused", analysisProviderId: "deepseek" } as ServerConfig;
const base = resolveDeploymentProvider({ providerId: "deepseek", baseUrl: config.freeProviderBaseUrl,
  model: config.freeProviderModel, apiKey: config.freeProviderApiKey, connectionId: "platform-analysis" })!;

test("role configuration loads relative secret files and rejects malformed entries without echoing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-agent-models-"));
  try {
    assert.deepEqual(readAgentModelOverrides(root, {}), {});
    await writeFile(join(root, "key"), "test-secret-file");
    await writeFile(join(root, "roles.json"), JSON.stringify({ "architecture-planning": { model: "deepseek-flash", api_key_file: "key" } }));
    const env = { WHAT_THE_REPO_AGENT_MODELS_FILE: "roles.json" };
    assert.equal(readAgentModelOverrides(root, env)["architecture-planning"]?.apiKey, "test-secret-file");
    for (const entry of [{ unknown: { model: "test-secret" } }, { "architecture-planning": { model: "test-secret", api_key: "x", api_key_file: "key" } }, { "learning-route": { model: "test-secret", typo: "x" } }]) {
      await writeFile(join(root, "roles.json"), JSON.stringify(entry));
      assert.throws(() => readAgentModelOverrides(root, env), error => error instanceof Error && error.message === "invalid_agent_model_config:WHAT_THE_REPO_AGENT_MODELS_FILE");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("role defaults preserve selection; model-only overrides inherit keys but a different destination never does", () => {
  assert.equal(resolveAgentProvider(config, "component-explanation", base), base);
  const override = { ...config, agentModels: { "architecture-planning": { model: "deepseek-flash-next" } } };
  const provider = resolveAgentProvider(override, "architecture-planning", base)!;
  assert.equal(provider.apiKey, base.apiKey);
  assert.equal(provider.model, "deepseek-flash-next");
  assert.equal(base.model, "deepseek-flash");
  const same = resolveAgentProvider({ ...config, agentModels: { "architecture-planning": { model: base.model } } }, "architecture-planning", base)!;
  assert.equal(providerGateKey(same), providerGateKey(base), "a role override must not create extra concurrency for the same account/model");
  const shared = { model: "other", provider: "custom", baseUrl: "https://example.com/v1", apiKey: "new-test-key" };
  const separateRoles = { ...config, agentModels: { "architecture-planning": shared, "repository-value-discovery": shared } };
  assert.equal(providerGateKey(resolveAgentProvider(separateRoles, "architecture-planning", base)!), providerGateKey(resolveAgentProvider(separateRoles, "repository-value-discovery", base)!));
  assert.throws(() => resolveAgentProvider({ ...config, agentModels: { "architecture-planning": { model: "other", provider: "custom", baseUrl: "https://example.com/v1" } } }, "architecture-planning", base), /invalid_agent_provider/);
  assert.throws(() => resolveAgentProvider({ ...config, agentModels: { "architecture-planning": { model: "other", baseUrl: "https://127.0.0.1/v1", apiKey: "test" } } }, "architecture-planning", base), /invalid_agent_provider/);
});

test("every configured role selects its own runtime while retaining job limits and its own Provider gate", async () => {
  const roles = ["component-explanation", "architecture-planning", "repository-value-discovery", "snapshot-language-overlay", "learning-route", "understanding-assessment", "citation-review", "memory-maintenance"] as const;
  const gates = new Map<string, { acquire: () => Promise<{ release: () => Promise<void> }> }>();
  const beforeWorkerRequest = async () => {};
  const selected = withAgentModels({ ...config, agentModels: Object.fromEntries(roles.map(role => [role, { model: `test-${role}` }])) },
    { ...createModelRuntime(base), beforeWorkerRequest, ownerId: "test-owner" }, base, roles, {
      providerGateFactory: provider => { const gate = { acquire: async () => ({ release: async () => {} }) }; gates.set(provider.model, gate); return gate; },
    });
  for (const role of roles) {
    const runtime = runtimeForSkill(selected, role);
    assert.equal(runtime.model.id, `test-${role}`);
    assert.equal(runtime.providerGate, gates.get(runtime.model.id));
    assert.equal(runtime.beforeWorkerRequest, beforeWorkerRequest);
    assert.equal(runtime.ownerId, "test-owner");
  }
  assert.equal(runtimeForSkill(selected, "primary-conversational-supervisor"), selected);
});

test("changing only one analysis role changes snapshot identity; changing credentials does not", async () => {
  const original = await resolveAnalysisExecution(config);
  for (const role of ["component-explanation", "architecture-planning", "repository-value-discovery"] as const) {
    const changed = await resolveAnalysisExecution({ ...config, agentModels: { [role]: { model: "deepseek-flash-next" } } });
    assert.notEqual(changed.digest, original.digest);
    assert.equal(runtimeForSkill(changed.runtime!, role).model.id, "deepseek-flash-next");
    const keyOnly = await resolveAnalysisExecution({ ...config, agentModels: { [role]: { model: "deepseek-flash", apiKey: "another-test-secret" } } });
    assert.equal(keyOnly.digest, original.digest);
  }
});

test('analysis role overrides keep the analysis gate even before usage attribution is attached', async () => {
  const categories: Array<string | undefined> = [];
  await resolveAnalysisExecution({ ...config, agentModels: {
    'architecture-planning': { model: 'analysis-architecture-test' },
    'component-explanation': { model: 'analysis-component-test' },
    'repository-value-discovery': { model: 'analysis-value-test' },
  } }, { providerGateFactory: (_provider, business) => {
    categories.push(business);
    return { acquire: async () => ({ release: async () => {} }) };
  } });
  assert.deepEqual(categories, ['analysis', 'analysis', 'analysis', 'analysis']);
});
