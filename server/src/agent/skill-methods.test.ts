import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  PRODUCT_SKILL_IDS,
  loadProductSkill,
  skillPrompt,
  skillMetadata,
} from "./skill-registry.js";

test("registered methods have distinct, nonempty descriptions and instructions", async () => {
  const descriptions = new Set<string>();
  const bodies = new Set<string>();
  for (const id of PRODUCT_SKILL_IDS) {
    const productSkill = await loadProductSkill(id);
    const { description, content } = productSkill.skill;

    assert.equal(productSkill.skill.name, id);
    assert.ok(description.trim().length > 0);
    assert.ok(content.trim().length > 0);
    assert.equal(descriptions.has(description), false, `${id} reuses another Skill description`);
    assert.equal(bodies.has(content), false, `${id} reuses another Skill method body`);
    descriptions.add(description);
    bodies.add(content);
  }
});

test("skillPrompt injects the complete selected method and the dynamic instructions", async () => {
  const additional = "当前输入由程序绑定。";
  const { productSkill, prompt } = await skillPrompt("repository-value-discovery", additional);
  assert.ok(prompt.includes(productSkill.skill.content));
  assert.ok(prompt.includes(additional));
  assert.equal(productSkill.version, skillMetadata(productSkill.id).version);
});

test("analysis prompts contain their entire declared examples without another tool call", async () => {
  for (const id of ["component-explanation", "architecture-planning", "repository-value-discovery"] as const) {
    const examples = (await readFile(new URL(`../../skills/${id}/examples.md`, import.meta.url), "utf8")).replace(/\r\n/g, "\n").trim();
    const { productSkill, prompt } = await skillPrompt(id);
    assert.ok(productSkill.skill.content.includes(examples));
    assert.equal(prompt.split(examples).length, 2, "examples must be included exactly once");
  }
});
