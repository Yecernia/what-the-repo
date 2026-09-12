import type { CheckDefinition, PiSessionFactory } from "./contracts.js";
import {
  ContainerSandboxExecutor,
  type ContainerSandboxExecutorOptions,
} from "./container-sandbox.js";
import { CheckRegistry } from "./checks.js";
import { PiEvolutionRunner } from "./runner.js";
import { EvolutionStateStore, type EvolutionStateJournal } from "./state-store.js";
import { SkillVersionRegistry } from "./versions.js";
import {
  FeedbackEvolutionWorker,
  type FeedbackEvolutionWorkerOptions,
} from "./feedback-worker.js";

export type ProductionContainerSandboxOptions = Omit<
  ContainerSandboxExecutorOptions,
  "processRunner"
>;

export interface ProductionEvolutionRuntimeOptions {
  sandbox: ProductionContainerSandboxOptions;
  checks: CheckDefinition[];
  stateRoot: string;
  stateJournal?: EvolutionStateJournal;
  versionsRoot: string;
  workspaceRoot: string;
  forbiddenWorkspaceRoots?: string[];
  sessionFactory?: PiSessionFactory;
  feedback?: Omit<
    FeedbackEvolutionWorkerOptions,
    "runner" | "state" | "versions" | "policies"
  > & {
    policies:
      | FeedbackEvolutionWorkerOptions["policies"]
      | ((checks: CheckRegistry) => FeedbackEvolutionWorkerOptions["policies"]);
  };
}

export interface ProductionEvolutionRuntime {
  store: EvolutionStateStore;
  versions: SkillVersionRegistry;
  runner: PiEvolutionRunner;
  feedbackWorker?: FeedbackEvolutionWorker;
  close?(): Promise<void>;
}

/** The only production composition path for Pi checks and publication. */
export function createProductionEvolutionRuntime(
  options: ProductionEvolutionRuntimeOptions,
): ProductionEvolutionRuntime {
  if ("processRunner" in options.sandbox) {
    throw new Error("production sandbox composition does not accept a custom process runner");
  }
  const sandbox = new ContainerSandboxExecutor(options.sandbox);
  if (sandbox.isolationPolicy.trustDomain !== "production") {
    throw new Error("production sandbox composition requires a production isolation policy");
  }
  const checks = new CheckRegistry(sandbox);
  for (const definition of options.checks) checks.register(definition);
  const store = new EvolutionStateStore(options.stateRoot, options.stateJournal);
  const versions = new SkillVersionRegistry(options.versionsRoot);
  const runner = new PiEvolutionRunner({
    checks,
    store,
    versions,
    workspaceRoot: options.workspaceRoot,
    forbiddenWorkspaceRoots: options.forbiddenWorkspaceRoots,
    sessionFactory: options.sessionFactory,
  });
  const feedbackWorker = options.feedback
    ? new FeedbackEvolutionWorker({
        ...options.feedback,
        policies: typeof options.feedback.policies === "function"
          ? options.feedback.policies(checks)
          : options.feedback.policies,
        state: store,
        versions,
        runner,
      })
    : undefined;
  const close = async (): Promise<void> => { await store.close(); };
  return feedbackWorker
    ? { store, versions, runner, feedbackWorker, close }
    : { store, versions, runner, close };
}
