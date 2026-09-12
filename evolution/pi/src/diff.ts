import type { CandidateArtifact } from "./contracts.js";
import type { EvolutionWorkspace } from "./safe-workspace.js";

function replacementDiff(path: string, before: string, after: string): string {
  const removed = before.split(/\r?\n/).map((line) => `-${line}`);
  const added = after.split(/\r?\n/).map((line) => `+${line}`);
  return [`--- a/${path}`, `+++ b/${path}`, "@@ full-file replacement @@", ...removed, ...added].join("\n");
}

function lineDiff(path: string, before: string, after: string): string {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  if (left.length * right.length > 250_000) return replacementDiff(path, before, after);

  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const body: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      body.push(` ${left[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      body.push(`-${left[i]}`);
      i += 1;
    } else {
      body.push(`+${right[j]}`);
      j += 1;
    }
  }
  while (i < left.length) body.push(`-${left[i++]}`);
  while (j < right.length) body.push(`+${right[j++]}`);
  return [`--- a/${path}`, `+++ b/${path}`, "@@ candidate @@", ...body].join("\n");
}

export function buildCandidateDiff(workspace: EvolutionWorkspace, artifacts: CandidateArtifact[]): string {
  return artifacts
    .map((artifact) => lineDiff(artifact.path, workspace.original(artifact.path), artifact.content))
    .join("\n");
}
