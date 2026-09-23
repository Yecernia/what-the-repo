import { readCheckpointRecords, type CheckpointDescriptor } from './checkpoint-records.js';

export interface AnalysisCheckpointReadOptions {
  omitStatic?: boolean;
  /** Assembly only: upload compiler data before hydrating either fact graph. */
  deferPublication?: boolean;
  signal?: AbortSignal;
}
export interface PublicationCheckpointSnapshot {
  snapshot: unknown;
  previousFactGraph: unknown | null;
}
export interface LoadedAnalysisCheckpoint<T> {
  checkpoint: T;
  snapshot: T | null;
  loadPublication?: () => Promise<PublicationCheckpointSnapshot>;
}
export interface CheckpointRecordSource extends CheckpointDescriptor { path: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('analysis_checkpoint_payload_invalid');
  return value as Record<string, unknown>;
}
const COMPILER_FIELDS = ['parsed', 'syntax_files', 'lsp_results'] as const;
function pin(source: CheckpointRecordSource): Readonly<CheckpointRecordSource> {
  return Object.freeze({ path: source.path, bytes: source.bytes, sha256: source.sha256 });
}

/** This closure captures descriptors only, never the decoded compiler cache. */
function publicationLoader(main: CheckpointRecordSource, compiler: CheckpointRecordSource | undefined,
  needsPrevious: boolean, signal?: AbortSignal): () => Promise<PublicationCheckpointSnapshot> {
  return async () => {
    signal?.throwIfAborted();
    const value = object(await readCheckpointRecords(main.path, main, { includeRootFields: ['snapshot'], signal }));
    if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) {
      throw new Error('analysis_checkpoint_snapshot_missing');
    }
    const previous = compiler
      ? object(await readCheckpointRecords(compiler.path, compiler, { includeRootFields: ['previous_fact_graph'], signal })).previous_fact_graph
      : null;
    if (needsPrevious && previous == null) throw new Error('analysis_checkpoint_previous_graph_missing');
    if (previous != null) {
      const graph = object(previous);
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('analysis_checkpoint_payload_invalid');
    }
    return { snapshot: value.snapshot, previousFactGraph: previous ?? null };
  };
}

/** Paths/digests come from one pointer read; later reads never follow a new pointer. */
export async function loadDeferredPublicationCheckpoint<T>(mainSource: CheckpointRecordSource,
  compilerSource?: CheckpointRecordSource, signal?: AbortSignal): Promise<LoadedAnalysisCheckpoint<T>> {
  const main = pin(mainSource), compiler = compilerSource ? pin(compilerSource) : undefined;
  const row = object(await readCheckpointRecords(main.path, main, { includeRootFields: ['checkpoint'], signal }));
  const checkpoint = object(row.checkpoint);
  if (checkpoint.stage !== 'assembly') throw new Error('analysis_checkpoint_stage_mismatch');
  if ([...COMPILER_FIELDS, 'previous_fact_graph'].some(key => checkpoint[key] !== undefined)) {
    throw new Error('analysis_checkpoint_inline_static_unsupported');
  }
  const needsCompiler = checkpoint.provenance_applied !== true;
  if (needsCompiler && !compiler) throw new Error('analysis_checkpoint_static_missing');
  const plan = checkpoint.plan === undefined ? undefined : object(checkpoint.plan);
  const fromPublicKey = checkpoint.from_public_key;
  const hasPreviousKey = typeof fromPublicKey === 'string' && /^[a-f0-9]{64}$/.test(fromPublicKey);
  if (fromPublicKey != null && !hasPreviousKey) throw new Error('analysis_checkpoint_payload_invalid');
  // New incremental checkpoints retain the immutable previous public key, and
  // the assembly stage streams only the history rows needed for provenance.
  const loadPublication = publicationLoader(main, compiler,
    needsCompiler && plan?.mode === 'incremental' && !hasPreviousKey, signal);
  if (compiler) {
    const cache = object(await readCheckpointRecords(compiler.path, compiler,
      { includeRootFields: COMPILER_FIELDS, signal }));
    if (needsCompiler && (!Array.isArray(cache.parsed) || !Array.isArray(cache.lsp_results))) {
      throw new Error('analysis_checkpoint_static_invalid');
    }
    for (const key of COMPILER_FIELDS) {
      if (cache[key] !== undefined && !Array.isArray(cache[key])) throw new Error('analysis_checkpoint_payload_invalid');
      if (Object.hasOwn(cache, key)) checkpoint[key] = cache[key];
    }
  }
  return { checkpoint: checkpoint as T, snapshot: null, loadPublication };
}
