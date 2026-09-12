import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parse } from "yaml";

/** Only explicitly selected Markdown references become instructions. Never run Skill scripts. */
export async function loadSkillPromptReferences(
  directory: string,
  skillFile: string,
  reviewedArtifacts?: readonly { path: string; content: string }[],
): Promise<string> {
  const header = skillFile.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const declared: unknown = header ? parse(header[1])?.metadata?.["prompt-references"] : undefined;
  if (declared === undefined) return "";
  if (!Array.isArray(declared) || declared.length > 4 || new Set(declared).size !== declared.length) {
    throw new Error("invalid_skill_prompt_references");
  }
  const root = await realpath(directory);
  const sections: string[] = [];
  let bytes = 0;
  for (const path of declared) {
    if (typeof path !== "string" || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(path) || path.toLowerCase() === "skill.md") {
      throw new Error("invalid_skill_prompt_reference_path");
    }
    const reviewed = reviewedArtifacts?.find((artifact) => artifact.path === path);
    if (reviewedArtifacts && !reviewed) throw new Error("skill_prompt_reference_not_reviewed");
    const file = await realpath(join(root, path));
    const child = relative(root, file);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error("skill_prompt_reference_outside_directory");
    const content = await readFile(file, "utf8");
    if (reviewed && content !== reviewed.content) throw new Error("skill_prompt_reference_integrity_mismatch");
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > 32_768) throw new Error("skill_prompt_references_too_large");
    sections.push(`## Supplied Skill reference: ${path}\n\n${content.replace(/\r\n/g, "\n").trim()}`);
  }
  return sections.join("\n\n");
}
