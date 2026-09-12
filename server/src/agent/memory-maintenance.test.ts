import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMessage, createProject } from "../domain/conversation.js";
import { FileStore } from "../persistence/file-store.js";
import { applyMemoryOutput } from "./memory-maintenance.js";
import { PiMemoryStore } from "./memory-store.js";

test("memory maintenance keeps sourced learning facts and rejects secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-memory-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const memories = new PiMemoryStore(join(root, "pi-memory"));
    const project = createProject(
      "github:1",
      "https://github.com/example/repo",
      "repo",
      "free:deepseek-v4-flash",
    );
    const user = createMessage("user", "我主要写 Go，希望先理解调用链。");
    project.messages.push(user);
    await store.saveProject(project);
    const applied = await applyMemoryOutput({
      ownerId: project.owner_id,
      project,
      store,
      memories,
      output: {
        memories: [{
          key: "preferred-language",
          value: "用户主要使用 Go。",
          confidence: 0.9,
          source_message_id: user.message_id,
          evidence: "我主要写 Go",
        }, {
          key: "api-key",
          value: "secret-value",
          confidence: 1,
          source_message_id: user.message_id,
          evidence: "我主要写 Go",
        }],
        profile_claims: [{
          claim: "更适合从调用链开始学习。",
          confidence: 0.85,
          source_message_id: user.message_id,
          evidence: "希望先理解调用链",
        }],
      },
    });
    assert.deepEqual(applied, { memories: 1, profileClaims: 1 });
    assert.equal((await memories.list(project.owner_id)).length, 1);
    const profile = await store.loadProfile(project.owner_id);
    assert.equal(profile.inferred.length, 1);
    assert.equal(profile.last_inferred_message_id, user.message_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
