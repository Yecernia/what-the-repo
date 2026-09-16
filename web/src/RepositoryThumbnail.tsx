import { useMemo } from 'react';
import { useUiLanguage } from './ui-language';
import { buildLayerOverviewFlow } from './component-overview';
import type { Snapshot } from './types';

export function RepositoryThumbnail({ snapshot }: { snapshot: Snapshot }) {
  const uiLanguage = useUiLanguage();
  const flow = useMemo(() => buildLayerOverviewFlow(snapshot), [snapshot, uiLanguage]);
  const positions = new Map(flow.nodes.map(node => [
    node.id,
    {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 260,
      height: node.height ?? 156,
    },
  ]));
  if (!flow.nodes.length) return <div className="repository-thumbnail-empty" />;

  const minX = Math.min(...flow.nodes.map(node => node.position.x));
  const minY = Math.min(...flow.nodes.map(node => node.position.y));
  const maxX = Math.max(...flow.nodes.map(node => node.position.x + (node.width ?? 260)));
  const maxY = Math.max(...flow.nodes.map(node => node.position.y + (node.height ?? 156)));

  return (
    <svg
      className="repository-thumbnail"
      viewBox={`${minX - 30} ${minY - 30} ${maxX - minX + 60} ${maxY - minY + 60}`}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      {flow.edges.map(edge => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;
        return (
          <line
            key={edge.id}
            x1={source.x + source.width}
            y1={source.y + source.height / 2}
            x2={target.x}
            y2={target.y + target.height / 2}
          />
        );
      })}
      {flow.nodes.map(node => {
        const point = positions.get(node.id)!;
        return (
          <rect
            key={node.id}
            x={point.x}
            y={point.y}
            width={point.width}
            height={point.height}
            rx={10}
          />
        );
      })}
    </svg>
  );
}
