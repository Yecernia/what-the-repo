import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;

export function isPortableIdentifier(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !WINDOWS_RESERVED.test(value);
}

export function portableRelativePath(raw: string): string {
  const unified = raw.replaceAll("\\", "/");
  const segments = unified.split("/");
  if (
    !raw ||
    raw.length > 1_024 ||
    isAbsolute(raw) ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length > 255 ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_FORBIDDEN.test(segment) ||
      WINDOWS_RESERVED.test(segment))
  ) {
    throw new Error("unsafe portable relative path");
  }
  const normalized = normalize(unified).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "..")) {
    throw new Error("unsafe portable relative path");
  }
  return normalized;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function pathsOverlap(left: string, right: string): boolean {
  const normalizePath = (value: string): string => {
    const result = resolve(value);
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  const a = normalizePath(left);
  const b = normalizePath(right);
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return a === b ||
    (!aToB.startsWith("..") && !isAbsolute(aToB)) ||
    (!bToA.startsWith("..") && !isAbsolute(bToA));
}

export async function resolvedPathIdentity(path: string): Promise<string> {
  const lexical = resolve(path);
  let cursor = lexical;
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error("trusted path was redirected through a link");
      }
      const actual = await realpath(cursor);
      return resolve(actual, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (samePath(parent, cursor)) throw error;
      missing.push(cursor.slice(parent.length + (parent.endsWith("\\") || parent.endsWith("/") ? 0 : 1)));
      cursor = parent;
    }
  }
}
