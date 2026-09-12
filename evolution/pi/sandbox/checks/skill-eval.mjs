import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { validExpectedName, validateSkillSource } from "./skill-source.mjs";

const file = process.argv[2];
const expectedSkillId = process.env.EXPECTED_SKILL_ID;
if (typeof file !== "string" || basename(file) !== "SKILL.md") {
  throw new Error("skill method evaluation requires SKILL.md");
}
if (!validExpectedName(expectedSkillId)) {
  throw new Error("skill method evaluation requires a valid expected Skill ID");
}

const report = validateSkillSource(await readFile(file, "utf8"), expectedSkillId);
const checks = Object.values(report.checks);
const score = Number((checks.filter(Boolean).length / checks.length).toFixed(6));
process.stdout.write(`${JSON.stringify({
  metrics: { method_hygiene_score: score },
  checks: report.checks,
})}\n`);
if (!report.ok) process.exitCode = 1;
