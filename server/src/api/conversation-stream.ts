export interface ConversationStreamClient {
  write(type: string, payload: unknown): void;
  end(): void;
  isOpen(): boolean;
}

export type ConversationStreamFrame = {
  type: "progress" | "result" | "error";
  payload: unknown;
  sequence?: number;
};

export type ConversationStreamTerminalFrame = {
  type: "result" | "error";
  payload: unknown;
  sequence?: number;
};

export interface ConversationStreamRun {
  readonly runId: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly controller: AbortController;
  readonly frames: ConversationStreamFrame[];
  readonly subscribers: Set<ConversationStreamClient>;
  terminal: boolean;
  cancelled: boolean;
  abortTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface ConversationStreamHubOptions {
  /** Keep a disconnected run alive long enough for browser retries. */
  disconnectGraceMs?: number;
  /** Keep terminal frames available for a late reconnect. */
  terminalRetentionMs?: number;
  /** Bound process memory while retaining all normal-sized run events. */
  maxFrames?: number;
}

const DEFAULT_DISCONNECT_GRACE_MS = 30_000;
const DEFAULT_TERMINAL_RETENTION_MS = 120_000;
const DEFAULT_MAX_FRAMES = 16_384;

/**
 * In-process fan-out for one streamed conversation run.
 *
 * The conversation runtime remains the owner of the model/session. This hub
 * only keeps safe SSE frames long enough for a browser to reconnect without
 * starting a second run or appending the user message twice.
 */
export class ConversationStreamHub {
  private readonly runs = new Map<string, ConversationStreamRun>();
  private readonly disconnectGraceMs: number;
  private readonly terminalRetentionMs: number;
  private readonly maxFrames: number;

  constructor(options: ConversationStreamHubOptions = {}) {
    this.disconnectGraceMs = Math.max(1_000, Math.floor(options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS));
    this.terminalRetentionMs = Math.max(1_000, Math.floor(options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS));
    this.maxFrames = Math.max(128, Math.floor(options.maxFrames ?? DEFAULT_MAX_FRAMES));
  }

  get(runId: string): ConversationStreamRun | undefined {
    return this.runs.get(runId);
  }

  create(input: {
    runId: string;
    projectId: string;
    ownerId: string;
    controller?: AbortController;
  }): ConversationStreamRun {
    const existing = this.runs.get(input.runId);
    if (existing) return existing;
    const run: ConversationStreamRun = {
      runId: input.runId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      controller: input.controller ?? new AbortController(),
      frames: [],
      subscribers: new Set(),
      terminal: false,
      cancelled: false,
    };
    this.runs.set(run.runId, run);
    return run;
  }

  attach(
    run: ConversationStreamRun,
    client: ConversationStreamClient,
    afterSequence: number,
  ): void {
    if (run.abortTimer) {
      clearTimeout(run.abortTimer);
      run.abortTimer = undefined;
    }
    run.subscribers.add(client);
    client.write("connected", {
      project_id: run.projectId,
      run_id: run.runId,
      resumed: afterSequence > 0,
    });
    for (const frame of run.frames) {
      if (frame.type === "progress") {
        if ((frame.sequence ?? 0) <= afterSequence) continue;
      }
      if (!client.isOpen()) {
        this.detach(run, client);
        return;
      }
      client.write(frame.type, frame.payload);
    }
    if (run.terminal) this.closeClient(run, client);
  }

  detach(run: ConversationStreamRun, client: ConversationStreamClient): void {
    run.subscribers.delete(client);
    if (run.terminal || run.subscribers.size > 0 || run.abortTimer) return;
    run.abortTimer = setTimeout(() => {
      run.abortTimer = undefined;
      if (!run.terminal && run.subscribers.size === 0 && !run.controller.signal.aborted) {
        run.controller.abort(new Error("conversation_stream_disconnected"));
      }
    }, this.disconnectGraceMs);
  }

  publishProgress(run: ConversationStreamRun, payload: Record<string, unknown>): void {
    if (run.terminal) return;
    const sequence = typeof payload.sequence === "number" ? payload.sequence : undefined;
    this.pushFrame(run, { type: "progress", payload, sequence });
    this.broadcast(run, "progress", payload);
  }

  finish(run: ConversationStreamRun, frame: ConversationStreamTerminalFrame): void {
    if (run.terminal) return;
    run.terminal = true;
    if (run.abortTimer) {
      clearTimeout(run.abortTimer);
      run.abortTimer = undefined;
    }
    this.pushFrame(run, frame);
    this.broadcast(run, frame.type, frame.payload);
    for (const client of [...run.subscribers]) this.closeClient(run, client);
    run.cleanupTimer = setTimeout(() => {
      if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
      this.runs.delete(run.runId);
    }, this.terminalRetentionMs);
  }

  markCancelled(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.cancelled = true;
    return true;
  }

  private pushFrame(run: ConversationStreamRun, frame: ConversationStreamFrame): void {
    run.frames.push(frame);
    if (run.frames.length <= this.maxFrames) return;
    run.frames.splice(0, run.frames.length - this.maxFrames);
  }

  private broadcast(run: ConversationStreamRun, type: string, payload: unknown): void {
    for (const client of [...run.subscribers]) {
      if (!client.isOpen()) {
        this.detach(run, client);
        continue;
      }
      try {
        client.write(type, payload);
      } catch {
        this.detach(run, client);
      }
    }
  }

  private closeClient(run: ConversationStreamRun, client: ConversationStreamClient): void {
    if (!run.subscribers.has(client)) return;
    run.subscribers.delete(client);
    try {
      client.write("done", {});
      client.end();
    } catch {
      // The browser may have already closed the socket; the run is still kept
      // in the hub until its normal terminal retention window expires.
    }
  }
}
