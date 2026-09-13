import { useState } from 'react';
import type { AdminRow } from './admin-api';

export interface AudienceSample {
  observed_at: string;
  github: number;
  guest: number;
  online_github: number;
  online_guest: number;
}
const clock = (value: number) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
/** Preserve missing samples as gaps, including collector outages. */
export function sampleSegments(samples: AudienceSample[], maxGapMs = 90_000) {
  const segments: AudienceSample[][] = [];
  for (const point of samples) {
    const previous = segments.at(-1)?.at(-1);
    if (
      !previous ||
      Date.parse(point.observed_at) - Date.parse(previous.observed_at) > maxGapMs
    )
      segments.push([]);
    segments.at(-1)!.push(point);
  }
  return segments;
}
export function hourlyAudience(samples: AudienceSample[]) {
  const buckets = new Map<number, AudienceSample[]>();
  for (const point of samples) {
    const hour =
      Math.floor(Date.parse(point.observed_at) / 3_600_000) * 3_600_000;
    buckets.set(hour, [...(buckets.get(hour) ?? []), point]);
  }
  return [...buckets].map(([hour, points]) => ({
    observed_at: new Date(hour).toISOString(),
    github: 0,
    guest: 0,
    online_github:
      points.reduce((sum, p) => sum + p.online_github + p.online_guest, 0) /
      points.length,
    online_guest: Math.max(
      ...points.map((p) => p.online_github + p.online_guest),
    ),
    sampleCount: points.length,
  }));
}
export function AdminAudienceCharts({
  audience,
  history,
  observedAt,
}: {
  audience: AdminRow;
  history: AudienceSample[];
  observedAt: string;
}) {
  const [hours, setHours] = useState(24);
  const [selected, setSelected] = useState<string | null>(null);
  const now = Date.parse(observedAt);
  const end = hours === 24 ? Math.floor(now / 3_600_000) * 3_600_000 : now;
  const from = end - (hours === 24 ? 23 : 1) * 3_600_000;
  const raw = history.filter(
    (p) =>
      Number.isFinite(Date.parse(p.observed_at)) &&
      Date.parse(p.observed_at) >= from &&
      Date.parse(p.observed_at) <= now &&
      [p.github, p.guest, p.online_github, p.online_guest].every(
        (v) => Number.isFinite(v) && v >= 0,
      ),
  );
  const samples =
    hours === 24
      ? hourlyAudience(raw).filter((p) => Date.parse(p.observed_at) >= from)
      : raw;
  const last = samples.at(-1);
  const detail = samples.find((p) => p.observed_at === selected) ?? last;
  const max = Math.max(
    1,
    ...samples.map((p) => Math.max(p.online_github, p.online_guest)),
  );
  const ceiling = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const x = (p: AudienceSample) =>
    42 + ((Date.parse(p.observed_at) - from) / (end - from)) * 570;
  const y = (value: number) => 190 - (value / ceiling) * 154;
  const tickStep = hours === 24 ? 4 * 3_600_000 : 15 * 60_000;
  const ticks: number[] = [];
  for (let at = Math.ceil(from / tickStep) * tickStep; at <= end; at += tickStep) ticks.push(at);
  const segments = sampleSegments(samples, hours === 24 ? 3_600_000 : 90_000);
  const selectAt = (clientX: number, box: DOMRect) => {
    const target = ((clientX - box.left) / box.width) * 650;
    setSelected(samples.reduce((a, b) => Math.abs(x(a) - target) < Math.abs(x(b) - target) ? a : b).observed_at);
  };
  const github = typeof audience.github === 'number' ? audience.github : null;
  const guest = typeof audience.guest === 'number' ? audience.guest : null;
  const total = github !== null && guest !== null ? github + guest : null;
  const fresh =
    raw.at(-1) && now - Date.parse(raw.at(-1)!.observed_at) <= 90_000;
  return (
    <div className="admin-audience-grid">
      <section className="admin-card">
        <div className="admin-card-title">
          <h2>用户与访客</h2>
          <span className="admin-muted">当前保留身份</span>
        </div>
        <div className="admin-audience-total">
          <strong>{total ?? '未知'}</strong>
          <span>个账号 / 浏览器身份</span>
        </div>
        {total !== null && (
          <div
            className="admin-audience-bar"
            role="img"
            aria-label={`GitHub 账号 ${github}，访客浏览器身份 ${guest}`}
          >
            {total > 0 && (
              <>
                <span style={{ width: `${(github! / total) * 100}%` }} />
                <span style={{ width: `${(guest! / total) * 100}%` }} />
              </>
            )}
          </div>
        )}
        <div className="admin-chart-legend">
          <span>
            <i className="admin-series-github" />
            GitHub 账号 <b>{github ?? '未知'}</b>
          </span>
          <span>
            <i className="admin-series-guest" />
            访客身份 <b>{guest ?? '未知'}</b>
          </span>
        </div>
        <p className="admin-muted">
          排除已删除与系统身份。访客按浏览器近似统计，不等于真实人数；账号数不是在线人数。
        </p>
      </section>
      <section className="admin-card">
        <div className="admin-card-title">
          <h2>在线人数趋势</h2>
          <div className="admin-chart-period">
            {[1, 24].map((h) => (
              <button
                key={h}
                aria-pressed={hours === h}
                onClick={() => {
                  setHours(h);
                  setSelected(null);
                }}
              >
                近 {h} 小时
              </button>
            ))}
          </div>
        </div>
        <p className="admin-muted">
          {hours === 24 ? '每小时平均与峰值' : '每分钟登录用户与访客'} · 近 90
          秒前台心跳 · 北京时间
        </p>
        {samples.length ? (
          <>
            {!fresh && (
              <p className="admin-warning">
                采集已过期，以下保留最后有效记录。
              </p>
            )}
            <svg
              className="admin-line-chart"
              viewBox="0 0 650 222"
              role="img"
              aria-label={
                hours === 24
                  ? '每小时平均在线与峰值；未采集小时留空'
                  : '登录用户与访客在线人数趋势；缺失采样处断开'
              }
              onPointerDown={(event) => selectAt(event.clientX, event.currentTarget.getBoundingClientRect())}
              onPointerMove={(event) => {
                if (event.pointerType === 'mouse') selectAt(event.clientX, event.currentTarget.getBoundingClientRect());
              }}
              onPointerLeave={(event) => { if (event.pointerType === 'mouse') setSelected(null); }}
            >
              {[0, ceiling / 4, ceiling / 2, ceiling * 3 / 4, ceiling].filter(Number.isInteger).map((v) => (
                <g key={v} className="admin-chart-axis">
                  <line x1="42" x2="612" y1={y(v)} y2={y(v)} />
                  <text x="30" y={y(v) + 4} textAnchor="end">
                    {v}
                  </text>
                </g>
              ))}
              <g className="admin-chart-axis">
                {ticks.map(at => {
                  const position = 42 + (at - from) / (end - from) * 570;
                  const midnight = clock(at) === '00:00';
                  return <g key={at}>
                    <line x1={position} x2={position} y1="36" y2="190" />
                    <text x={position} y="214" textAnchor={position > 580 ? 'end' : position < 65 ? 'start' : 'middle'}>
                      {midnight ? new Date(at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }) : clock(at)}
                    </text>
                  </g>;
                })}
              </g>
              {selected && detail && <line className="admin-chart-cursor" x1={x(detail)} x2={x(detail)} y1="36" y2="190" />}
              {(['online_github', 'online_guest'] as const).map(
                (key, index) => (
                  <g
                    key={key}
                    className={index ? 'admin-plot-guest' : 'admin-plot-github'}
                  >
                    {segments.map((segment, i) => (
                          <g key={i}>
                            <polyline
                              points={segment
                                .map((p) => `${x(p)},${y(p[key])}`)
                                .join(' ')}
                            />
                            {segment.length === 1 && (
                              <circle
                                cx={x(segment[0])}
                                cy={y(segment[0][key])}
                                r="2"
                              />
                            )}
                          </g>
                        ))}
                    {selected && detail && (
                      <circle
                        cx={x(detail)}
                        cy={y(detail[key])}
                        r="2.5"
                      />
                    )}
                  </g>
                ),
              )}
            </svg>
            <label className="admin-chart-scrubber">
              查看采样时间
              <input
                type="range"
                min="0"
                max={samples.length - 1}
                value={detail ? samples.indexOf(detail) : 0}
                aria-label="选择在线人数采样时间"
                onChange={(e) =>
                  setSelected(samples[Number(e.target.value)].observed_at)
                }
              />
            </label>
            <div className="admin-chart-legend" aria-live="polite">
              <span>{detail && new Date(detail.observed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              <span>
                <i className="admin-series-github" />
                {hours === 24 ? '平均在线' : '登录用户'}{' '}
                <b>
                  {hours === 24
                    ? detail?.online_github.toFixed(1)
                    : detail?.online_github}
                </b>
              </span>
              <span>
                <i className="admin-series-guest" />
                {hours === 24 ? '在线峰值' : '访客'}{' '}
                <b>{detail?.online_guest}</b>
              </span>
            </div>
            {hours === 24 && detail && (
              <p className="admin-muted">
                该小时已采集{' '}
                {
                  (detail as ReturnType<typeof hourlyAudience>[number])
                    .sampleCount
                }{' '}
                / 60 分钟，仅按已有采样计算。
                {Date.parse(detail.observed_at) + 3_600_000 > now ? '当前小时尚未结束。' : ''}
              </p>
            )}
          </>
        ) : (
          <p className="admin-chart-empty">
            暂无历史采样，接入采集后开始绘制。
          </p>
        )}
        <p className="admin-muted">
          保留 7 天汇总，展示近 24 小时。空白时段未采集，不补零或推算历史。
        </p>
      </section>
    </div>
  );
}
