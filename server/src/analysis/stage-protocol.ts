import type { AnalysisJob } from '../domain/jobs.js';

export type AnalysisExecutionStage = 'fetch' | 'cpu' | 'semantic' | 'publish' | 'overlay';
export interface AnalysisStageExecutor {
  run(job: AnalysisJob, signal: AbortSignal): Promise<void>;
}
export function checkpointExecutionStage(stage?: string): AnalysisExecutionStage {
  if (stage === 'source') return 'cpu';
  if (stage === 'semantic') return 'semantic';
  if (stage === 'assembly') return 'publish';
  return stage ? 'cpu' : 'fetch';
}
