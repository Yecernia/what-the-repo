const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function scalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
  if (!match) return { error: "frontmatter_missing" };

  const values = new Map();
  for (const line of match[1].split("\n")) {
    if (!line.trim() || /^[ \t]/u.test(line)) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u);
    if (!field) return { error: "frontmatter_not_simple" };
    const [, key, rawValue] = field;
    if (values.has(key)) return { error: "frontmatter_duplicate_key" };
    values.set(key, scalar(rawValue));
  }
  return {
    body: source.slice(match[0].length),
    name: values.get("name"),
    description: values.get("description"),
  };
}

function hasUnfinishedTodo(body) {
  let fence = null;
  let fenceLength = 0;
  for (const line of body.split("\n")) {
    const marker = line.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      const nextFence = marker[1][0];
      if (fence === null) {
        fence = nextFence;
        fenceLength = marker[1].length;
      } else if (nextFence === fence && marker[1].length >= fenceLength && !marker[2].trim()) {
        fence = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fence === null && /^[ \t]{0,3}\[TODO:[^\n]*\][ \t]*$/u.test(line)) return true;
  }
  return false;
}

export function validateSkillSource(source, expectedName) {
  const normalized = source.replace(/\r\n/g, "\n");
  const parsed = parseFrontmatter(normalized);
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const checks = {
    source_size: Buffer.byteLength(normalized, "utf8") <= MAX_SOURCE_BYTES,
    no_nul: !normalized.includes("\0"),
    frontmatter: !parsed.error,
    expected_name: name === expectedName,
    name_shape: name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name),
    description: description.length > 0 && description.length <= MAX_DESCRIPTION_LENGTH &&
      !description.includes("<") && !description.includes(">") && !description.includes("[TODO:"),
    body: body.length > 0,
    no_unfinished_todo: !hasUnfinishedTodo(body),
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    expectedName,
    actualName: name,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    errors: Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key),
  };
}

export function validExpectedName(value) {
  return typeof value === "string" && NAME_PATTERN.test(value) && value.length <= MAX_NAME_LENGTH;
}
