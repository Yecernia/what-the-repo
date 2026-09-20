/** Stop admitting work on the first failure and drain every admitted task. */
export async function forEachBounded<T>(
  values: Iterable<T>, concurrency: number,
  operation: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RangeError('invalid_task_concurrency');
  }
  const iterator = values[Symbol.iterator]();
  let next = 0, failed = false, failure: unknown;
  const worker = async () => {
    try {
      while (!failed) {
        const step = iterator.next();
        if (step.done) return;
        await operation(step.value, next++);
      }
    } catch (error) { if (!failed) { failed = true; failure = error; } }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  try { iterator.return?.(); }
  catch (error) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;
}
