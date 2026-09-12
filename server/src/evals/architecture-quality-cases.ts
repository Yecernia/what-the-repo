/** Evaluator-only reference answers. Never import this file into production prompts. */
export const ARCHITECTURE_CASE_SOURCE = {
  repository: "deepseek-ai/deepseek-harness",
  commit: "d347e703908d0406b7a7ef80e3a0e594d86b2215",
} as const;

export const ARCHITECTURE_QUALITY_CASES = [
  {
    id: "case-1",
    componentGroups: ["packages/jobs", "packages/session"],
    question: "说明是否区分不同状态的保存方式与生命周期。",
    expected: [
      "jobs-local 用进程内 Map 管理作业，进程重启不会恢复这些作业。",
      "session-persistence-jsonl 将已提交会话记录追加到文件并同步；不能把这种持久化推广成作业执行状态跨重启。",
    ],
    evidence: [
      { path: "packages/jobs/jobs-local/README.md", start: 10, end: 14, kind: "documentation" },
      { path: "packages/jobs/jobs-local/src/index.ts", start: 99, end: 130, kind: "implementation" },
      { path: "packages/jobs/jobs-local/src/index.ts", start: 481, end: 498, kind: "implementation" },
      { path: "packages/session/session-persistence-jsonl/src/index.ts", start: 991, end: 1016, kind: "implementation" },
    ],
  },
  {
    id: "case-2",
    componentGroups: ["packages/terminal", "packages/shell"],
    question: "说明是否保留同一能力族内不同实现的状态边界。",
    expected: [
      "terminal-bash 的交互进程保留跨工具调用状态；这不证明它能跨进程重启恢复。",
      "bash-local 每次启动 bash -c；但 shell 家族还包含依赖终端会话的 tool-bash-persistent，不能称整个家族都无状态。",
    ],
    evidence: [
      { path: "packages/terminal/terminal-bash/README.md", start: 10, end: 34, kind: "documentation" },
      { path: "packages/terminal/terminal-bash/src/session.ts", start: 160, end: 215, kind: "implementation" },
      { path: "packages/shell/bash-local/src/index.ts", start: 212, end: 230, kind: "implementation" },
      { path: "packages/shell/tool-bash-persistent/README.md", start: 10, end: 14, kind: "documentation" },
      { path: "packages/shell/tool-bash-persistent/src/index.ts", start: 243, end: 280, kind: "implementation" },
    ],
  },
  {
    id: "case-3",
    componentGroups: ["patches", "scripts"],
    question: "说明是否区分修改应用的阶段与修改影响的阶段。",
    expected: [
      "patches 中 node-pty 补丁改变运行时 spawn-helper 的定位，安装时应用不等于只影响开发或 CI。",
      "scripts 包含清理构建产物等工程自动化；不能从目录名称断言全部成员均不影响运行。",
    ],
    evidence: [
      { path: "patches/node-pty@1.2.0-beta.15.patch", start: 5, end: 31, kind: "implementation" },
      { path: "scripts/clean.ts", start: 45, end: 64, kind: "implementation" },
    ],
  },
] as const;

// Human review must assess all returned group/scope prose against these references.
// Valid JSON, coverage, keyword absence, or omitting the topic do not prove semantic correctness.
