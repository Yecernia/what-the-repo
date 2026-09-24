import type { ReactNode } from 'react';
import type { AdminRow } from './admin-api';
import { AdminCode } from './AdminCode';
import { Pagination } from './AdminRepositoryViews';
import { text, usePages } from './admin-format';

export type Column =
  | [string, string, (v: unknown, row: AdminRow) => ReactNode]
  | [string, string];

export function Table({ data, columns, empty = '暂无记录' }: {
  data: AdminRow[];
  columns: Column[];
  empty?: string;
}) {
  if (!data.length) return <p className="admin-empty">{empty}</p>;
  return (
    <div className="admin-table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(([key, label], index) => (
              <th key={key + index}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={String(
                row.id ?? row.job_id ?? row.project_id ?? row.owner_id ?? row.update_id ?? row.run_id ?? i,
              )}
            >
              {columns.map(([key, , format], index) => (
                <td key={key + index}>
                  {format ? format(row[key], row) : row[key] && typeof row[key] === 'object'
                    ? <AdminCode source={JSON.stringify(row[key], null, 2)} /> : text(row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A table with paging; the pager is hidden while everything fits on one page. */
export function PagedTable({ data, columns, pageSize = 20, resetKey, label, empty }: {
  data: AdminRow[];
  columns: Column[];
  pageSize?: number;
  resetKey: string;
  label: string;
  empty?: string;
}) {
  const { visible, pagination, setPage } = usePages(data, pageSize, resetKey);
  return (
    <>
      <Table data={visible} columns={columns} empty={empty} />
      {pagination.pages > 1 && <Pagination value={pagination} onChange={setPage} label={label} />}
    </>
  );
}

export function ListToolbar({ children, summary }: { children: ReactNode; summary?: ReactNode }) {
  return (
    <div className="admin-list-toolbar">
      <div className="admin-list-filters">{children}</div>
      {summary && <p className="admin-list-summary">{summary}</p>}
    </div>
  );
}

export function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">全部</option>
        {options.map(([option, name]) => (
          <option key={option} value={option}>{name}</option>
        ))}
      </select>
    </label>
  );
}

export function SearchInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="admin-list-search">
      {label}
      <input type="search" value={value} placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function ViewSwitch<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="admin-view-switch" role="group" aria-label={label}>
      {options.map(([option, name]) => (
        <button key={option} type="button" aria-pressed={value === option}
          onClick={() => onChange(option)}>{name}</button>
      ))}
    </div>
  );
}
