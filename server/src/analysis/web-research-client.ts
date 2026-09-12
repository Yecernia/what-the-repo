import type { WebResearchClient, WebSearchResponse } from "../agent/web-research-tools.js";
import type { RepositoryResearchPage } from "../domain/snapshot.js";
import { safeResearchUrl } from "./github.js";
import { readResearchPage } from "./research-page.js";

export const WEB_SEARCH_VERSION = "tavily-basic-v4";

export class WebSearchError extends Error {
  constructor(readonly code: "not_configured" | "authentication" | "quota" | "rate_limit" | "invalid_response" | "response_too_large" | "timeout" | "network" | "service") {
    super(`web_search_${code}`);
  }
}

/** One client per analysis; parsed page bodies never enter the model unless requested. */
export function createWebResearchClient(apiKey?: string | null, fetchImpl: typeof fetch = globalThis.fetch): WebResearchClient {
  return {
    identity: `${WEB_SEARCH_VERSION}:${apiKey?.trim() ? "configured" : "unconfigured"}`,
    search: async (query, signal): Promise<WebSearchResponse> => {
      signal?.throwIfAborted();
      if (!apiKey?.trim()) throw new WebSearchError("not_configured");
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
      try {
        // This is a deployment-owned, fixed service endpoint (like the GitHub API),
        // never a URL chosen by repository text or the model. Keep TLS verification
        // and forbid redirects so the credential cannot follow a returned URL.
        const response = await fetchImpl("https://api.tavily.com/search", {
          method: "POST", redirect: "error", signal: combined,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.trim()}` },
          body: JSON.stringify({ query: query.trim().slice(0, 300), search_depth: "basic", topic: "general",
            max_results: 4, chunks_per_source: 3, auto_parameters: false, include_answer: false,
            include_images: false, include_raw_content: "markdown", include_usage: true }),
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          throw new WebSearchError(response.status === 401 || response.status === 403 ? "authentication"
            : response.status === 429 ? "rate_limit" : response.status === 432 || response.status === 433 ? "quota" : "service");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new WebSearchError("invalid_response");
        const abort = () => { void reader.cancel().catch(() => undefined); };
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
        let body = "";
        let bytes = 0;
        const decoder = new TextDecoder();
        try {
          while (true) {
            combined.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 1_048_576) {
              await reader.cancel().catch(() => undefined);
              throw new WebSearchError("response_too_large");
            }
            body += decoder.decode(chunk.value, { stream: true });
          }
          combined.throwIfAborted();
          body += decoder.decode();
        } finally {
          combined.removeEventListener("abort", abort);
          reader.releaseLock();
        }
        let data: { results?: unknown; usage?: { credits?: unknown } };
        try { data = JSON.parse(body); } catch { throw new WebSearchError("invalid_response"); }
        if (!data || !Array.isArray(data.results)) throw new WebSearchError("invalid_response");
        const results: RepositoryResearchPage[] = [];
        const pages: RepositoryResearchPage[] = [];
        for (const raw of data.results.slice(0, 4)) {
          if (!raw || typeof raw !== "object") throw new WebSearchError("invalid_response");
          const row = raw as Record<string, unknown>;
          const url = safeResearchUrl(row.url);
          if (typeof row.url !== "string") throw new WebSearchError("invalid_response");
          if (!url || results.some((page) => page.url === url)) continue;
          if (typeof row.title !== "string" || typeof row.content !== "string") throw new WebSearchError("invalid_response");
          const page: RepositoryResearchPage = { url, title: row.title.slice(0, 300), content: row.content.slice(0, 1_500), source_kind: "community_search" };
          results.push(page);
          if (typeof row.raw_content === "string" && row.raw_content.trim()) {
            pages.push({ ...page, content: row.raw_content.slice(0, 24_000), truncated: row.raw_content.length > 24_000 });
          }
        }
        const credits = data.usage?.credits;
        return { results, ...(pages.length ? { pages } : {}), ...(typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? { credits } : {}) };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof WebSearchError) throw error;
        // Do not copy response bodies, request headers or raw fetch errors into traces.
        throw new WebSearchError(combined.aborted ? "timeout" : "network");
      }
    },
    readPage: async (url, sourceKind, signal, options) => {
      signal?.throwIfAborted();
      return readResearchPage(url, sourceKind, signal, options);
    },
  };
}
