import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { FileStore } from "../persistence/file-store.js";
import { createProject } from "../domain/conversation.js";
import { newAnalysisJob } from "../domain/jobs.js";
import { loadConfig } from "../config.js";
import { AnalysisCoordinator } from "./coordinator.js";
import { enrichSnapshotWithPi } from './semantic-worker.js';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';

async function interpretFixture(snapshot: import('./graph.js').BuiltSnapshot) {
  const faux = fauxProvider({ provider: 'static-pipeline-fixture', models: [{ id: 'fixture', contextWindow: 1_000_000, maxTokens: 384_000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const components = snapshot.graph.nodes.filter(node => (node.entity_kind ?? 'component') === 'component');
  const response: FauxResponseFactory = context => {
    const first = context.messages.find(message => message.role === 'user')!.content;
    // The worker appends budget annotations after the business JSON block.
    const input = JSON.parse(typeof first === 'string' ? first : first.find(item => item.type === 'text')!.text);
    const value = input.mode === 'components' ? { mode: 'components', components: input.required_component_ids.map((id: string) => ({
      component_id: id, name: '调用模块', responsibility: '通过调用目标函数完成入口工作', grouping_rationale: '成员共同提供调用能力',
    })) } : input.mode === 'layers' ? { mode: 'layers', layers: [{ name: '调用层', responsibility: '组织入口与目标调用',
      rationale: '成员共同实现调用路径', scopes: [], direct_component_ids: components.map(node => node.id) }] } : {
      official_design_review: { candidates: [], no_candidates_reason: 'No official design claims in this fixture.' },
      value_points: [{ title: '调用职责分离', claim: '入口通过明确函数调用复用目标逻辑', problem: '需要避免重复实现目标功能',
        implementation: '入口导入目标函数并发起调用', tradeoffs: '需要维护模块之间的接口', transfer_conditions: '适用于共享稳定功能的模块',
        component_ids: [components[0]!.id], evidence_ids: [components[0]!.members[0]!.stable_id] }],
    };
    return fauxAssistantMessage(fauxToolCall('submit_result', value));
  };
  faux.setResponses(Array.from({ length: 8 }, () => response));
  const result = await enrichSnapshotWithPi(snapshot, { models, model: faux.getModel() as Model<Api> }, undefined, 'zh-CN', undefined,
    { search: async () => [], readPage: async () => null });
  assert.equal(result.stopReason, 'completed');
  assert.equal(faux.state.callCount, 3);
  assert.equal(result.snapshot.value_points.length, 1);
  assert.deepEqual(result.snapshot.static_analysis, snapshot.static_analysis);
  return result.snapshot;
}

test(
  "source, static checkpoint and resumed publication retain the new fact contract",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "wtr-static-pipeline-"));
    const sources = {
      "tsconfig.json": '{"include":["*.ts"]}',
      "lib.ts": "export function target() {}",
      "main.ts":
        "import {target} from './lib.js'; export const run=()=>target();",
    };
    const archive = zipSync(
      Object.fromEntries(
        Object.entries(sources).map(([path, text]) => [
          "repo-sha/" + path,
          strToU8(text),
        ]),
      ),
    );
    const gateway = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.end(
        body.kind === "archive"
          ? archive
          : JSON.stringify(
              body.kind === "commit"
                ? { sha: "a".repeat(40) }
                : body.kind === "tree"
                  ? {
                      tree: Object.entries(sources).map(([path, text]) => ({
                        path,
                        type: "blob",
                        size: Buffer.byteLength(text),
                      })),
                    }
                  : body.kind === "metadata"
                    ? { default_branch: "main" }
                    : {},
            ),
      );
    });
    await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
    const store = new FileStore(root);
    try {
      await store.init();
      const config = loadConfig({
        WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
        WHAT_THE_REPO_ROOT: resolve(".."),
        WHAT_THE_REPO_DATA_DIR: root,
        NODE_ENV: "test",
      });
      config.githubGatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
      config.githubGatewaySharedSecret = "fixture";
      const project = createProject(
        "guest:static",
        "https://github.com/example/static",
        "Static",
      );
      await store.saveProject(project);
      await store.saveJob(
        newAnalysisJob(project.project_id, "static-pipeline"),
      );
      const job = (await store.claimAnalysisJob("fixture", 900))!;
      const signal = new AbortController().signal;
      assert.equal(
        await new AnalysisCoordinator(store, config).runAssignedStage(
          job,
          "fetch",
          signal,
        ),
        "cpu",
      );
      assert.equal(
        await new AnalysisCoordinator(store, config).runAssignedStage(
          job,
          "cpu",
          signal,
        ),
        "semantic",
      );
      const saved = await store.loadAnalysisCheckpoint(project.project_id);
      assert.ok(saved?.snapshot);
      assert.equal((saved.checkpoint.syntax_files as unknown[]).length, 3);
      const snapshot =
        saved.snapshot as unknown as import("./graph.js").BuiltSnapshot;
      assert.equal(snapshot.static_analysis?.coverage.discovered_call_sites, 1);
      assert.equal(
        snapshot.fact_graph.edges.filter(
          (edge) => edge.relation_kind === "calls",
        ).length,
        1,
      );
      await store.saveAnalysisCheckpoint(
        project.project_id,
        { ...saved.checkpoint, stage: "assembly", provenance_applied: true, display_language: 'zh-CN' },
        await interpretFixture(snapshot),
      );
      await new AnalysisCoordinator(store, config).runAssignedStage(
        job,
        "publish",
        signal,
      );
      const published = await store.loadPublicSnapshot(
        String(saved.checkpoint.public_key),
      );
      assert.deepEqual(
        published?.analysis.static_analysis,
        snapshot.static_analysis,
      );
      assert.deepEqual((published?.view.static_analysis as { files: unknown[] }).files, []);
      const detail = await store.readStaticFile(project.project_id, snapshot.snapshot_id, "main.ts");
      assert.equal(detail?.calls[0]?.status, "static");
      assert.equal(detail?.calls[0]?.callee, "target");
      await assert.rejects(store.readStaticFile(project.project_id, "another-snapshot", "main.ts"), /snapshot_not_bound/);
      assert.equal(
        (published?.analysis.analysis_cache as { syntax_files: unknown[] })
          .syntax_files.length,
        3,
      );
      assert.equal((await store.loadJob(job.job_id))?.status, "succeeded");
    } finally {
      await store.close();
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
