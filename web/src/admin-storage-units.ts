import type { AdminRow } from './admin-api';

export const GB = 1_000_000_000;
export const formatGB = (value: unknown) =>
  typeof value !== 'number' || !Number.isFinite(value)
    ? '未知'
    : value > 0 && value < 0.001 * GB
      ? '< 0.001 GB'
      : `${(value / GB).toLocaleString('zh-CN', { maximumFractionDigits: 3 })} GB`;
export function storagePolicyInputs(policy: AdminRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(policy).map(([key, value]) => [
      key,
      value === null
        ? ''
        : String(key.endsWith('Bytes') ? Number(value) / GB : value),
    ]),
  );
}
export function storagePolicyPayload(inputs: Record<string, string>): AdminRow {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [
      key,
      value === '' && key.startsWith('cos')
        ? null
        : key.endsWith('Bytes')
          ? Math.round(Number(value) * GB)
          : Number(value),
    ]),
  );
}
