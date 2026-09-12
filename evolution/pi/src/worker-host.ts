import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProductionEvolutionRuntime } from "./composition.js";

export type EvolutionRuntimeFactory =
  () => ProductionEvolutionRuntime | Promise<ProductionEvolutionRuntime>;

interface RuntimeModule {
  createEvolutionRuntime?: unknown;
  default?: unknown;
}

function runtimeFactory(value: unknown): EvolutionRuntimeFactory {
  if (typeof value !== "function") {
    throw new Error("evolution composition must export createEvolutionRuntime()");
  }
  return value as EvolutionRuntimeFactory;
}

/**
 * Load the deployment-owned composition without importing the online API.
 * Provider credentials, Docker image policy and check definitions stay in the
 * evolution process and are never part of the user chat runtime.
 */
export async function loadEvolutionRuntime(
  modulePath = process.env.WHAT_THE_REPO_EVOLUTION_COMPOSITION,
): Promise<ProductionEvolutionRuntime> {
  const configured = modulePath?.trim();
  if (!configured) {
    const builtIn = await import("./production-composition.js");
    const runtime = await builtIn.createEvolutionRuntime();
    if (!runtime.feedbackWorker) {
      throw new Error("built-in evolution composition did not configure a global feedback worker");
    }
    return runtime;
  }
  const absolute = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  const module = await import(pathToFileURL(absolute).href) as RuntimeModule;
  const factory = runtimeFactory(module.createEvolutionRuntime ?? module.default);
  const runtime = await factory();
  if (!runtime.feedbackWorker) {
    throw new Error("evolution composition did not configure a global feedback worker");
  }
  return runtime;
}
