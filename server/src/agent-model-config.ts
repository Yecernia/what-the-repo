import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Primary chat, feedback and isolated evolution retain their existing deployment settings. */
export const AGENT_MODEL_ROLES = [
  "component-explanation", "architecture-planning", "repository-value-discovery", "snapshot-language-overlay",
  "learning-route", "understanding-assessment", "citation-review", "memory-maintenance",
] as const;
export type AgentModelRole = typeof AGENT_MODEL_ROLES[number];
export interface AgentModelOverride {
  connectionId?: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}
export type AgentModelOverrides = Partial<Record<AgentModelRole, AgentModelOverride>>;

/** Deployment-only configuration. Parse errors never echo JSON or credential contents. */
export function readAgentModelOverrides(root: string, env: NodeJS.ProcessEnv): AgentModelOverrides {
  const configured = env.WHAT_THE_REPO_AGENT_MODELS_FILE?.trim();
  if (!configured) return {};
  const path = resolve(root, configured);
  const fail = (): never => { throw new Error("invalid_agent_model_config:WHAT_THE_REPO_AGENT_MODELS_FILE"); };
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 65_536) return fail();
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail();
    const result: AgentModelOverrides = {};
    for (const [role, entry] of Object.entries(data)) {
      if (!AGENT_MODEL_ROLES.includes(role as AgentModelRole) || !entry || typeof entry !== "object" || Array.isArray(entry)) return fail();
      const row = entry as Record<string, unknown>;
      for (const [key, value] of Object.entries(row)) {
        if (!["model", "provider", "base_url", "api_key", "api_key_file"].includes(key)
          || typeof value !== "string" || !value.trim()) return fail();
      }
      if (typeof row.model !== "string" || (row.api_key && row.api_key_file)) return fail();
      const apiKey = row.api_key_file
        ? readFileSync(resolve(dirname(path), row.api_key_file as string), "utf8").trim()
        : (row.api_key as string | undefined)?.trim();
      if ((row.api_key_file && !apiKey) || (apiKey && Buffer.byteLength(apiKey) > 16_384)) return fail();
      result[role as AgentModelRole] = {
        model: row.model.trim(), provider: (row.provider as string | undefined)?.trim(),
        baseUrl: (row.base_url as string | undefined)?.trim(), apiKey,
      };
    }
    return result;
  } catch { return fail(); }
}
