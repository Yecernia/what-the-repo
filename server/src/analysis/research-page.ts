import { compile } from "html-to-text";
import type { RepositoryResearchPage } from "../domain/snapshot.js";
import { assertPublicHttpsUrl, safePublicHttpsUrl, type PublicFetchOptions } from "../security/outbound-url.js";

const MAX_PAGE_CHARS = 24_000;
const MAX_PAGE_BYTES = MAX_PAGE_CHARS * 4;
const bodyText = compile({
  wordwrap: false,
  baseElements: { selectors: ["main"], returnDomByDefault: true },
  selectors: [
    ...["nav", "footer", "form", "button", "script", "style", "noscript", "svg", "iframe", "img"].map(selector => ({ selector, format: "skip" })),
    { selector: "a", options: { ignoreHref: true } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map(selector => ({ selector, options: { uppercase: false } })),
  ],
});
const titleText = compile({ wordwrap: false, baseElements: { selectors: ["title"], returnDomByDefault: false } });

export class WebPageError extends Error {
  constructor(readonly code: "invalid_url" | "address_blocked" | "redirect_blocked" | "http_error" | "unsupported_content_type" | "empty" | "timeout" | "network", readonly httpStatus?: number) {
    super(`web_page_${code}`);
  }
}

async function boundedText(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = MAX_PAGE_BYTES - bytes;
      text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      bytes += Math.min(remaining, chunk.value.byteLength);
      if (chunk.value.byteLength > remaining) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    signal.throwIfAborted();
    return { text: text + decoder.decode(), truncated };
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Read public text, checking every redirect before sending a credential-free request. */
export async function readResearchPage(
  url: string,
  sourceKind: RepositoryResearchPage["source_kind"],
  signal?: AbortSignal,
  options?: PublicFetchOptions,
): Promise<RepositoryResearchPage> {
  signal?.throwIfAborted();
  const safeUrl = safePublicHttpsUrl(url);
  if (!safeUrl) throw new WebPageError("invalid_url");
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]);
  try {
    let currentUrl = safeUrl;
    let response: Response;
    for (let hop = 0; ; hop++) {
      combined.throwIfAborted();
      await assertPublicHttpsUrl(currentUrl, options?.lookup);
      response = await (options?.fetchImpl ?? globalThis.fetch)(currentUrl, {
        headers: { accept: "text/html, text/plain, application/json", "user-agent": "what-the-repo-research" },
        signal: combined, redirect: "manual", credentials: "omit",
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (hop >= 3 || !location) throw new WebPageError("redirect_blocked");
      let next: string | null = null;
      try { next = safePublicHttpsUrl(new URL(location, currentUrl).href); } catch { /* Invalid redirect. */ }
      if (!next) throw new WebPageError("redirect_blocked");
      currentUrl = next;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !/text|json|html/i.test(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw response.ok ? new WebPageError("unsupported_content_type") : new WebPageError("http_error", response.status);
    }
    const raw = await boundedText(response, combined);
    const isHtml = /html/i.test(contentType);
    const content = (isHtml ? bodyText(raw.text) : raw.text).trim();
    combined.throwIfAborted();
    if (!content) throw new WebPageError("empty");
    const title = isHtml ? titleText(raw.text).trim() : "";
    return { url: safeUrl, title: title.slice(0, 300) || new URL(safeUrl).hostname,
      content: content.slice(0, MAX_PAGE_CHARS), source_kind: sourceKind,
      truncated: raw.truncated || content.length > MAX_PAGE_CHARS };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WebPageError) throw error;
    if (combined.aborted) throw new WebPageError("timeout");
    if (error instanceof Error && error.message === "outbound_address_blocked") throw new WebPageError("address_blocked");
    if (error instanceof Error && error.message === "outbound_redirect_blocked") throw new WebPageError("redirect_blocked");
    throw new WebPageError("network");
  }
}
