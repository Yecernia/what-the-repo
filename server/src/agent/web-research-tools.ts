import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { RepositoryResearch, RepositoryResearchPage } from "../domain/snapshot.js";
import {
  fetchResearchPage,
  safeResearchUrl,
} from "../analysis/github.js";
import { createWebResearchClient, WebSearchError } from "../analysis/web-research-client.js";
import { WebPageError } from "../analysis/research-page.js";

const SEARCH_INPUT = Type.Object({
  query: Type.String({ minLength: 2, maxLength: 300 }),
});
const READ_PAGE_INPUT = Type.Object({
  url: Type.String({ minLength: 8, maxLength: 2_000 }),
});

export const WEB_RESEARCH_TOOL_NAMES = ["search_web", "read_web_page"] as const;

type WebToolDetails = {
  tool_name: string;
  urls: string[];
};

export interface WebResearchState {
  searchCalls: number;
  pageCalls: number;
  totalChars: number;
  allowedUrls: Set<string>;
  searchResults: RepositoryResearchPage[];
  readPages: RepositoryResearchPage[];
  toolsUsed: string[];
  searches: WebSearchAttempt[];
  pageReads: WebPageAttempt[];
  /** Search-service bodies kept outside model context until read_web_page. */
  cachedPages?: RepositoryResearchPage[];
}

export interface WebPageAttempt {
  url: string;
  status: "read" | "unavailable" | "cancelled";
  durationMs: number;
  chars: number;
  truncated: boolean;
  errorCode?: string;
  httpStatus?: number;
}

export interface WebSearchAttempt {
  provider?: string;
  credits?: number;
  errorCode?: string;
  query: string;
  status: "results" | "empty" | "unavailable" | "cancelled";
  resultCount: number;
  durationMs: number;
}

export interface WebResearchClient {
  identity?: string;
  search: (query: string, signal?: AbortSignal) => Promise<RepositoryResearchPage[] | WebSearchResponse>;
  readPage: typeof fetchResearchPage;
}

export interface WebSearchResponse { results: RepositoryResearchPage[]; credits?: number; pages?: RepositoryResearchPage[] }

function result(name: string, payload: unknown, urls: string[] = []): AgentToolResult<WebToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: { tool_name: name, urls },
  };
}

function addUnique(target: RepositoryResearchPage[], rows: RepositoryResearchPage[]): void {
  for (const row of rows) {
    const existing = target.findIndex((candidate) => candidate.url === row.url);
    if (existing >= 0) target[existing] = row;
    else target.push(row);
  }
}

export function createWebResearchTools(input: {
  research: RepositoryResearch | undefined;
  state?: WebResearchState;
  client?: WebResearchClient;
}): { tools: AgentTool[]; state: WebResearchState } {
  const client = input.client ?? createWebResearchClient();
  const initialUrls = [
    input.research?.homepage,
    input.research?.readme?.url,
    ...(input.research?.official_pages.map((page) => page.url) ?? []),
    ...(input.research?.web_search_results.map((page) => page.url) ?? []),
  ].map(safeResearchUrl).filter((url): url is string => Boolean(url));
  const state = input.state ?? {
    searchCalls: 0,
    pageCalls: 0,
    totalChars: 0,
    allowedUrls: new Set(initialUrls),
    searchResults: [],
    readPages: [],
    toolsUsed: [],
    searches: [],
    pageReads: [],
  };
  for (const url of initialUrls) state.allowedUrls.add(url);

  const track = (name: string): void => {
    if (!state.toolsUsed.includes(name)) state.toolsUsed.push(name);
  };

  const search: AgentTool<typeof SEARCH_INPUT, WebToolDetails> = {
    name: "search_web",
    label: "正在检索项目外部资料",
    description: "用公开项目名、技术名和简短问题搜索网页，不提交源码片段或凭据。摘要只能提出候选线索，必须回到当前 commit 的代码确认实现。最多调用 4 次；未配置、认证或额度错误不能靠换查询词解决。",
    executionMode: "sequential",
    parameters: SEARCH_INPUT,
    execute: async (_toolCallId, params: Static<typeof SEARCH_INPUT>, signal?: AbortSignal) => {
      track("search_web");
      if (signal?.aborted) throw new Error("web_search_cancelled");
      const permanentFailure = state.searches.find(row => ["not_configured", "authentication", "quota"].includes(row.errorCode ?? ""));
      if (permanentFailure) throw new Error(`web_search_${permanentFailure.errorCode}`);
      if (state.searchCalls >= 4) throw new Error("web_search_budget_exhausted");
      state.searchCalls += 1;
      const started = performance.now();
      let rows: RepositoryResearchPage[];
      try {
        const response = await client.search(params.query, signal);
        rows = Array.isArray(response) ? response : response.results;
        if (!Array.isArray(response) && response.pages) addUnique(state.cachedPages ??= [], response.pages);
        state.searches.push({ query: params.query, provider: client.identity, ...(!Array.isArray(response) && response.credits !== undefined ? { credits: response.credits } : {}), status: rows.length ? "results" : "empty", resultCount: rows.length, durationMs: performance.now() - started });
      } catch (error) {
        state.searches.push({ query: params.query, provider: client.identity, errorCode: error instanceof WebSearchError ? error.code : "unavailable", status: signal?.aborted ? "cancelled" : "unavailable", resultCount: 0, durationMs: performance.now() - started });
        throw error;
      }
      for (const row of rows) state.allowedUrls.add(row.url);
      addUnique(state.searchResults, rows);
      return result("search_web", {
        query: params.query,
        status: rows.length ? "results" : "empty",
        results: rows.map((row) => ({ url: row.url, title: row.title, snippet: row.content })),
        remaining_searches: 4 - state.searchCalls,
      }, rows.map((row) => row.url));
    },
  };

  const readPage: AgentTool<typeof READ_PAGE_INPUT, WebToolDetails> = {
    name: "read_web_page",
    label: "正在读取公开网页",
    description: "读取搜索结果或仓库已有官方链接的正文。只允许先前返回的 HTTPS URL，最多调用 6 次；truncated表示内容不完整，失败不代表页面没有相关信息，网页不能扩大代码事实范围。",
    parameters: READ_PAGE_INPUT,
    executionMode: "sequential",
    execute: async (_toolCallId, params: Static<typeof READ_PAGE_INPUT>, signal?: AbortSignal) => {
      track("read_web_page");
      if (signal?.aborted) throw new Error("web_page_cancelled");
      if (state.pageCalls >= 6) throw new Error("web_page_budget_exhausted");
      const url = safeResearchUrl(params.url);
      if (!url || !state.allowedUrls.has(url)) throw new Error("web_page_url_not_exposed");
      const remainingChars = Math.max(0, 48_000 - state.totalChars);
      if (!remainingChars) throw new Error("web_page_payload_budget_exhausted");
      state.pageCalls += 1;
      const started = performance.now();
      try {
        const page = state.cachedPages?.find(page => page.url === url)
          ?? await client.readPage(url, "community_search", signal);
        signal?.throwIfAborted();
        if (!page) throw new Error("web_page_unavailable");
        const limit = Math.min(24_000, remainingChars);
        const bounded = { ...page, content: page.content.slice(0, limit), truncated: page.truncated === true || limit < page.content.length };
        state.totalChars += bounded.content.length;
        addUnique(state.readPages, [bounded]);
        state.pageReads.push({ url, status: "read", durationMs: performance.now() - started, chars: bounded.content.length, truncated: bounded.truncated });
        return result("read_web_page", {
          url: bounded.url, title: bounded.title, content: bounded.content,
          truncated: bounded.truncated, remaining_page_reads: 6 - state.pageCalls,
        }, [bounded.url]);
      } catch (error) {
        const code = error instanceof WebPageError ? error.code : "unavailable";
        state.pageReads.push({ url, status: signal?.aborted ? "cancelled" : "unavailable", durationMs: performance.now() - started,
          chars: 0, truncated: false, errorCode: code, ...(error instanceof WebPageError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
        signal?.throwIfAborted();
        throw new Error(`web_page_${code}`);
      }
    },
  };

  return { tools: [search, readPage], state };
}
