export const FACT_CHUNK_FORMAT = 'fact-affected-ids-v1' as const;
const MAX_LISTS = 128, MAX_IDS = 32;
type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
interface Trie { children: Map<string, Trie>; index?: number }
function stringList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) return false;
  for (const id of value) if (typeof id !== 'string') return false;
  return true;
}

/** Deduplicate before JSON serialization, without mutating any fact or ID list.
 * The bounded trie avoids re-encoding the same 32 long stable IDs per row.
 * Unusual/unique lists remain literal arrays; no IDs are truncated.
 */
class Dictionary {
  private readonly root: Trie = { children: new Map() };
  readonly lists: string[][] = [];
  bytes = 0;
  encode(value: unknown): unknown {
    const row = object(value), provenance = object(row?.incremental_provenance);
    const ids = provenance?.affected_by_stable_ids;
    if (!row || !provenance || !stringList(ids)) return [-1, value];
    let trie = this.root;
    for (const id of ids) {
      let next = trie.children.get(id);
      if (!next) {
        if (this.lists.length >= MAX_LISTS) return [-1, value];
        next = { children: new Map() }; trie.children.set(id, next);
      }
      trie = next;
    }
    if (trie.index === undefined) {
      if (this.lists.length >= MAX_LISTS) return [-1, value];
      trie.index = this.lists.length; this.lists.push(ids);
      this.bytes += Buffer.byteLength(JSON.stringify(ids)) + 1;
    }
    return [trie.index, { ...row, incremental_provenance: { ...provenance, affected_by_stable_ids: null } }];
  }
}

export interface FactChunk { items: unknown[]; body: Uint8Array; format?: typeof FACT_CHUNK_FORMAT }
export function* factChunkBodies(values: unknown[], maxRows: number, maxBytes: number): Generator<FactChunk> {
  let dictionary = new Dictionary(), items: unknown[] = [], parts: string[] = [], bytes = 96, listCount = 0;
  const flush = (): FactChunk => ({ items, format: FACT_CHUNK_FORMAT,
    body: Buffer.from('{"schema":"' + FACT_CHUNK_FORMAT + '","dictionary":' + JSON.stringify(dictionary.lists.slice(0,listCount))
      + ',"rows":[' + parts.join(',') + ']}\n') });
  for (const value of values) {
    let part = JSON.stringify(dictionary.encode(value)) ?? 'null';
    let size = Buffer.byteLength(part) + 1;
    if (items.length && (items.length >= maxRows || bytes + dictionary.bytes + size > maxBytes)) {
      yield flush(); dictionary = new Dictionary(); items = []; parts = []; bytes = 96; listCount = 0;
      part = JSON.stringify(dictionary.encode(value)) ?? 'null'; size = Buffer.byteLength(part) + 1;
    }
    items.push(value); parts.push(part); bytes += size; listCount = dictionary.lists.length;
  }
  if (items.length) yield flush();
}

/** Called only after stored-byte integrity and bounded decompression checks. */
export function decodeFactChunk(value: unknown, format: unknown, count: number): unknown[] {
  if (format === undefined) {
    if (!Array.isArray(value) || value.length !== count) throw new Error('analysis_payload_chunk_invalid');
    return value;
  }
  const envelope = object(value);
  if (format !== FACT_CHUNK_FORMAT || envelope?.schema !== format || !Array.isArray(envelope.dictionary)
    || envelope.dictionary.length > MAX_LISTS || !Array.isArray(envelope.rows) || envelope.rows.length !== count)
    throw new Error('analysis_payload_chunk_invalid');
  const lists = envelope.dictionary;
  if (lists.some(ids => !stringList(ids)))
    throw new Error('analysis_payload_chunk_invalid');
  return envelope.rows.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < -1)
      throw new Error('analysis_payload_chunk_invalid');
    const [index, value] = entry;
    if (index === -1) return value;
    const row = object(value), provenance = object(row?.incremental_provenance);
    if (index >= lists.length || !provenance || provenance.affected_by_stable_ids !== null)
      throw new Error('analysis_payload_chunk_invalid');
    // Each logical row receives its own list, as in raw JSON parsing.
    provenance.affected_by_stable_ids = lists[index].slice();
    return value;
  });
}
