import { useEffect, useMemo, useState } from 'react';
import type { AdminRow } from './admin-api';

export const money = (v: unknown) =>
  v === null || v === undefined ? '未知' : `$${Number(v).toFixed(4)}`;
export const time = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '—';
export const rows = (v: unknown): AdminRow[] =>
  Array.isArray(v) ? (v as AdminRow[]) : [];
export const record = (v: unknown): AdminRow =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AdminRow) : {};
export const text = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);

/** Filter value of a field; missing values get their own option. */
const MISSING = '__missing__';
export const fieldValue = (row: AdminRow, key: string) =>
  row[key] === null || row[key] === undefined || row[key] === '' ? MISSING : String(row[key]);
/** An empty filter matches every row. */
export const matches = (row: AdminRow, key: string, filter: string) =>
  !filter || fieldValue(row, key) === filter;

/** Distinct values of one field, labelled and sorted by label. */
export function useOptions(data: AdminRow[], key: string, names: Record<string, string> = {}) {
  return useMemo(() => [...new Set(data.map((row) => fieldValue(row, key)))]
    .map((value): [string, string] => [value, value === MISSING ? '未标注' : names[value] ?? value])
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN')), [data, key, names]);
}

/** Pages an in-memory list; filters passed as `resetKey` return to page one. */
export function usePages<T>(items: T[], pageSize: number, resetKey: string) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return {
    visible: items.slice((current - 1) * pageSize, current * pageSize),
    pagination: { page: current, pages, total: items.length, pageSize },
    setPage,
  };
}
