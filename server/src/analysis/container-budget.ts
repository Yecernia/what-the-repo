import { readFile } from 'node:fs/promises';

/** Fail early when a stale container limit cannot hold the configured working budget. */
export async function assertAnalysisContainerBudget(memoryMb: number): Promise<void> {
  if (process.platform !== 'linux') return;
  let limit = Infinity;
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const text = await readFile(path, 'utf8').catch(() => 'max');
    const bytes = Number(text.trim());
    if (Number.isFinite(bytes) && bytes > 0) limit = Math.min(limit, bytes);
  }
  const requested = (memoryMb + Math.max(512, memoryMb * 0.15)) * 1048576;
  if (requested > limit) throw new Error('analysis_memory_budget_exceeds_container_limit');
}
