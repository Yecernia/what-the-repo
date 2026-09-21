const REDACTED = '[redacted]';

/** Exact credential values and common wire encodings; never infer a key prefix. */
export function credentialRedactor(secrets: Iterable<string>) {
  const patterns = [...new Set([...secrets].filter(Boolean).flatMap(value => [
    value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
  ]))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    for (const pattern of patterns) value = value.split(pattern).join(REDACTED);
    return value;
  };
  const data = <T>(value: T): T => {
    if (!patterns.length) return value;
    const seen = new WeakMap<object, unknown>();
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') return text(item);
      if (!item || typeof item !== 'object') return item;
      if (seen.has(item)) return seen.get(item);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
        && Object.getPrototypeOf(item) !== null) return item;
      const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
      seen.set(item, result);
      for (const [key, child] of Object.entries(item)) Object.defineProperty(result, text(key), {
        value: visit(child), enumerable: true, writable: true, configurable: true,
      });
      return result;
    };
    return visit(value) as T;
  };  // Hold only a possible credential prefix across chunks, not the whole answer.
  const stream = () => {
    let pending = '';
    return {
      push(chunk: string): string {
        const value = pending + chunk;
        pending = '';
        let output = '', position = 0;
        while (position < value.length) {
          const candidates = patterns.filter(pattern => pattern[0] === value[position]);
          const tailLength = value.length - position;
          if (candidates.some(pattern => pattern.length > tailLength && pattern.startsWith(value.slice(position)))) {
            pending = value.slice(position); break;
          }
          const matched = candidates.find(pattern => value.startsWith(pattern, position));
          if (matched) { output += REDACTED; position += matched.length; }
          else { output += value[position]; position++; }
        }
        return output;
      },
      finish(): string { const tail = text(pending); pending = ''; return tail; },
    };
  };
  return { text, data, stream, contains: (value: string) => patterns.some(pattern => value.includes(pattern)) };
}
