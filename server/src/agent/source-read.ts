// Read/truncation behavior adapted from Pi Coding Agent (MIT).
// Copyright (c) 2025 Mario Zechner. Project-specific safety/paging changes by Yecernia.
// Source and full license: ../../../THIRD_PARTY_NOTICES.md and ../../../licenses/upstream/pi.txt.
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const SOURCE_READ_MAX_LINES = 200;
export const SOURCE_READ_MAX_BYTES = 32 * 1024;

export interface SourceReadPage {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  truncated: boolean;
  next_offset: number | null;
  truncation_reason: "lines" | "bytes" | "first_line_too_large" | null;
}

export type SourceLineReader = (
  path: string,
  startLine: number,
  endLine: number,
) => Promise<string[]>;

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("invalid_source_path");
  }
  return normalized;
}

/**
 * Source-level adaptation of Pi Coding Agent's read/truncate behavior: use
 * 1-based offsets, keep complete UTF-8 lines, and return an actionable next
 * offset when a bounded result has more content.
 */
export async function readSourcePage(input: {
  path: string;
  offset?: number;
  limit?: number;
  readLines: SourceLineReader;
  maxLines?: number;
  maxBytes?: number;
}): Promise<SourceReadPage> {
  const path = normalizeRelativePath(input.path);
  const startLine = Math.max(1, Math.floor(input.offset ?? 1));
  const maxLines = Math.max(1, Math.min(
    Math.floor(input.maxLines ?? SOURCE_READ_MAX_LINES),
    SOURCE_READ_MAX_LINES,
  ));
  const requestedLines = Math.max(1, Math.min(Math.floor(input.limit ?? maxLines), maxLines));
  const maxBytes = Math.max(1, Math.min(
    Math.floor(input.maxBytes ?? SOURCE_READ_MAX_BYTES),
    SOURCE_READ_MAX_BYTES,
  ));
  const rows = await input.readLines(path, startLine, startLine + requestedLines);
  if (!rows.length) throw new Error(`source_offset_out_of_range:${startLine}`);

  const hasLookahead = rows.length > requestedLines;
  const candidates = rows.slice(0, requestedLines);
  const output: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;
  for (const line of candidates) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedByBytes = true;
      break;
    }
    output.push(line);
    outputBytes += lineBytes;
  }

  if (!output.length && candidates.length) {
    return {
      path,
      start_line: startLine,
      end_line: startLine,
      content: "",
      truncated: true,
      next_offset: startLine,
      truncation_reason: "first_line_too_large",
    };
  }

  const endLine = startLine + output.length - 1;
  const truncated = truncatedByBytes || hasLookahead;
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    content: output.join("\n"),
    truncated,
    next_offset: truncated ? endLine + 1 : null,
    truncation_reason: truncatedByBytes ? "bytes" : hasLookahead ? "lines" : null,
  };
}

export function sourceRootLineReader(root: string): SourceLineReader {
  const absoluteRoot = resolve(root);
  return async (path, startLine, endLine) => {
    const normalized = normalizeRelativePath(path);
    const target = resolve(absoluteRoot, join(...normalized.split("/")));
    const relativePath = relative(absoluteRoot, target).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("../") || relativePath.includes("/../")) {
      throw new Error("source_path_outside_snapshot");
    }
    const [realRoot, realTarget] = await Promise.all([realpath(absoluteRoot), realpath(target)]);
    const realRelative = relative(realRoot, realTarget).replaceAll("\\", "/");
    if (!realRelative || realRelative.startsWith("../") || realRelative.includes("/../")) {
      throw new Error("source_path_outside_snapshot");
    }
    const allLines = (await readFile(realTarget, "utf8")).split(/\r?\n/);
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.max(start, Math.floor(endLine));
    return allLines.slice(start - 1, end);
  };
}
