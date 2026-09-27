import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  JsonlSessionRepo,
  NodeExecutionEnv,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core/node";
import {
  uuidv7,
  createCompactionSummaryMessage,
  estimateContextTokens,
  type AgentMessage,
  type CompactionEntry,
  type Entry,
  type SessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { PiModelRuntime, PiSessionIdentity } from "./types.js";
import { historicalSummary, replayScope, type ReplayConfiguration } from "./session-replay.js";
import { KeyedMutex } from "./mutex.js";

export interface PiSessionContext {
  writeFence?: {permitId:string};
  signal?: AbortSignal;
  session: Session<SessionMetadata>;
  entries: Entry[];
  messages: AgentMessage[];
}

export interface PiSessionBackendOptions {
  signal?: AbortSignal;
  /** Called once the backend has acquired its cross-request/session lock. */
  onAcquired?: () => void;
}

export interface PiSessionWaitOptions extends PiSessionBackendOptions {
  failFast?: boolean;
  waitTimeoutMs?: number;
}

export class PiSessionWaitTimeoutError extends Error {
  constructor() {
    super("pi_session_lock_wait_timeout");
    this.name = "PiSessionWaitTimeoutError";
  }
}

export interface PiSessionBackend {
  withSession<T>(
    identity: PiSessionIdentity,
    task: (session: Session<SessionMetadata>, signal?: AbortSignal, writeFence?: {permitId:string}) => Promise<T>,
    options?: PiSessionBackendOptions,
  ): Promise<T>;
  delete(sessionId: string): Promise<void>;
  listOwnerSessions(ownerId: string): Promise<Array<{
    sessionId: string;
    projectId: string;
    snapshotId: string | null;
  }>>;
  deleteOwner(ownerId: string): Promise<number>;
}

function fileSystem(cwd: string): NodeExecutionEnv {
  return new NodeExecutionEnv({ cwd });
}

function durableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function projectSessionId(
  ownerId: string,
  projectId: string,
  snapshotId: string | null,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 1, ownerId, projectId, snapshotId }))
    .digest("hex");
  return `project-${digest}`;
}

function entryMessages(entries: Entry[]): AgentMessage[] {
  let latestCompaction = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      latestCompaction = index;
      break;
    }
  }
  const result: AgentMessage[] = [];
  if (latestCompaction >= 0) {
    const compaction = entries[latestCompaction] as CompactionEntry;
    result.push(createCompactionSummaryMessage(
      compaction.summary,
      compaction.tokensBefore,
      compaction.timestamp,
    ));
    result.push(...compaction.retainedTail);
    for (const entry of entries.slice(latestCompaction + 1)) {
      if (entry.type === "message") result.push(entry.message);
    }
    return result;
  }
  for (const entry of entries) {
    if (entry.type === "message") result.push(entry.message);
  }
  return result;
}

class JsonlPiSessionBackend implements PiSessionBackend {
  private readonly repo: JsonlSessionRepo;
  private readonly cwd: string;

  constructor(private readonly sessionsRoot: string) {
    this.cwd = sessionsRoot;
    const fs = fileSystem(this.cwd);
    this.repo = new JsonlSessionRepo({ fs, sessionsRoot });
  }

  async withSession<T>(
    identity: PiSessionIdentity,
    task: (session: Session<SessionMetadata>, signal?: AbortSignal, writeFence?: {permitId:string}) => Promise<T>,
    options: PiSessionBackendOptions = {},
  ): Promise<T> {
    options.onAcquired?.();
    await mkdir(this.sessionsRoot, { recursive: true });
    const metadata = (await this.repo.list()).find((row) => row.id === identity.sessionId);
    const session = metadata
      ? await this.repo.open(metadata)
      : await this.repo.create({
        id: identity.sessionId,
        cwd: this.cwd,
        metadata: {
          ownerId: identity.ownerId,
          projectId: identity.projectId,
          snapshotId: identity.snapshotId,
          skillId: identity.skillId,
          skillVersion: identity.skillVersion,
        },
      });
    return task(session as unknown as Session<SessionMetadata>, options.signal);
  }

  async delete(sessionId: string): Promise<void> {
    const metadata = (await this.repo.list()).find((row) => row.id === sessionId);
    if (metadata) await this.repo.delete(metadata as JsonlSessionMetadata);
  }

  async listOwnerSessions(ownerId: string): Promise<Array<{
    sessionId: string;
    projectId: string;
    snapshotId: string | null;
  }>> {
    const rows = await this.repo.list();
    return rows.flatMap((row) => {
      const metadata = row.metadata as Partial<SessionMetadata> & {
        ownerId?: unknown;
        projectId?: unknown;
        snapshotId?: unknown;
      };
      if (metadata.ownerId !== ownerId || typeof metadata.projectId !== "string") return [];
      return [{
        sessionId: row.id,
        projectId: metadata.projectId,
        snapshotId: typeof metadata.snapshotId === "string" ? metadata.snapshotId : null,
      }];
    });
  }

  async deleteOwner(ownerId: string): Promise<number> {
    const rows = await this.listOwnerSessions(ownerId);
    await Promise.all(rows.map((row) => this.delete(row.sessionId)));
    return rows.length;
  }
}

export class PiSessionStore {
  private readonly backend: PiSessionBackend;
  private readonly mutex = new KeyedMutex();

  constructor(backend: string | PiSessionBackend) {
    this.backend = typeof backend === "string" ? new JsonlPiSessionBackend(backend) : backend;
  }

  async withSession<T>(
    identity: PiSessionIdentity,
    task: (context: PiSessionContext) => Promise<T>,
    options: PiSessionWaitOptions = {},
  ): Promise<T> {
    if (options.failFast && this.mutex.isLocked(identity.sessionId)) throw new PiSessionWaitTimeoutError();
    const waitController = new AbortController();
    const sessionSignal = options.signal ? AbortSignal.any([options.signal, waitController.signal]) : waitController.signal;
    let waiting = true;
    const abortFromCaller = (): void => {
      waitController.abort(options.signal?.reason);
    };
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = options.waitTimeoutMs === undefined
      ? null
      : setTimeout(() => waitController.abort(new PiSessionWaitTimeoutError()), Math.max(1, options.waitTimeoutMs));
    timeout?.unref();
    const stopWaiting = (): void => {
      if (!waiting) return;
      waiting = false;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    };
    try {
      return await this.mutex.runExclusive(identity.sessionId, () => this.backend.withSession(
        identity,
        async (session, signal, writeFence) => {
          stopWaiting();
          const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
          return task({ session, entries, messages: entryMessages(entries), signal, writeFence });
        },
        { signal: sessionSignal, onAcquired: stopWaiting },
      ), { signal: waitController.signal });
    } finally {
      stopWaiting();
    }
  }

  async snapshot(identity: PiSessionIdentity): Promise<{ entries: Entry[]; messages: AgentMessage[] }> {
    return this.withSession(identity, async ({ entries, messages }) => ({ entries, messages }));
  }

  async prepareTurn(context: PiSessionContext, turn: {
    messageId: string; replace: boolean; previousMessages: AgentMessage[];
  }): Promise<void> {
    const { session } = context;
    if (turn.replace) {
      const marker = [...context.entries].reverse().find(entry => entry.type === "custom"
        && entry.customType === "conversation_turn"
        && (entry.data as { messageId?: unknown } | undefined)?.messageId === turn.messageId);
      if (marker) {
        await session.moveLane("main", marker.parentId);
      } else {
        // Legacy turns have no boundary marker. Preserve the old log, but build
        // the active context from the visible turns before the edited question.
        await session.moveLane("main", null);
        await this.appendMessages(session, turn.previousMessages);
      }
    }
    await session.appendCustomEntry("conversation_turn", { messageId: turn.messageId });
    context.entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
    context.messages = entryMessages(context.entries);
  }

  async appendMessages(session: Session<SessionMetadata>, messages: AgentMessage[]): Promise<void> {
    for (const message of messages) await session.appendMessage(durableJson(message));
  }

  async appendCompaction(
    session: Session<SessionMetadata>,
    result: {
      summary: string;
      tokensBefore: number;
      retainedTail: AgentMessage[];
      details?: unknown;
      usage?: unknown;
    },
  ): Promise<void> {
    const entry: Omit<CompactionEntry, "parentId" | "seq" | "timestamp"> = {
      type: "compaction",
      id: uuidv7(),
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      retainedTail: result.retainedTail,
      ...(result.details === undefined ? {} : { details: result.details }),
      ...(result.usage === undefined ? {} : { usage: result.usage as CompactionEntry["usage"] }),
    };
    await session.appendEntry(durableJson(entry), "main");
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(sessionId);
  }

  /** Repair a legacy context from the visible transcript without deleting its original log. */
  async recoverVisibleConversation(identity: PiSessionIdentity, messages: AgentMessage[]): Promise<boolean> {
    const restored = messages;
    const digest = createHash("sha256").update(JSON.stringify(restored)).digest("hex");
    return this.withSession(identity, async ({ session, entries, messages: previous }) => {
      if (entries.some((entry) => entry.type === "compaction"
        && (entry.details as { visibleHistoryDigest?: string } | undefined)?.visibleHistoryDigest === digest)) return false;
      await this.appendCompaction(session, {
        summary: historicalSummary(restored),
        tokensBefore: estimateContextTokens(previous).tokens,
        retainedTail: [],
        details: { reason: "visible_history_recovery", visibleHistoryDigest: digest },
      });
      await session.appendCustomEntry("model_replay_scope", { version: 1, scope: null });
      return true;
    });
  }

  async listOwnerSessions(ownerId: string): Promise<Array<{
    sessionId: string;
    projectId: string;
    snapshotId: string | null;
  }>> {
    return this.backend.listOwnerSessions(ownerId);
  }

  /** Rebuilds a session from authoritative project messages after an owner merge. */
  async rebuildFromMessages(
    identity: PiSessionIdentity,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string; createdAt?: string }>,
  ): Promise<void> {
    await this.withSession(identity, async ({ session, messages: previous }) => {
      await this.appendCompaction(session, {
        summary: historicalSummary(messages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.createdAt ? Date.parse(message.createdAt) : Date.now(),
        } as AgentMessage))),
        tokensBefore: estimateContextTokens(previous).tokens,
        retainedTail: [],
        details: { reason: "authoritative_history_rebuild" },
      });
      await session.appendCustomEntry("model_replay_scope", { version: 1, scope: null });
    });
  }

  async ensureReplayScope(context: PiSessionContext, runtime: PiModelRuntime, configuration?: ReplayConfiguration): Promise<void> {
    const scope = replayScope(runtime, configuration);
    const marker = [...context.entries].reverse().find((entry) =>
      entry.type === "custom" && entry.customType === "model_replay_scope");
    const previous = marker?.type === "custom" ? marker.data as { version?: number; scope?: string | null } : undefined;
    if (previous?.version === 1 && previous.scope === scope) return;
    // Recovery and merge already produce a protocol-independent history summary.
    if (context.messages.length && !(context.messages.length === 1 && context.messages[0]?.role === "compactionSummary")) {
      await this.appendCompaction(context.session, {
        summary: historicalSummary(context.messages),
        tokensBefore: estimateContextTokens(context.messages).tokens,
        retainedTail: [],
        details: { reason: previous?.scope ? "model_replay_scope_changed" : "legacy_replay_boundary" },
      });
    }
    await context.session.appendCustomEntry("model_replay_scope", { version: 1, scope });
    context.entries = await context.session.findEntriesOnBranch({ order: "oldestFirst" });
    context.messages = entryMessages(context.entries);
  }

  async deleteOwner(ownerId: string): Promise<number> {
    return this.backend.deleteOwner(ownerId);
  }

  static newId(): string {
    return randomUUID();
  }
}
