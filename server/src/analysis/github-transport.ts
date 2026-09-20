import { delay } from '../scheduling/permits.js';

export class GithubRateLimitError extends Error {
  readonly code = 'github_rate_limited';
  readonly statusCode = 503;
  constructor(readonly retryAfterMs: number) { super('github_rate_limited'); }
}

interface RetryClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}
const clock: RetryClock = { now: Date.now, sleep: delay, random: Math.random };

function cooldown(response: Response, attempt: number, now: number): number | null {
  const headers = response.headers;
  const retry = headers.get('retry-after');
  const exhausted = headers.get('x-ratelimit-remaining') === '0';
  if (response.status !== 429 && !(response.status === 403 && (retry !== null || exhausted))) return null;
  const edge = headers.get('x-wtr-rate-limit-source') === 'gateway';
  let minimum = 1000;
  let hinted = false;
  if (retry !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(parsed)) { minimum = Math.max(1000, parsed); hinted = true; }
  }
  if (exhausted) {
    const resetHeader = headers.get('x-ratelimit-reset');
    const reset = resetHeader !== null && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 : NaN;
    if (Number.isFinite(reset)) { minimum = Math.max(minimum, reset - now); hinted = true; }
  }
  return Math.max(minimum, (edge || hinted ? 1000 : 60_000) * 2 ** attempt);
}

/** Only for idempotent repository reads, including the gateway's read-only POST. */
export async function githubReadWithRetry(
  request: () => Promise<Response>,
  signal?: AbortSignal,
  timing: RetryClock = clock,
  retryWindowMs = 65_000,
): Promise<Response> {
  const deadline = timing.now() + retryWindowMs;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await request();
    const wait = cooldown(response, attempt, timing.now());
    if (wait === null) return response;
    // Discard rejected response bodies before waiting, releasing transport resources.
    await response.body?.cancel().catch(() => undefined);
    const pause = wait + timing.random() * 250;
    if (attempt >= 4 || timing.now() + pause >= deadline) throw new GithubRateLimitError(wait);
    await timing.sleep(pause, signal);
    signal?.throwIfAborted();
    if (timing.now() >= deadline) throw new GithubRateLimitError(wait);
  }
}
