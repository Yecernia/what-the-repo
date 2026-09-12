import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "../analysis/graph.js";
import { isTextPath } from "../analysis/languages.js";
import { TreeSitterAnalyzer } from "../analysis/tree-sitter.js";
import type { EvidenceSnapshot, SnapshotNode } from "../domain/snapshot.js";

const SKIP_DIRECTORIES = new Set([
  ".git", ".codeboarding", ".ua", ".agents", ".claude", ".codex", ".cursor",
  "node_modules", "dist", "build", "coverage", "__pycache__", ".pytest_cache",
]);

interface FixedCase {
  id: string;
  expected_files: string[];
  symbol_anchors: Array<{ path: string; name: string; kind: string }>;
  inheritance_anchors: Array<[string, string]>;
  import_anchors: Array<[string, string]>;
  relation_anchors?: { calls?: Array<[string, string]> };
}

interface ProductEvalOptions {
  root: string;
  target: string;
  repository: string;
  expectedCommit: string;
  outputDir: string;
  fixedCase?: FixedCase | null;
}

export async function runProductEval(options: ProductEvalOptions): Promise<Record<string, unknown>> {
  const before = await sourceManifest(options.target);
  const analyzer = new TreeSitterAnalyzer();
  await analyzer.init();
  const startedAt = Date.now();
  const parsed = [];
  for (const path of before.files) parsed.push(await analyzer.analyzeFile(options.target, path));
  const actualCommit = options.expectedCommit === "fixture"
    ? "fixture"
    : gitCommit(options.target);
  const snapshotId = `eval:${createHash("sha256").update([
    options.repository,
    actualCommit,
    before.digest,
  ].join(":"), "utf8").digest("hex").slice(0, 24)}`;
  const snapshot = buildSnapshot({
    snapshotId,
    repository: options.repository,
    commitSha: actualCommit,
    files: parsed,
    sourceRoot: options.target,
  });
  const after = await sourceManifest(options.target);
  const truth = evaluateTruth(snapshot, options.fixedCase ?? null);
  const checks = {
    expected_commit: actualCommit === options.expectedCommit,
    source_unchanged: before.digest === after.digest,
    source_file_set_unchanged: JSON.stringify(before.files) === JSON.stringify(after.files),
    fact_files_present: Number(snapshot.summary.file_count ?? 0) > 0,
    fact_symbols_present: Number(snapshot.summary.symbol_count ?? 0) > 0,
    semantic_components_present: snapshot.graph.nodes.length > 0,
    component_evidence_valid: componentEvidenceValid(snapshot, new Set(before.files)),
    learning_route_present: snapshot.learning_plan.steps.length > 0,
    ...truth.checks,
  };
  const report: Record<string, unknown> = {
    schema_version: "typescript-product-eval-v1",
    generated_at: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    target: {
      repository: options.repository,
      expected_commit: options.expectedCommit,
      actual_commit: actualCommit,
      files_scanned: before.files.length,
      content_digest_before: before.digest,
      content_digest_after: after.digest,
    },
    metrics: {
      elapsed_ms: Date.now() - startedAt,
      ...snapshot.summary,
      value_points: snapshot.value_points.length,
      learning_steps: snapshot.learning_plan.steps.length,
    },
    truth: truth.details,
    languages: snapshot.languages,
    configuration: {
      runtime: `node ${process.version}`,
      analyzer: "TypeScript Tree-sitter fact chain",
      semantic_mode: snapshot.graph.semantic_mode,
      provider_called: false,
      target_code_executed: false,
    },
    subjective_quality: {
      status: "not_scored",
      required_raters: 2,
    },
    limitations: [
      "本报告只验证确定性静态事实与证据完整性，不把规则输出当作 LLM 教学质量。",
      "未配置可信 LSP attestation 时，语言质量保持 Tree-sitter 降级级别。",
      "真实 Provider 的回答质量、Token、成本和双人主观标注不在本次确定性运行内。",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeJson(join(options.outputDir, "snapshot.json"), snapshot);
  await writeJson(join(options.outputDir, "report.json"), report);
  return report;
}

function evaluateTruth(
  snapshot: EvidenceSnapshot,
  fixedCase: FixedCase | null,
): { checks: Record<string, boolean>; details: Record<string, unknown> } {
  if (!fixedCase) return { checks: {}, details: { status: "not_applicable" } };
  const nodes = snapshot.fact_graph?.nodes ?? [];
  const edges = snapshot.fact_graph?.edges ?? [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const files = new Set(nodes
    .filter((node) => node.id.startsWith("fact:file:"))
    .map(nodePath)
    .filter((value): value is string => Boolean(value)));
  const symbols = new Set(nodes
    .filter((node) => node.id.startsWith("fact:symbol:"))
    .map((node) => `${nodePath(node) ?? ""}|${node.name}|${String(node.attributes?.kind ?? "")}`));
  const imports = relationPairs(edges, nodeById, "imports", "path");
  const inheritance = relationPairs(edges, nodeById, "inherits", "name");
  const calls = relationPairs(edges, nodeById, "calls", "qualified");
  const expectedCalls = new Set((fixedCase.relation_anchors?.calls ?? []).map(pairKey));
  const callMatches = intersect(calls, expectedCalls).size;
  const callPrecision = calls.size ? callMatches / calls.size : 0;
  const callRecall = expectedCalls.size ? callMatches / expectedCalls.size : 1;
  const missingSymbols = fixedCase.symbol_anchors
    .map((item) => `${item.path}|${item.name}|${item.kind}`)
    .filter((item) => !symbols.has(item));
  const expectedFiles = new Set(fixedCase.expected_files);
  const expectedImports = new Set(fixedCase.import_anchors.map(pairKey));
  const expectedInheritance = new Set(fixedCase.inheritance_anchors.map(pairKey));
  return {
    checks: {
      fixed_exact_file_set: sameSet(files, expectedFiles),
      fixed_symbol_anchors: missingSymbols.length === 0,
      fixed_import_recall: ratio(intersect(imports, expectedImports).size, expectedImports.size) >= 0.8,
      fixed_inheritance_anchors: expectedInheritance.size === 0
        || intersect(inheritance, expectedInheritance).size === expectedInheritance.size,
      fixed_call_precision: callPrecision >= 0.6,
      fixed_call_recall: callRecall >= 0.5,
    },
    details: {
      case_id: fixedCase.id,
      missing_symbol_anchors: missingSymbols,
      import_metrics: relationMetrics(imports, expectedImports),
      inheritance_metrics: relationMetrics(inheritance, expectedInheritance),
      call_metrics: relationMetrics(calls, expectedCalls),
    },
  };
}

function relationPairs(
  edges: NonNullable<EvidenceSnapshot["fact_graph"]>["edges"],
  nodes: Map<string, SnapshotNode>,
  kind: string,
  label: "path" | "name" | "qualified",
): Set<string> {
  const value = (node: SnapshotNode | undefined): string => {
    if (!node) return "";
    if (label === "path") return nodePath(node) ?? "";
    if (label === "qualified") {
      return `${nodePath(node) ?? ""}|${String(node.attributes?.qualified_name ?? node.name)}`;
    }
    return node.name;
  };
  return new Set(edges
    .filter((edge) => edge.relation_kind === kind)
    .map((edge) => pairKey([value(nodes.get(edge.source)), value(nodes.get(edge.target))]))
    .filter((item) => !item.startsWith("->") && !item.endsWith("->")));
}

function componentEvidenceValid(snapshot: EvidenceSnapshot, files: Set<string>): boolean {
  return snapshot.graph.nodes.every((component) =>
    Boolean(component.name && component.responsibility && component.members.length)
    && [...component.members, ...component.evidence].every((item) =>
      files.has(item.path)
      && (item.start_line === null || item.start_line >= 1)
      && (item.end_line === null || item.start_line === null || item.end_line >= item.start_line)));
}

async function sourceManifest(root: string): Promise<{ files: string[]; digest: string }> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (isTextPath(relativePath) && (await stat(path)).size <= 4 * 1024 * 1024) files.push(relativePath);
    }
  };
  await visit(root);
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path, "utf8");
    hash.update(await readFile(join(root, ...path.split("/"))));
  }
  return { files, digest: hash.digest("hex") };
}

function gitCommit(target: string): string {
  const result = spawnSync("git", ["-C", target, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return "git-unavailable";
  return result.stdout.trim().toLowerCase();
}

function nodePath(node: SnapshotNode): string | null {
  return typeof node.attributes?.path === "string"
    ? node.attributes.path
    : node.evidence[0]?.path ?? null;
}

function pairKey(value: readonly string[]): string {
  return `${value[0] ?? ""}->${value[1] ?? ""}`;
}

function intersect(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function ratio(value: number, total: number): number {
  return total ? value / total : 1;
}

function relationMetrics(actual: Set<string>, expected: Set<string>): Record<string, unknown> {
  const matched = intersect(actual, expected);
  return {
    expected: expected.size,
    actual: actual.size,
    matched: matched.size,
    precision: ratio(matched.size, actual.size),
    recall: ratio(matched.size, expected.size),
    missing: [...expected].filter((item) => !actual.has(item)).sort(),
    unexpected: [...actual].filter((item) => !expected.has(item)).sort(),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function discoverRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    try {
      const gitRoot = spawnSync("git", ["-C", current, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout.trim();
      if (gitRoot) return resolve(gitRoot);
    } catch {
      // Continue walking upward.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    current = parent;
  }
}

async function main(): Promise<void> {
  const root = discoverRoot(process.cwd());
  const [command = "fixture", ...args] = process.argv.slice(2);
  const value = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  const outputDir = resolve(value("--output-dir") ?? join(root, "out", "product-eval"));
  let target: string;
  let repository: string;
  let expectedCommit: string;
  let fixedCase: FixedCase | null = null;
  if (command === "fixture") {
    target = join(root, "eval", "fixtures", "python-edge-cases", "source");
    repository = "fixture/python-edge-cases";
    expectedCommit = "fixture";
    fixedCase = JSON.parse(await readFile(
      join(root, "eval", "cases", "python-edge-cases.json"),
      "utf8",
    )) as FixedCase;
  } else if (command === "local") {
    const requestedTarget = value("--target");
    const requestedCommit = value("--expected-commit");
    if (!requestedTarget || !requestedCommit) throw new Error("local 需要 --target 和 --expected-commit");
    target = resolve(requestedTarget);
    repository = target.split(/[\\/]/).at(-1) ?? "local-repository";
    expectedCommit = requestedCommit.toLowerCase();
  } else {
    throw new Error("命令必须是 fixture 或 local");
  }
  const report = await runProductEval({ root, target, repository, expectedCommit, outputDir, fixedCase });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: join(outputDir, "report.json") })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
