import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { validExpectedName, validateSkillSource } from "./skill-source.mjs";

const file = process.argv[2];
const expectedSkillId = process.env.EXPECTED_SKILL_ID;
if (typeof file !== "string" || basename(file) !== "SKILL.md") {
  throw new Error("skill method check requires SKILL.md");
}
if (!validExpectedName(expectedSkillId)) {
  throw new Error("skill method check requires a valid expected Skill ID");
}

const report = validateSkillSource(await readFile(file, "utf8"), expectedSkillId);
const output = {
  ok: report.ok,
  expected_name: report.expectedName,
  actual_name: report.actualName,
  body_bytes: report.bodyBytes,
  failed_checks: report.errors,
};
(report.ok ? process.stdout : process.stderr).write(`${JSON.stringify(output)}\n`);
if (!report.ok) process.exitCode = 1;
