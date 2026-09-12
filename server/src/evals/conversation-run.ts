import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ConversationCase {
  case_id: string;
  requirement: string;
  node_test: string;
}

interface ConversationManifest {
  schema_version: string;
  eval_id: string;
  expected_case_count: number;
  cases: ConversationCase[];
}

export async function runConversationEval(options: {
  root: string;
  caseFile: string;
  outputDir: string;
}): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(options.caseFile, "utf8")) as ConversationManifest;
  const testRoot = join(options.root, "server", "dist-test");
  const files = await testFiles(testRoot);
  if (!files.length) throw new Error("没有编译后的 TypeScript 测试；先运行 npm test");
  const completed = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    ...files,
  ], {
    cwd: join(options.root, "server"),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${completed.stdout ?? ""}${completed.stderr ?? ""}`;
  const observed = parseTap(output);
  const cases = manifest.cases.map((item) => ({
    case_id: item.case_id,
    requirement: item.requirement,
    node_test: item.node_test,
    status: observed.get(item.node_test) ?? "missing",
  }));
  const checks = {
    expected_case_count_declared: manifest.expected_case_count > 0,
    expected_case_count_matches: manifest.expected_case_count === cases.length,
    unique_case_ids: new Set(cases.map((item) => item.case_id)).size === cases.length,
    unique_test_bindings: new Set(cases.map((item) => item.node_test)).size === cases.length,
    all_manifest_cases_observed: cases.every((item) => item.status !== "missing"),
    all_cases_passed: cases.every((item) => item.status === "passed"),
    node_tests_completed_successfully: completed.status === 0,
  };
  const report: Record<string, unknown> = {
    schema_version: "typescript-conversation-eval-v1",
    eval_id: manifest.eval_id,
    generated_at: new Date().toISOString(),
    evaluation_kind: "deterministic_behavior_contract",
    passed: Object.values(checks).every(Boolean),
    checks,
    cases,
    configuration: {
      runtime: `node ${process.version}`,
      provider: "Pi faux provider and deterministic product services",
      real_provider_called: false,
      target_repository_code_executed: false,
    },
    subjective_quality: { status: "not_scored", human_annotators: 0 },
    limitations: [
      "不证明真实 Provider 的语言质量、稳定性、延迟或精确成本。",
      "不替代双人主观标注或真实用户可用性研究。",
      "只验证固定场景中的工具、证据、状态、Session、Memory 和失败边界。",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(join(options.outputDir, "tap.log"), output, "utf8");
  await writeFile(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function testFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.js")) result.push(path);
    }
  };
  await visit(root);
  return result.sort();
}

function parseTap(output: string): Map<string, "passed" | "failed"> {
  const result = new Map<string, "passed" | "failed">();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/.exec(line);
    if (!match) continue;
    result.set(match[2] as string, match[1] === "ok" ? "passed" : "failed");
  }
  return result;
}

function rootFromGit(start: string): string {
  const result = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim()
    ? resolve(result.stdout.trim())
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function main(): Promise<void> {
  const root = rootFromGit(process.cwd());
  const args = process.argv.slice(2);
  const value = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  const caseFile = resolve(value("--case-file") ?? join(root, "eval", "cases", "primary-conversation.json"));
  const outputDir = resolve(value("--output-dir") ?? join(root, "out", "conversation-eval"));
  const report = await runConversationEval({ root, caseFile, outputDir });
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: join(outputDir, "report.json") })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
