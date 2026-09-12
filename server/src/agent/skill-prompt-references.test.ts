import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillPromptReferences } from "./skill-prompt-references.js";

const skill = (references: unknown) => `---\nname: example\ndescription: Example\nmetadata:\n  prompt-references: ${JSON.stringify(references)}\n---\nBody`;

test("only declared Markdown is loaded; missing or unreviewed references fail explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-skill-references-"));
  try {
    await writeFile(join(root, "examples.md"), "Reviewed example\r\nNext line");
    await writeFile(join(root, "unused.md"), "Do not include this unrelated material");
    assert.equal(await loadSkillPromptReferences(root, "---\nname: example\n---\nBody"), "");
    const loaded = await loadSkillPromptReferences(root, skill(["examples.md"]));
    assert.ok(loaded.includes("Reviewed example\nNext line"));
    assert.ok(!loaded.includes("unrelated material"));
    await assert.rejects(loadSkillPromptReferences(root, skill(["missing.md"])), { code: "ENOENT" });
    await assert.rejects(loadSkillPromptReferences(root, skill(["examples.md"]), []), /not_reviewed/);
    await assert.rejects(loadSkillPromptReferences(root, skill(["examples.md"]), [{ path: "examples.md", content: "Different reviewed content" }]), /integrity_mismatch/);
    const reviewed = await loadSkillPromptReferences(root, skill(["examples.md"]), [{ path: "examples.md", content: "Reviewed example\r\nNext line" }]);
    assert.equal(reviewed, loaded);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("references cannot escape the Skill, execute scripts or recursively include SKILL.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-skill-reference-boundary-"));
  try {
    const directory = join(root, "skill");
    await mkdir(directory);
    await writeFile(join(root, "outside.md"), "outside");
    for (const path of ["../outside.md", "C:/outside.md", "/outside.md", "script.js", "SKILL.md"]) {
      await assert.rejects(loadSkillPromptReferences(directory, skill([path])), /invalid_skill_prompt_reference_path/);
    }
    await assert.rejects(loadSkillPromptReferences(directory, skill("examples.md")), /invalid_skill_prompt_references/);
    await assert.rejects(loadSkillPromptReferences(directory, skill(["examples.md", "examples.md"])), /invalid_skill_prompt_references/);
    // A directory junction exercises Windows real-path confinement without symlink privileges.
    await symlink(root, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(loadSkillPromptReferences(directory, skill(["linked/outside.md"])), /outside_directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
