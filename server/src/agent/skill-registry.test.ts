import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillExecutionIdentity } from "../analysis/execution-identity.js";
import {
  assertProductSkillRun,
  configureProductSkillRegistry,
  loadProductSkill,
  PRODUCT_SKILL_IDS,
} from "./skill-registry.js";

test("product skills load from reviewed files and enforce their runtime contract", async () => {
  const skill = await loadProductSkill("primary-conversational-supervisor");

  assert.equal(skill.skill.name, "primary-conversational-supervisor");
  assert.match(skill.skill.content, /闲聊|换话题/u);
  assert.doesNotThrow(() => assertProductSkillRun(skill, {
    toolNames: skill.allowedTools,
    inputSchemaId: skill.inputSchemaId,
    outputSchemaId: skill.outputSchemaId,
    contextBuilderId: skill.contextBuilderId,
  }));
  assert.throws(() => assertProductSkillRun(skill, {
    toolNames: [...skill.allowedTools, "arbitrary_file_read"],
    inputSchemaId: skill.inputSchemaId,
    outputSchemaId: skill.outputSchemaId,
    contextBuilderId: skill.contextBuilderId,
  }), /skill_tool_contract_mismatch/u);
  assert.throws(() => assertProductSkillRun(skill, {
    toolNames: skill.allowedTools,
    inputSchemaId: "wrong-input",
    outputSchemaId: skill.outputSchemaId,
    contextBuilderId: skill.contextBuilderId,
  }), /skill_input_contract_mismatch/u);
});

test("every registered product Skill has matching metadata and a usable description", async () => {
  for (const id of PRODUCT_SKILL_IDS) {
    const productSkill = await loadProductSkill(id);
    assert.equal(productSkill.skill.name, id);
    assert.ok(productSkill.skill.description.includes("用于") || productSkill.skill.description.length > 12);
    assert.ok(productSkill.skill.content.length > 80);
    assert.doesNotThrow(() => assertProductSkillRun(productSkill, {
      toolNames: productSkill.allowedTools,
      inputSchemaId: productSkill.inputSchemaId,
      outputSchemaId: productSkill.outputSchemaId,
      contextBuilderId: productSkill.contextBuilderId,
    }));
  }
});

test("architecture text repair is optional while repository tools remain required", async () => {
  const skill = await loadProductSkill("component-explanation");
  const contract = { inputSchemaId: skill.inputSchemaId, outputSchemaId: skill.outputSchemaId, contextBuilderId: skill.contextBuilderId };
  assert.doesNotThrow(() => assertProductSkillRun(skill, { ...contract, toolNames: skill.allowedTools.filter((name) => name !== "repair_result_text") }));
  assert.throws(() => assertProductSkillRun(skill, { ...contract, toolNames: skill.allowedTools.filter((name) => name !== "get_repository_evidence") }), /skill_tool_contract_mismatch/);
});

test("new runs hot-load an approved published Skill version", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-published-skill-"));
  const registry = join(root, "versions");
  const skillId = "feedback-analysis";
  const skillRoot = join(registry, skillId);
  try {
    const baseVersion = "1.1.0";
    const baseContent = skillText("base published marker").replace("\n---\n", "\nmetadata:\n  prompt-references: [examples.md]\n---\n");
    const baseArtifact = artifact(baseContent);
    const baseExample = artifact("Reviewed base example", "examples.md");
    const baseArtifacts = [baseArtifact, baseExample].sort((a, b) => a.path.localeCompare(b.path));
    await mkdir(join(skillRoot, baseVersion), { recursive: true });
    await writeFile(join(skillRoot, baseVersion, "SKILL.md"), baseContent, "utf8");
    await writeFile(join(skillRoot, baseVersion, "examples.md"), baseExample.content, "utf8");
    await writeFile(join(skillRoot, baseVersion, "baseline.json"), JSON.stringify({
      skillId,
      version: baseVersion,
      taskId: "bootstrap-feedback-analysis",
      kind: "baseline",
      createdAt: "2026-08-18T00:00:00.000Z",
      snapshotDigest: snapshotDigest(baseArtifacts),
      artifacts: baseArtifacts,
    }), "utf8");
    await writeManifest(skillRoot, skillId, [{
      revision: 1,
      version: baseVersion,
      snapshotDigest: snapshotDigest(baseArtifacts),
      taskId: "bootstrap-feedback-analysis",
      action: "bootstrap",
      at: "2026-08-18T00:00:00.000Z",
    }]);

    configureProductSkillRegistry(registry);
    const base = await loadProductSkill(skillId);
    assert.equal(base.version, baseVersion);
    assert.match(base.skill.content, /base published marker/u);
    assert.ok(base.skill.content.includes(baseExample.content));

    const nextVersion = "candidate.r2.123456789abc";
    // Updating only a reviewed reference must also update the effective instructions.
    const nextContent = baseContent;
    const nextArtifact = artifact("approved hot reload marker", "examples.md");
    const nextArtifacts = [baseArtifact, nextArtifact].sort((a, b) => a.path.localeCompare(b.path));
    const candidate = {
      taskId: "feedback-evolution-task",
      skillId,
      candidateVersion: nextVersion,
      baseArtifacts,
      artifacts: [nextArtifact],
      status: "approved",
    };
    const { status: _status, ...reviewed } = candidate;
    await mkdir(join(skillRoot, nextVersion), { recursive: true });
    await writeFile(join(skillRoot, nextVersion, "SKILL.md"), nextContent, "utf8");
    await writeFile(join(skillRoot, nextVersion, "examples.md"), nextArtifact.content, "utf8");
    await writeFile(join(skillRoot, nextVersion, "candidate.json"), JSON.stringify(candidate), "utf8");
    await writeFile(join(skillRoot, nextVersion, "review.json"), JSON.stringify({
      decision: "approve",
      taskId: candidate.taskId,
      candidateDigest: sha256(stableJson(reviewed)),
    }), "utf8");
    await writeManifest(skillRoot, skillId, [
      {
        revision: 1,
        version: baseVersion,
        snapshotDigest: snapshotDigest(baseArtifacts),
        taskId: "bootstrap-feedback-analysis",
        action: "bootstrap",
        at: "2026-08-18T00:00:00.000Z",
      },
      {
        revision: 2,
        version: nextVersion,
        snapshotDigest: snapshotDigest(nextArtifacts),
        taskId: candidate.taskId,
        action: "publish",
        at: "2026-08-18T00:01:00.000Z",
      },
    ]);

    const next = await loadProductSkill(skillId);
    assert.equal(next.version, nextVersion);
    assert.match(next.skill.content, /approved hot reload marker/u);
    assert.ok(!next.skill.content.includes(baseExample.content));
    assert.notEqual(skillExecutionIdentity({ ...next, version: base.version }).content_digest, skillExecutionIdentity(base).content_digest);
    assert.ok(base.skill.content.includes(baseExample.content), "an already selected run remains pinned");
    await writeFile(join(skillRoot, nextVersion, "examples.md"), "Unreviewed disk edit");
    configureProductSkillRegistry(null);
    configureProductSkillRegistry(registry);
    await assert.rejects(loadProductSkill(skillId), /integrity_mismatch/);
  } finally {
    configureProductSkillRegistry(null);
    await rm(root, { recursive: true, force: true });
  }
});

function skillText(marker: string): string {
  return `---\nname: feedback-analysis\ndescription: 用于测试已批准 Skill 的在线版本切换。\n---\n${marker}\n这段正文足够长，用来证明新的运行会读取已审核发布版本，而不会继续复用旧进程缓存。\n`;
}

function artifact(content: string, path = "SKILL.md") {
  return {
    path,
    content,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

function snapshotDigest(items: ReturnType<typeof artifact>[]): string {
  return sha256(stableJson(items));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeManifest(
  skillRoot: string,
  skillId: string,
  history: Array<{
    revision: number;
    version: string;
    snapshotDigest: string;
    taskId: string;
    action: string;
    at: string;
  }>,
): Promise<void> {
  const latest = history.at(-1);
  assert.ok(latest);
  await writeFile(join(skillRoot, "current.json"), JSON.stringify({
    skillId,
    currentVersion: latest.version,
    revision: latest.revision,
    currentSnapshotDigest: latest.snapshotDigest,
    history,
  }), "utf8");
}
