type RecordPath = Array<string | number>;
export interface ProjectedCheckpointArray {
  target: unknown[];
  length: number;
  retained: boolean;
}

/** Resolve aliases before projection; path prefixes alone lose shared arrays. */
export function projectCheckpointHeader(root: unknown, parts: unknown, bytes: number,
  fields?: readonly string[]): { value: unknown; arrays: ProjectedCheckpointArray[] } {
  const invalid = () => new Error('analysis_checkpoint_payload_invalid');
  if (!Array.isArray(parts) || parts.length > bytes / 4) throw invalid();
  const seenTargets = new Set<unknown[]>();
  const arrays = parts.map((part: { path?: RecordPath; length?: number }) => {
    if (!part || !Array.isArray(part.path) || !Number.isSafeInteger(part.length)
      || part.length! < 0 || part.length! > bytes / 4) throw invalid();
    let target = root;
    for (const key of part.path) {
      if ((typeof key !== 'string' && (!Number.isSafeInteger(key) || Number(key) < 0))
        || !target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw invalid();
      target = (target as Record<string | number, unknown>)[key];
    }
    if (!Array.isArray(target) || target.length || seenTargets.has(target)) throw invalid();
    seenTargets.add(target);
    return { target, length: part.length!, retained: true };
  });
  if (fields === undefined) return { value: root, arrays };
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw invalid();
  const included = new Set(fields);
  for (const key of Object.keys(root)) {
    if (!included.has(key)) delete (root as Record<string, unknown>)[key];
  }
  const reachable = new WeakSet<object>();
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || reachable.has(value)) continue;
    reachable.add(value);
    if (value instanceof Map) {
      for (const [key, item] of value) { pending.push(key); pending.push(item); }
    } else if (value instanceof Set) {
      for (const item of value) pending.push(item);
    } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null) {
      for (const key of Object.keys(value)) pending.push((value as Record<string, unknown>)[key]);
    }
  }
  for (const part of arrays) part.retained = reachable.has(part.target);
  return { value: root, arrays };
}
