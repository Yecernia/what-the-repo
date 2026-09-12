/** Repository-name research can run before source facts or component semantics exist. */
import { createWebResearchTools, type WebResearchClient, type WebResearchState } from "../agent/web-research-tools.js";
import type { SemanticBatchContext } from "./semantic-contracts.js";
import { runRecordedSemanticBatch } from "./semantic-batch-runner.js";
import { WEB_SEARCH_VERSION } from "./web-research-client.js";

export interface InitialWebResearch {
  response: unknown;
  state: Omit<WebResearchState, "allowedUrls"> & { allowedUrls: string[] };
}

export function restoreWebResearchState(initial: InitialWebResearch): WebResearchState {
  const state = structuredClone(initial.state);
  return { ...state, allowedUrls: new Set(state.allowedUrls) };
}

export async function searchInitialRepositoryResearch(input: {
  repository: string;
  commitSha: string;
  client?: WebResearchClient;
  signal?: AbortSignal;
  batchContext?: SemanticBatchContext;
}): Promise<InitialWebResearch> {
  input.signal?.throwIfAborted();
  const query = `${input.repository} architecture design decisions`.slice(0, 300);
  return runRecordedSemanticBatch({
    descriptor: {
      batch_id: "value-initial-search", job_id: input.batchContext?.jobId ?? "semantic-untracked",
      // Source files are not available yet; this research unit is bound to the
      // confirmed repository revision, not a graph snapshot that does not exist.
      snapshot_id: `research:github:${input.repository}:${input.commitSha}`,
      phase: "value_discovery", ordinal: 29_999,
      input: { repository: input.repository, commit: input.commitSha, query,
        search: input.client?.identity ?? `${WEB_SEARCH_VERSION}:unconfigured` },
    },
    context: input.batchContext,
    run: async () => {
      const web = createWebResearchTools({ research: undefined, client: input.client });
      let response: unknown;
      try {
        const result = await web.tools[0]!.execute("initial-value-search", { query }, input.signal);
        response = JSON.parse(result.content.filter(row => row.type === "text").map(row => row.text).join(""));
      } catch {
        input.signal?.throwIfAborted();
        response = { query, status: "unavailable", error: web.state.searches.at(-1)?.errorCode ?? "web_search_unavailable",
          remaining_searches: 4 - web.state.searchCalls };
      }
      input.signal?.throwIfAborted();
      return { response, state: { ...web.state, allowedUrls: [...web.state.allowedUrls] } };
    },
  });
}
