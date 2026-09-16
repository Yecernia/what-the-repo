import { useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { RepositoryWorkspace } from './RepositoryWorkspace';
import {
  buildComponentFlow,
  buildHumanProjectionFlow,
  buildLayerOverviewFlow,
  buildLayerScopeFlow,
  getArchitectureLayers,
  getArchitectureScopes,
} from './component-flow';
import type { Project, Snapshot } from './types';
import { setUiLanguage } from './ui-language';
import * as languageGlyph from './language-glyph';
import { SPLIT_SNAP_DURATION_MS } from './useWorkspaceSplit';

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: ({ children }: { children?: ReactNode }) => <div data-testid="graph-controls">{children}</div>,
  ControlButton: (props: ComponentProps<'button'>) => <button {...props} />,
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: ({
    nodes,
    edges,
    onNodeClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onEdgeClick,
    nodeTypes,
    ariaLabelConfig,
    children,
  }: {
    nodes: Node[];
    edges: Edge[];
    ariaLabelConfig?: Record<string, string>;
    onNodeClick?: (event: unknown, node: Node) => void;
    onNodeMouseEnter?: (event: unknown, node: Node) => void;
    onNodeMouseLeave?: (event: unknown, node: Node) => void;
    onEdgeClick?: (event: unknown, edge: Edge) => void;
    nodeTypes: Record<string, ComponentType<{ data: Node['data'] }>>;
    children?: ReactNode;
  }) => (
    <div data-testid="mock-flow" data-control-labels={JSON.stringify(ariaLabelConfig)} style={{ visibility: 'visible' }}>
      {nodes.map(node => {
        if (node.type === 'group') {
          const Group = nodeTypes.group;
          return <div key={node.id} data-testid="scope-frame" data-node-id={node.id}><Group data={node.data} /></div>;
        }
        return <div key={node.id}><button data-node-id={node.id} data-dimmed={String(Boolean(node.data.dimmed))} data-draggable={String(node.draggable !== false)} data-focused={String(Boolean(node.data.focused))} data-position={JSON.stringify(node.position)} onClick={event => onNodeClick?.(event, node)}
          onMouseEnter={() => onNodeMouseEnter?.({}, node)} onMouseLeave={() => onNodeMouseLeave?.({}, node)}>
          node:{node.type === 'layer'
            ? String((node.data as { layer: { name: string } }).layer.name)
            : String((node.data as { component: { name: string } }).component.name)}
        </button>{typeof node.data.onOverviewEnter === 'function' && <button onClick={() => (node.data.onOverviewEnter as () => void)()}>展开</button>}</div>;
      })}
      {edges.map(edge => (
        <button key={edge.id} onClick={() => onEdgeClick?.({}, edge)}>
          edge:{String(edge.label)}
        </button>
      ))}
      {children}
    </div>
  ),
  useNodesState: <T extends Node>(initial: T[]) => {
    const [nodes, setNodes] = useState(initial);
    return [nodes, setNodes, () => undefined] as const;
  },
  useEdgesState: <T extends Edge>(initial: T[]) => {
    const [edges, setEdges] = useState(initial);
    return [edges, setEdges, () => undefined] as const;
  },
}));

const evidence = {
  stable_id: 'fact:symbol:main.py:main.main',
  label: 'main.main',
  path: 'main.py',
  start_line: 4,
  end_line: 12,
  kind: 'function',
};

const snapshot: Snapshot = {
  snapshot_id: 'snapshot-1',
  summary: {
    file_count: 3,
    symbol_count: 8,
    call_count: 5,
    import_count: 2,
    inherit_count: 0,
    component_count: 2,
  },
  graph: {
    semantic_mode: 'provider_supported',
    nodes: [
      {
        id: 'component:entry',
        label: '入口编排',
        name: '入口编排',
        responsibility: '接收输入并调度领域服务。',
        grouping_rationale: '入口函数和路由共同负责请求编排。',
        architecture_layer_id: 'layer:entry',
        architecture_layer_name: '入口层',
        architecture_layer_candidates: [],
        architecture_layer_rationale: '成员全部位于入口模块。',
        architecture_layer_certainty: 'supported',
        members: [evidence],
        member_count: 1,
        evidence: [evidence],
        certainty: 'supported',
        review_status: 'unreviewed',
        source_report_ids: ['source:test'],
        fan_in: 0,
        fan_out: 1,
      },
      {
        id: 'component:domain',
        label: '领域服务',
        name: '领域服务',
        responsibility: '执行核心业务规则。',
        grouping_rationale: '这些成员共同处理同一领域对象。',
        architecture_layer_id: 'layer:domain',
        architecture_layer_name: '领域层',
        architecture_layer_candidates: [],
        architecture_layer_rationale: '成员位于领域模块。',
        architecture_layer_certainty: 'supported',
        members: [{ ...evidence, stable_id: 'fact:symbol:service.py:run', label: 'service.run', path: 'service.py' }],
        member_count: 1,
        evidence: [],
        certainty: 'supported',
        review_status: 'unreviewed',
        source_report_ids: ['source:test'],
        fan_in: 1,
        fan_out: 0,
      },
    ],
    edges: [
      {
        id: 'relation:entry-domain',
        source: 'component:entry',
        target: 'component:domain',
        relation_kind: 'invokes',
        label: '入口调用领域服务',
        description: '入口组件把已校验输入交给领域服务。',
        certainty: 'supported',
        evidence: [evidence],
        source_report_ids: ['source:test'],
        weight: 2,
      },
    ],
    layers: [
      {
        id: 'layer:entry',
        name: '入口层',
        responsibility: '接收外部输入。',
        component_ids: ['component:entry'],
        evidence: [evidence],
        certainty: 'supported',
        source_report_ids: ['source:test'],
      },
      {
        id: 'layer:domain',
        name: '领域层',
        responsibility: '执行核心业务规则。',
        component_ids: ['component:domain'],
        evidence: [],
        certainty: 'supported',
        source_report_ids: ['source:test'],
      },
    ],
    unassigned_component_ids: [],
  },
  value_points: [
    {
      stable_id: 'value:orchestration',
      kind: 'value_point',
      title: '入口与领域职责分离',
      claim: '入口只编排，领域服务执行规则。',
      problem: '避免接口层承载业务规则。',
      implementation: '用组件关系连接入口和领域服务。',
      tradeoffs: '需要维护清晰的输入契约。',
      transfer_conditions: '适用于 API、任务和事件入口。',
      certainty: 'supported',
      evidence: [evidence],
      connectivity: 4,
    },
  ],
  languages: [
    {
      language: 'python',
      quality_tier: 'verified',
      files_seen: 3,
      files_analyzed: 3,
      files_failed: 0,
      reason_codes: [],
    },
  ],
  learning_plan: {
    snapshot_id: 'snapshot-1',
    selected_value_point: 'value:orchestration',
    steps: [
      {
        step_id: 'step-1',
        order: 1,
        title: '先看入口编排',
        objective: '说明入口组件的输入、处理和输出。',
        evidence_refs: [evidence.stable_id],
        component_ids: ['component:entry'],
        completion_check: '能指出入口没有实现业务规则。',
      },
    ],
  },
};

const inferredSnapshot: Snapshot = {
  ...snapshot,
  graph: {
    ...snapshot.graph,
    semantic_mode: 'structural_candidate',
    nodes: snapshot.graph.nodes.map(node => ({
      ...node,
      certainty: 'inferred',
      architecture_layer_certainty: 'inferred',
    })),
    edges: snapshot.graph.edges.map(edge => ({ ...edge, certainty: 'inferred' })),
    layers: snapshot.graph.layers.map(layer => ({ ...layer, certainty: 'inferred' })),
  },
};

const project: Project = {
  project_id: 'project-1',
  title: 'demo',
  source: { kind: 'fixture', value: 'demo', commit_sha: null, display_name: 'demo' },
  created_at: '2026-08-12T00:00:00Z',
  updated_at: '2026-08-12T00:00:00Z',
  messages: [],
  analysis: {
    stage: 'done',
    snapshot_id: 'snapshot-1',
    file_count: 3,
    symbol_count: 8,
    call_count: 5,
    languages: ['python'],
    error: null,
    canonical_snapshot_key: null,
  },
  study: {
    phase: 'explaining',
    selected_value_point: 'value:orchestration',
    current_step: 0,
    total_steps: 1,
    mastered: [],
    misconceptions: [],
    open_questions: [],
    used_evidence: [],
  },
  model_override: null,
};

const projectedSnapshot: Snapshot = {
  ...snapshot,
  snapshot_id: 'snapshot-projection',
  graph: {
    ...snapshot.graph,
    nodes: snapshot.graph.nodes.map(node => ({
      ...node,
      entity_kind: 'component' as const,
      parent_entity_id: null,
      depth: 0,
    })),
    edges: [
      ...snapshot.graph.edges,
      {
        ...snapshot.graph.edges[0],
        id: 'relation:entry-domain-static',
        relation_kind: 'static_dependency',
        label: '静态依赖',
      },
    ],
    projections: {
      human: {
        kind: 'human',
        snapshot_id: 'snapshot-projection',
        nodes: snapshot.graph.nodes.map(node => ({
          projection_node_id: `human:entity:${node.id}`,
          entity_id: node.id,
          parent_projection_node_id: null,
          depth: 0,
          aggregate_member_entity_ids: [],
          evidence_ids: node.evidence.length ? [node.evidence[0].stable_id] : [],
          overlay_ids: [],
        })),
        edges: [{
          projection_edge_id: 'human:aggregate:entry-domain',
          relation_id: null,
          source_projection_node_id: 'human:entity:component:entry',
          target_projection_node_id: 'human:entity:component:domain',
          aggregate_relation_ids: ['relation:entry-domain', 'relation:entry-domain-static'],
          evidence_ids: [evidence.stable_id],
          overlay_ids: [],
        }],
        truncated: false,
        next_cursor: null,
        partial: false,
        omitted_entity_count: 0,
        omitted_relation_count: 0,
      },
      agent: {
        kind: 'agent',
        snapshot_id: 'snapshot-projection',
        nodes: [],
        edges: [],
        truncated: false,
        next_cursor: null,
      },
    },
  },
  value_points: snapshot.value_points.map(point => ({
    ...point,
    evidence: point.evidence.map(item => ({ ...item, source_id: 'component:entry' })),
  })),
  learning_plan: {
    ...snapshot.learning_plan,
    snapshot_id: 'snapshot-projection',
  },
};

function makeCanonicalSnapshot(): Snapshot {
  const entry = snapshot.graph.nodes[0];
  const domain = snapshot.graph.nodes[1];
  const entryHelper = {
    ...entry,
    id: 'component:entry-helper',
    label: '入口校验',
    name: '入口校验',
    responsibility: '校验入口请求并整理执行上下文。',
    members: [{ ...evidence, stable_id: 'fact:symbol:validate.py:request', label: 'validate.request', path: 'validate.py' }],
    evidence: [{ ...evidence, stable_id: 'fact:symbol:validate.py:request', label: 'validate.request', path: 'validate.py' }],
    fan_in: 1,
    fan_out: 1,
  };
  const domainHelper = {
    ...domain,
    id: 'component:domain-helper',
    label: '领域校验',
    name: '领域校验',
    responsibility: '校验领域规则并返回结构化结果。',
    members: [{ ...evidence, stable_id: 'fact:symbol:rules.py:check', label: 'rules.check', path: 'rules.py' }],
    evidence: [{ ...evidence, stable_id: 'fact:symbol:rules.py:check', label: 'rules.check', path: 'rules.py' }],
    fan_in: 1,
    fan_out: 1,
  };
  const componentRows = [entry, entryHelper, domain, domainHelper].map(component => ({
    ...component,
    entity_kind: 'component' as const,
    parent_entity_id: component.id.includes('entry') ? 'domain:entry-scope' : 'domain:domain-scope',
    depth: 3,
  }));
  const entryScope = {
    ...entry,
    id: 'domain:entry-scope',
    entity_kind: 'domain' as const,
    parent_entity_id: 'layer:entry',
    depth: 2,
    label: '入口请求职责',
    name: '入口请求职责',
    responsibility: '接收请求并准备执行上下文。',
    grouping_rationale: '入口编排与请求校验共同处理外部请求。',
    architecture_layer_id: 'layer:entry',
    architecture_layer_name: '入口层',
    member_count: 2,
    attributes: { component_ids: ['component:entry', 'component:entry-helper'] },
  };
  const domainScope = {
    ...domain,
    id: 'domain:domain-scope',
    entity_kind: 'domain' as const,
    parent_entity_id: 'layer:domain',
    depth: 2,
    label: '领域规则职责',
    name: '领域规则职责',
    responsibility: '执行并校验核心业务规则。',
    grouping_rationale: '领域服务与规则校验共同维护领域不变量。',
    architecture_layer_id: 'layer:domain',
    architecture_layer_name: '领域层',
    member_count: 2,
    attributes: { component_ids: ['component:domain', 'component:domain-helper'] },
  };
  return {
    ...snapshot,
    snapshot_id: 'snapshot-canonical-tree',
    graph: {
      ...snapshot.graph,
      nodes: [...componentRows, entryScope, domainScope],
      edges: [
        ...snapshot.graph.edges,
        {
          ...snapshot.graph.edges[0],
          id: 'relation:entry-helper',
          source: 'component:entry',
          target: 'component:entry-helper',
          label: '入口编排调用校验',
        },
        {
          ...snapshot.graph.edges[0],
          id: 'relation:domain-helper',
          source: 'component:domain',
          target: 'component:domain-helper',
          label: '领域服务调用规则校验',
        },
      ],
      layers: snapshot.graph.layers.map(layer => ({
        ...layer,
        component_ids: layer.id === 'layer:entry'
          ? ['component:entry', 'component:entry-helper']
          : ['component:domain', 'component:domain-helper'],
      })),
    },
    summary: { ...snapshot.summary, component_count: 4 },
  };
}

const canonicalSnapshot = makeCanonicalSnapshot();

function makeTwoFrameSnapshot(): Snapshot {
  const result = structuredClone(canonicalSnapshot);
  const template = result.graph.nodes.find(node => node.id === 'domain:domain-scope')!;
  for (const [key, name, layerId] of [
    ['sibling', '请求记录职责', 'layer:entry'],
    ['storage', '存储职责', 'layer:domain'],
    ['audit', '审计职责', 'layer:domain'],
  ]) {
    const componentIds = [`component:${key}`, `component:${key}-helper`];
    result.graph.nodes.push({
      ...template, id: `domain:${key}`, name, label: name, parent_entity_id: layerId,
      architecture_layer_id: layerId, attributes: { component_ids: componentIds },
    });
    result.graph.nodes.push(...componentIds.map((id, index) => ({
      ...result.graph.nodes[0], id, name: `${name}组件${index}`, label: `${name}组件${index}`,
      parent_entity_id: `domain:${key}`, architecture_layer_id: layerId,
    })));
    result.graph.layers.find(layer => layer.id === layerId)!.component_ids.push(...componentIds);
  }
  for (const [key, from, to] of [
    ['main-storage', 'entry', 'storage'],
    ['main-sibling', 'entry', 'sibling'],
    ['external-between', 'domain', 'storage'],
    ['external-extra', 'domain-helper', 'audit'],
    ['storage-inner', 'storage', 'storage-helper'],
    ['sibling-inner', 'sibling', 'sibling-helper'],
    ['closed-between', 'storage', 'audit'],
  ]) {
    result.graph.edges.push({
      ...result.graph.edges[0], id: `relation:${key}`, source: `component:${from}`, target: `component:${to}`,
    });
  }
  return result;
}

describe('component graph contract', () => {
  it('previews overview connections on hover and keeps them after a click without requiring hover', () => {
    render(<RepositoryWorkspace snapshot={snapshot} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    const entry = screen.getByRole('button', { name: 'node:入口编排' });
    expect(screen.queryByRole('button', { name: 'edge:1 条关系' })).not.toBeInTheDocument();
    fireEvent.mouseEnter(entry);
    expect(screen.getByRole('button', { name: 'edge:1 条关系' })).toBeInTheDocument();
    fireEvent.mouseLeave(entry);
    expect(screen.queryByRole('button', { name: 'edge:1 条关系' })).not.toBeInTheDocument();
    fireEvent.click(entry);
    fireEvent.mouseLeave(entry);
    expect(screen.getByRole('button', { name: 'edge:1 条关系' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    expect(screen.getByRole('button', { name: 'edge:入口调用领域服务' })).toBeInTheDocument();
  });

  it('keeps related overview cards clear and disables unrelated-card dimming when showing all connections', () => {
    const graph = structuredClone(snapshot);
    graph.graph.nodes.push({ ...graph.graph.nodes[0], id: 'component:isolated', name: '独立组件',
      label: '独立组件', architecture_layer_id: 'layer:isolated', architecture_layer_name: '独立层' });
    graph.graph.layers.push({ ...graph.graph.layers[0], id: 'layer:isolated', name: '独立层',
      component_ids: ['component:isolated'] });
    render(<RepositoryWorkspace snapshot={graph} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: "显示所有关系" });
    const entry = screen.getByRole('button', { name: 'node:入口编排' });
    const domain = screen.getByRole('button', { name: 'node:领域服务' });
    const isolated = screen.getByRole('button', { name: 'node:独立组件' });
    fireEvent.mouseEnter(entry);
    expect(domain).toHaveAttribute('data-dimmed', 'false');
    expect(isolated).toHaveAttribute('data-dimmed', 'true');
    fireEvent.mouseLeave(entry);
    expect(isolated).toHaveAttribute('data-dimmed', 'false');
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('data-focused', 'true');
    expect(domain).toHaveAttribute('data-dimmed', 'false');
    expect(isolated).toHaveAttribute('data-dimmed', 'true');
    expect(isolated).toHaveAttribute('data-draggable', 'false');
    expect(domain).toHaveAttribute('data-draggable', 'true');
    fireEvent.mouseEnter(isolated);
    expect(isolated).toHaveAttribute('data-draggable', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(isolated).toHaveAttribute('data-draggable', 'true');
    expect(entry).toHaveAttribute('data-focused', 'false');
    expect(domain).toHaveAttribute('data-dimmed', 'false');
    expect(isolated).toHaveAttribute('data-dimmed', 'false');
    fireEvent.mouseEnter(domain);
    expect(entry).toHaveAttribute('data-dimmed', 'false');
    expect(domain).toHaveAttribute('data-focused', 'false');
    expect(isolated).toHaveAttribute('data-dimmed', 'false');
    expect(screen.getByRole('button', { name: 'edge:1 条关系' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'edge:1 条关系' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开' })).not.toBeInTheDocument();
    fireEvent.click(domain);
    expect(entry).toHaveAttribute('data-dimmed', 'false');
    expect(isolated).toHaveAttribute('data-dimmed', 'true');
  });

  it('shows language guidance only for a different result language and updates it when the interface changes', () => {
    const view = render(<RepositoryWorkspace snapshot={{ ...snapshot, display_language: 'zh-CN' }} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    expect(view.container.querySelector('.snapshot-language-notice')).toBeNull();
    view.rerender(<RepositoryWorkspace snapshot={{ ...snapshot, display_language: 'en' }} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('可新建项目选择中文分析。');
    try {
      act(() => setUiLanguage('en'));
      expect(view.container.querySelector('.snapshot-language-notice')).toBeNull();
      view.rerender(<RepositoryWorkspace snapshot={{ ...snapshot, display_language: 'zh-CN' }} project={project}
        onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('Create a new project to choose analysis in English.');
    } finally {
      act(() => setUiLanguage('zh-CN'));
    }
  });

  it('previews the value point problem while keeping the full explanation in details', () => {
    const graph = structuredClone(snapshot);
    graph.value_points[0].problem = '避免请求处理和业务规则混在一起。';
    const view = render(<RepositoryWorkspace snapshot={graph} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '价值点' }));
    expect(view.container.querySelector('.value-point-card p')).toHaveTextContent(graph.value_points[0].problem);
    expect(screen.getByTestId('value-point-details')).toHaveTextContent(graph.value_points[0].claim);
    expect(Array.from(screen.getByTestId('value-point-details').querySelectorAll('h4')).slice(0, 2).map(node => node.textContent))
      .toEqual(['解决的问题', '核心思路']);
  });

  it('keeps graph navigation and each tab selection until the snapshot changes', () => {
    const graph = structuredClone(snapshot);
    graph.value_points.push({ ...graph.value_points[0], stable_id: 'value:second', title: '第二个学习点' });
    const selectionChange = vi.fn();
    const props = { project, onOpenEvidence: vi.fn(), onQueueTopic: vi.fn(), onSelectionChange: selectionChange };
    const view = render(<RepositoryWorkspace snapshot={graph} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'node:入口编排' }));
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    fireEvent.click(screen.getByRole('button', { name: 'node:领域服务' }));
    const canvas = screen.getByTestId('mock-flow');

    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    expect(canvas).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'node:领域服务' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /第二个学习点/ }));
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }));
    expect(screen.getByTestId('mock-flow')).toBe(canvas);
    expect(canvas).toBeVisible();
    expect(view.container.querySelector('.architecture-breadcrumb')).toHaveTextContent('入口层');
    expect(screen.getByTestId('component-details')).toHaveTextContent('领域服务');
    expect(selectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'component', stable_id: 'component:domain' }));

    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    expect(screen.getByTestId('value-point-details')).toHaveTextContent('第二个学习点');
    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    expect(screen.getByTestId('value-point-details')).toHaveTextContent('第二个学习点');
    view.rerender(<RepositoryWorkspace snapshot={{ ...graph, snapshot_id: 'new-snapshot' }} {...props} />);
    expect(screen.getByTestId('value-point-details')).not.toHaveTextContent('第二个学习点');
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }));
    expect(view.container.querySelector('.architecture-breadcrumb')).toHaveTextContent('架构总览');
    expect(screen.getByTestId('component-details')).toHaveTextContent('入口编排');
  });

  it('opens a singleton directly with its external relations and resets details only on a different component', () => {
    const { container } = render(<RepositoryWorkspace snapshot={snapshot} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    const clickNode = (name: string) => fireEvent.click(screen.getByRole('button', { name: `node:${name}` }));
    expect(screen.queryByRole('button', { name: 'node:入口层' })).not.toBeInTheDocument();
    clickNode('入口编排');
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    expect(screen.getByRole('button', { name: 'node:领域服务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edge:入口调用领域服务' })).toBeInTheDocument();
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(0);
    const details = screen.getByTestId('component-details');
    details.scrollTop = 150;
    clickNode('入口编排');
    expect(screen.getByTestId('component-details')).toBe(details);
    expect(details.scrollTop).toBe(150);
    clickNode('领域服务');
    expect(screen.getByTestId('component-details')).not.toBe(details);
    expect(screen.getByTestId('component-details').scrollTop).toBe(0);
    expect(container.querySelector('.architecture-breadcrumb')).toHaveTextContent('入口层');
    fireEvent.click(screen.getByRole('button', { name: "取消选中" }));
    expect(screen.getByRole('button', { name: 'edge:入口调用领域服务' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "收起相关组件" }));
    expect(container.querySelector('.architecture-breadcrumb')).toHaveTextContent('架构总览 · 2 个架构层');
  });

  it('lets a singleton subject open, replace and collapse one complete external frame', () => {
    const graph = makeTwoFrameSnapshot();
    const single = { ...snapshot.graph.nodes[0], id: 'component:single', name: '独立主组件',
      entity_kind: 'component' as const, parent_entity_id: null, architecture_layer_id: 'layer:single' };
    graph.graph.nodes.push(single);
    graph.graph.layers.push({ ...snapshot.graph.layers[0], id: 'layer:single', name: '单组件层', component_ids: [single.id] });
    for (const target of ['component:entry', 'component:domain']) {
      graph.graph.edges.push({ ...snapshot.graph.edges[0], id: `relation:single-${target}`, source: single.id, target });
    }
    const expansion = { activeComponentId: single.id, expandedExternalScopeId: 'domain:entry-scope' };
    const both = buildLayerScopeFlow(graph, 'layer:single', expansion);
    expect(both.nodes.filter(node => node.type === 'group').map(node => node.id)).toEqual(['frame:domain:entry-scope']);
    expect(both.nodes.find(node => node.id === single.id)?.type).toBe('component');
    expect(both.nodes.some(node => node.id === 'component:entry-helper')).toBe(true);
    const relationIds = both.edges.flatMap(edge => edge.data?.relationIds as string[]);
    expect(relationIds).toContain('relation:entry-helper');
    expect(relationIds).not.toContain('relation:closed-between');
    const focused = buildLayerScopeFlow(graph, 'layer:single', { ...expansion, focusComponentId: 'component:entry' });
    expect(focused.nodes.map(node => [node.id, node.position])).toEqual(both.nodes.map(node => [node.id, node.position]));
    expect(focused.edges.flatMap(edge => edge.data?.relationIds as string[]).sort()).toEqual([...relationIds].sort());
    const singleLink = focused.edges.find(edge => (edge.data?.relationIds as string[] | undefined)?.includes('relation:single-component:entry'));
    expect(singleLink).toMatchObject({ source: single.id, target: 'component:entry' });

    const { container } = render(<RepositoryWorkspace snapshot={graph} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    const clickNode = (name: string) => fireEvent.click(screen.getByRole('button', { name: `node:${name}` }));
    clickNode('独立主组件');
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    clickNode('入口请求职责');
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(1);
    clickNode('入口校验');
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(1);
    expect(container.querySelector('.architecture-breadcrumb')).toHaveTextContent('单组件层');
    clickNode('领域规则职责');
    expect(screen.getByTestId('scope-frame')).toHaveAttribute('data-node-id', 'frame:domain:domain-scope');
    fireEvent.click(screen.getByRole('button', { name: '收起分组：领域规则职责' }));
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'node:独立主组件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'node:入口请求职责' })).toBeInTheDocument();
  });

  it('switches between a direct local component and sibling scopes without retaining the old external frame', () => {
    const graph = makeTwoFrameSnapshot();
    const single = { ...snapshot.graph.nodes[0], id: 'component:direct', name: '直接组件',
      entity_kind: 'component' as const, parent_entity_id: 'layer:entry' };
    graph.graph.nodes.push(single);
    graph.graph.layers[0].component_ids.push(single.id);
    graph.graph.edges.push({ ...snapshot.graph.edges[0], id: 'relation:direct-domain', source: single.id });
    const { container } = render(<RepositoryWorkspace snapshot={graph} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    const clickNode = (name: string) => fireEvent.click(screen.getByRole('button', { name: `node:${name}` }));
    clickNode('入口层');
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    clickNode('直接组件');
    clickNode('领域规则职责');
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(1);
    clickNode('入口请求职责');
    expect(screen.getByTestId('scope-frame')).toHaveAttribute('data-node-id', 'frame:domain:entry-scope');
    expect(screen.queryByRole('button', { name: "收起相关组件" })).not.toBeInTheDocument();
    clickNode('领域规则职责');
    clickNode('直接组件');
    expect(screen.queryAllByTestId('scope-frame')).toHaveLength(0);
    expect(container.querySelector('.architecture-breadcrumb')).toHaveTextContent('入口层');
    fireEvent.click(screen.getByRole('button', { name: "收起相关组件" }));
    expect(screen.queryByRole('button', { name: 'node:领域规则职责' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'node:直接组件' })).toBeInTheDocument();
  });

  it('gives many external cards enough columns even when the main layer has one scope', () => {
    const graph = structuredClone(canonicalSnapshot);
    const scopeTemplate = graph.graph.nodes.find(node => node.id === 'domain:domain-scope')!;
    const componentTemplate = graph.graph.nodes.find(node => node.id === 'component:domain')!;
    for (let index = 0; index < 11; index += 1) {
      const scopeId = `domain:neighbor-${index}`;
      const componentIds = [`component:neighbor-${index}`, `component:neighbor-${index}-helper`];
      graph.graph.nodes.push({ ...scopeTemplate, id: scopeId, attributes: { component_ids: componentIds } });
      graph.graph.nodes.push(...componentIds.map(id => ({ ...componentTemplate, id, parent_entity_id: scopeId })));
      graph.graph.layers.find(layer => layer.id === 'layer:domain')!.component_ids.push(...componentIds);
      graph.graph.edges.push({
        ...graph.graph.edges[0], id: `relation:neighbor-${index}`,
        source: 'component:entry', target: componentIds[0],
      });
    }
    const flow = buildLayerScopeFlow(graph, 'layer:entry', { expandedScopeId: 'domain:entry-scope' });
    const externalCards = flow.nodes.filter(node => node.type === 'layer' && node.data.portal);
    expect(externalCards).toHaveLength(12);
    expect(new Set(externalCards.map(node => node.position.x)).size).toBe(4);
    expect(new Set(externalCards.map(node => node.position.y)).size).toBe(3);

    const expanded = buildLayerScopeFlow(graph, 'layer:entry', {
      expandedScopeId: 'domain:entry-scope', expandedExternalScopeId: 'domain:domain-scope',
    });
    for (const id of ['frame:domain:entry-scope', 'component:entry', 'component:entry-helper']) {
      expect(expanded.nodes.find(node => node.id === id)?.position)
        .toEqual(flow.nodes.find(node => node.id === id)?.position);
    }
  });

  it('keeps complete frames, stable focus geometry and only relations touching expanded scopes', () => {
    const graph = makeTwoFrameSnapshot();
    const expansion = { expandedScopeId: 'domain:entry-scope' };
    const primary = buildLayerScopeFlow(graph, 'layer:entry', expansion);
    const relationIds = (flow: typeof primary) => flow.edges.flatMap(edge => edge.data?.relationIds as string[]);
    expect(primary.nodes.filter(node => node.type === 'group')).toHaveLength(1);
    expect(primary.nodes.some(node => node.id === 'domain:sibling')).toBe(true);
    expect(primary.nodes.some(node => node.id === 'portal:domain:audit')).toBe(false);
    expect(relationIds(primary)).not.toContain('relation:external-between');

    const both = buildLayerScopeFlow(graph, 'layer:entry', { ...expansion, expandedExternalScopeId: 'domain:domain-scope' });
    expect(both.nodes.filter(node => node.type === 'group')).toHaveLength(2);
    const mainFrame = both.nodes.find(node => node.id === 'frame:domain:entry-scope')!;
    const externalFrame = both.nodes.find(node => node.id === 'frame:domain:domain-scope')!;
    expect(externalFrame.position.y).toBe(mainFrame.position.y);
    expect(externalFrame.position.x).toBeGreaterThan(mainFrame.position.x + mainFrame.width!);
    expect(mainFrame.position).toEqual(primary.nodes.find(node => node.id === mainFrame.id)!.position);
    expect(both.nodes.some(node => node.id === 'component:domain-helper')).toBe(true);
    expect(both.nodes.some(node => node.id === 'portal:domain:audit')).toBe(true);
    expect(relationIds(both)).toEqual(expect.arrayContaining([
      'relation:entry-helper', 'relation:domain-helper', 'relation:external-between', 'relation:external-extra',
    ]));
    expect(relationIds(both)).not.toContain('relation:closed-between');
    const geometry = (flow: typeof both) => flow.nodes.map(node => ({
      id: node.id, type: node.type, position: node.position, width: node.width, height: node.height,
    }));
    for (const focusComponentId of ['component:entry', 'component:domain', 'component:domain-helper']) {
      const focused = buildLayerScopeFlow(graph, 'layer:entry', {
        ...expansion, expandedExternalScopeId: 'domain:domain-scope', focusComponentId,
      });
      expect(geometry(focused)).toEqual(geometry(both));
      expect(relationIds(focused).sort()).toEqual(relationIds(both).sort());
      expect(focused.nodes.find(node => node.id === focusComponentId)?.data.focused).toBe(true);
      const incident = graph.graph.edges.filter(relation => relation.source === focusComponentId || relation.target === focusComponentId);
      for (const relation of incident) {
        const edge = focused.edges.find(item => (item.data?.relationIds as string[] | undefined)?.includes(relation.id));
        expect(edge?.style?.opacity).toBe(1);
        for (const endpoint of ['source', 'target'] as const) {
          if (focused.nodes.some(node => node.id === relation[endpoint] && node.type === 'component')) {
            expect(edge?.[endpoint]).toBe(relation[endpoint]);
          }
        }
        expect(edge?.source.startsWith('frame:')).toBe(false);
        expect(edge?.target.startsWith('frame:')).toBe(false);
      }
    }
    // A frame contains its members and never covers a sibling card or another frame.
    for (const frame of both.nodes.filter(node => node.type === 'group')) {
      for (const node of both.nodes.filter(node => node.id !== frame.id)) {
        const intersects = node.position.x < frame.position.x + frame.width!
          && node.position.x + node.width! > frame.position.x
          && node.position.y < frame.position.y + frame.height!
          && node.position.y + node.height! > frame.position.y;
        expect(intersects).toBe(node.type === 'component' && node.data.scopeId === frame.data.scopeId);
      }
    }
  });

  it('separates focused component links from other relationships sharing the same frame endpoints', () => {
    const graph = makeTwoFrameSnapshot();
    graph.graph.edges.push({ ...graph.graph.edges[0], id: 'relation:other-cross-frame', source: 'component:entry-helper', target: 'component:domain-helper' });
    const expansion = { expandedScopeId: 'domain:entry-scope', expandedExternalScopeId: 'domain:domain-scope' };
    const overview = buildLayerScopeFlow(graph, 'layer:entry', expansion);
    const focused = buildLayerScopeFlow(graph, 'layer:entry', { ...expansion, focusComponentId: 'component:entry' });
    const incidentIds = graph.graph.edges.filter(relation => relation.source === 'component:entry' || relation.target === 'component:entry').map(relation => relation.id).sort();
    const brightEdges = focused.edges.filter(edge => edge.style?.opacity === 1);
    expect(brightEdges.flatMap(edge => edge.data?.relationIds as string[]).sort()).toEqual(incidentIds);
    expect(brightEdges.every(edge => edge.source === 'component:entry' || edge.target === 'component:entry')).toBe(true);
    expect(focused.edges.find(edge => (edge.data?.relationIds as string[] | undefined)?.includes('relation:other-cross-frame'))?.style?.opacity).toBe(.08);
    expect(focused.nodes.map(node => [node.id, node.position])).toEqual(overview.nodes.map(node => [node.id, node.position]));
    const faded = focused.nodes.filter(node => node.type !== 'group' && node.data.dimmed);
    expect(faded.length).toBeGreaterThan(0);
    for (const node of faded) {
      expect(node.draggable).toBe(false);
    }
    // Existing fixed portal nodes stay fixed; ordinary cards become movable again without focus.
    expect(faded.some(node => overview.nodes.find(item => item.id === node.id)?.draggable !== false)).toBe(true);
    const collapsed = buildLayerScopeFlow(graph, 'layer:entry', { expandedScopeId: expansion.expandedScopeId, focusComponentId: 'component:entry' });
    expect(collapsed.edges.find(edge => (edge.data?.relationIds as string[] | undefined)?.includes('relation:entry-domain')))
      .toMatchObject({ source: 'component:entry', target: 'portal:domain:domain-scope' });
    expect(buildLayerScopeFlow(graph, 'layer:entry', expansion).edges).toEqual(overview.edges);
  });

  it('switches and collapses the two frames in place while component clicks preserve both', () => {
    const { container } = render(<RepositoryWorkspace
      snapshot={makeTwoFrameSnapshot()} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()}
    />);
    const clickNode = (name: string) => fireEvent.click(screen.getByRole('button', { name: `node:${name}` }));
    const frameIds = () => screen.queryAllByTestId('scope-frame').map(frame => frame.getAttribute('data-node-id'));
    const positions = () => [...container.querySelectorAll('[data-position]')]
      .map(node => [node.getAttribute('data-node-id'), node.getAttribute('data-position')]);
    clickNode('入口层');
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    clickNode('入口请求职责');
    expect(frameIds()).toEqual(['frame:domain:entry-scope']);
    clickNode('领域规则职责');
    // Its expansion moves another scope into the pointer's old position.
    fireEvent.click(screen.getByRole('button', { name: 'node:存储职责' }), { detail: 2 });
    expect(frameIds()).toContain('frame:domain:domain-scope');
    expect(frameIds()).toHaveLength(2);
    const beforeFocus = positions();
    clickNode('入口编排');
    clickNode('领域校验');
    expect(frameIds()).toHaveLength(2);
    expect(positions()).toEqual(beforeFocus);
    expect(container.querySelector('.architecture-breadcrumb')).toHaveTextContent('入口层');
    expect(container.querySelector('.architecture-breadcrumb')).not.toHaveTextContent('领域规则职责');
    fireEvent.click(screen.getByRole('button', { name: "取消选中" }));
    expect(frameIds()).toHaveLength(2);
    expect(positions()).toEqual(beforeFocus);
    expect([...container.querySelectorAll('.group-node')].map(node => node.textContent)).toEqual(['', '']);

    clickNode('存储职责');
    expect(frameIds()).toEqual(['frame:domain:entry-scope', 'frame:domain:storage']);
    expect(screen.getByRole('button', { name: 'node:领域规则职责' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起分组：存储职责' }));
    expect(frameIds()).toEqual(['frame:domain:entry-scope']);
    clickNode('领域规则职责');
    clickNode('请求记录职责');
    expect(frameIds()).toEqual(['frame:domain:sibling']);
    expect(screen.queryByRole('button', { name: 'node:领域规则职责' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'node:入口请求职责' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起分组：请求记录职责' }));
    expect(frameIds()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'node:请求记录职责' })).toBeInTheDocument();
  });

  it('lays out every semantic component and relation with finite positions', () => {
    const flow = buildComponentFlow(snapshot);

    expect(flow.nodes).toHaveLength(snapshot.graph.nodes.length);
    expect(flow.edges).toHaveLength(snapshot.graph.edges.length);
    expect(new Set(flow.nodes.map(node => node.id)).size).toBe(flow.nodes.length);
    expect(flow.nodes.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
    expect(flow.edges[0]).toMatchObject({
      source: 'component:entry',
      target: 'component:domain',
      label: '入口调用领域服务',
    });
  });

  it('aggregates parallel component relations into one visual edge', () => {
    const parallelSnapshot: Snapshot = {
      ...snapshot,
      graph: {
        ...snapshot.graph,
        edges: [
          snapshot.graph.edges[0],
          {
            ...snapshot.graph.edges[0],
            id: 'relation:entry-domain-static',
            relation_kind: 'static_dependency',
            label: '静态依赖',
          },
        ],
      },
    };

    const flow = buildComponentFlow(parallelSnapshot);
    expect(flow.edges).toHaveLength(1);
    expect(Number((flow.edges[0].data as { lane: number }).lane)).toBe(0);
    expect((flow.edges[0].data as { relationIds: string[] }).relationIds)
      .toEqual(['relation:entry-domain', 'relation:entry-domain-static']);
    expect(flow.edges[0].label).toBe('2 条关系');
    expect(flow.edges.every(edge => edge.type === 'relation')).toBe(true);
  });

  it('keeps dense component graphs compact and bounded for the canvas', () => {
    const nodes = Array.from({ length: 24 }, (_, index) => ({
      ...snapshot.graph.nodes[index % snapshot.graph.nodes.length],
      id: `component:dense-${index}`,
      name: `组件 ${index}`,
      architecture_layer_id: index < 12 ? 'layer:entry' : 'layer:domain',
      fan_in: 4,
      fan_out: 4,
    }));
    const edges = Array.from({ length: 600 }, (_, index) => ({
      ...snapshot.graph.edges[0],
      id: `relation:dense-${index}`,
      source: nodes[index % nodes.length].id,
      target: nodes[(index * 7 + 3) % nodes.length].id,
      weight: 1,
    })).filter(edge => edge.source !== edge.target);
    const denseSnapshot: Snapshot = {
      ...snapshot,
      snapshot_id: 'snapshot-dense',
      graph: { ...snapshot.graph, nodes, edges },
    };

    const flow = buildComponentFlow(denseSnapshot);
    const maxX = Math.max(...flow.nodes.map(node => node.position.x));
    const maxY = Math.max(...flow.nodes.map(node => node.position.y));
    expect(flow.nodes).toHaveLength(nodes.length);
    expect(flow.edges.length).toBeLessThanOrEqual(160);
    expect(flow.omittedEdgeCount).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(3_000);
    expect(maxY).toBeLessThan(3_000);
  });

  it('bounds dense responsibility-scope edges while preserving the full graph in the snapshot', () => {
    const nodes = Array.from({ length: 24 }, (_, index) => ({
      ...snapshot.graph.nodes[index % snapshot.graph.nodes.length],
      id: `component:layer-dense-${index}`,
      name: `层内组件 ${index}`,
      architecture_layer_id: index < 12 ? 'layer:entry' : 'layer:domain',
      members: [{ ...evidence, stable_id: `fact:layer-dense-${index}`, path: `src/file-${index}.ts` }],
      evidence: [{ ...evidence, stable_id: `fact:layer-dense-${index}`, path: `src/file-${index}.ts` }],
      fan_in: 8,
      fan_out: 8,
    }));
    const edges = Array.from({ length: 700 }, (_, index) => {
      const offset = index < 350 ? 0 : 12;
      const source = nodes[offset + (index % 12)];
      const target = nodes[offset + ((index * 5 + 1) % 12)];
      return {
        ...snapshot.graph.edges[0],
        id: `relation:layer-dense-${index}`,
        source: source.id,
        target: target.id,
        weight: 1,
      };
    }).filter(edge => edge.source !== edge.target);
    const denseSnapshot: Snapshot = {
      ...snapshot,
      snapshot_id: 'snapshot-layer-dense',
      graph: {
        ...snapshot.graph,
        nodes,
        edges,
        layers: snapshot.graph.layers.map(layer => ({
          ...layer,
          component_ids: layer.id === 'layer:entry'
            ? nodes.slice(0, 12).map(node => node.id)
            : nodes.slice(12).map(node => node.id),
        })),
      },
    };

    const [scope] = getArchitectureScopes(denseSnapshot, 'layer:entry');
    const flow = buildLayerScopeFlow(denseSnapshot, 'layer:entry', { expandedScopeId: scope.id });
    expect(flow.edges.length).toBeGreaterThan(0);
    expect(flow.omittedEdgeCount).toBe(0);
    const visibleRelations = denseSnapshot.graph.edges.filter(edge => edge.source.startsWith('component:layer-dense-')
      && edge.target.startsWith('component:layer-dense-')
      && Number(edge.source.slice('component:layer-dense-'.length)) < 12
      && Number(edge.target.slice('component:layer-dense-'.length)) < 12);
    expect(flow.edges.flatMap(edge => (edge.data as { relationIds?: string[] }).relationIds ?? []))
      .toHaveLength(visibleRelations.length);
  });

  it('assigns snapshots without semantic layers to a named support layer', () => {
    const noLayerSnapshot: Snapshot = {
      ...snapshot,
      snapshot_id: 'snapshot-no-layers',
      graph: {
        ...snapshot.graph,
        layers: [],
        nodes: snapshot.graph.nodes.map(node => ({
          ...node,
          architecture_layer_id: null,
          architecture_layer_name: null,
          architecture_layer_rationale: null,
        })),
      },
    };

    const overview = buildLayerOverviewFlow(noLayerSnapshot);
    expect(overview.nodes).toHaveLength(1);
    expect(overview.nodes[0]?.data).toMatchObject({ layer: {
      name: "基础组件", component_ids: ['component:entry', 'component:domain'],
    } });
    expect(getArchitectureLayers(noLayerSnapshot).flatMap(layer => layer.component_ids).sort())
      .toEqual(['component:domain', 'component:entry']);
    expect(buildLayerScopeFlow(noLayerSnapshot, 'layer:shared-support').nodes).toHaveLength(2);
  });

  it('expands complete scopes without replacing the active layer on external focus', () => {
    const overview = buildLayerOverviewFlow(snapshot);
    expect(overview.nodes.map(node => node.id)).toEqual(['component:entry', 'component:domain']);
    expect(overview.nodes.every(node => node.type === 'component')).toBe(true);
    expect(overview.edges[0]).toMatchObject({ source: 'component:entry', target: 'component:domain' });
    expect(overview.edges).toHaveLength(1);
    expect(overview.edges[0]?.label).toBe('1 条关系');

    const entryScope = getArchitectureScopes(canonicalSnapshot, 'layer:entry')[0];
    const domainScope = getArchitectureScopes(canonicalSnapshot, 'layer:domain')[0];
    const layer = buildLayerScopeFlow(canonicalSnapshot, 'layer:entry');
    expect(layer.nodes.map(node => node.id)).toEqual([entryScope.id]);

    const scope = buildLayerScopeFlow(canonicalSnapshot, 'layer:entry', { expandedScopeId: entryScope.id });
    expect(scope.nodes.some(node => node.id === 'component:entry')).toBe(true);
    expect(scope.nodes.find(node => node.id === `portal:${domainScope.id}`)?.data)
      .toMatchObject({
        portal: true,
        targetScopeId: domainScope.id,
        relatedComponentCount: 1,
      });
    expect(scope.edges.find(edge => edge.target === `portal:${domainScope.id}`)?.data)
      .toMatchObject({ portal: true, relationIds: ['relation:entry-domain'] });

    const focused = buildLayerScopeFlow(canonicalSnapshot, 'layer:entry', { expandedScopeId: entryScope.id, focusComponentId: 'component:entry' });
    expect(focused.nodes.some(node => node.id === 'component:domain')).toBe(false);
    expect(focused.nodes.find(node => node.id === `portal:${domainScope.id}`)?.data)
      .toMatchObject({ relatedComponentCount: 1 });

    const enteredExternalScope = buildLayerScopeFlow(
      canonicalSnapshot,
      'layer:entry',
      { expandedScopeId: entryScope.id, expandedExternalScopeId: domainScope.id, focusComponentId: 'component:domain' },
    );
    expect(enteredExternalScope.nodes.find(node => node.id === 'component:domain')?.data)
      .toMatchObject({ external: true, focused: true });
    expect(enteredExternalScope.nodes.find(node => node.id === 'component:entry')?.data)
      .toMatchObject({ external: false, dimmed: false });
    expect(enteredExternalScope.nodes.some(node => node.id === `portal:${entryScope.id}`)).toBe(false);
    expect(enteredExternalScope.nodes.some(node => node.id === 'component:domain-helper')).toBe(true);
    expect(enteredExternalScope.edges.find(edge => edge.source === 'component:entry' && edge.target === 'component:domain')?.style)
      .toMatchObject({ stroke: 'var(--accent)' });
  });

  it('uses the human projection and maps projected clicks to canonical entities and evidence', () => {
    const flow = buildHumanProjectionFlow(projectedSnapshot);
    expect(flow).not.toBeNull();
    expect(flow?.nodes.map(node => node.id)).toEqual([
      'human:entity:component:entry',
      'human:entity:component:domain',
    ]);
    expect(flow?.edges[0]?.data).toMatchObject({
      aggregate: true,
      relationIds: ['relation:entry-domain', 'relation:entry-domain-static'],
      evidenceIds: [evidence.stable_id],
    });

    const selectionChange = vi.fn();
    render(
      <RepositoryWorkspace
        snapshot={projectedSnapshot}
        project={project}
        onOpenEvidence={vi.fn()}
        onQueueTopic={vi.fn()}
        onSelectionChange={selectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "显示所有关系" }));
    fireEvent.click(screen.getByRole('button', { name: 'edge:2 条关系' }));
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-projection',
      kind: 'relation',
      stable_id: 'relation:entry-domain',
      label: '入口调用领域服务',
      entity_id: 'component:entry',
      evidence_id: evidence.stable_id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'node:入口编排' }));
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-projection',
      kind: 'component',
      stable_id: 'component:entry',
      label: '入口编排',
      entity_id: 'component:entry',
      evidence_id: evidence.stable_id,
    });

    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    fireEvent.click(screen.getByRole('button', { name: /入口与领域职责分离/ }));
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-projection',
      kind: 'value_point',
      stable_id: 'value:orchestration',
      label: '入口与领域职责分离',
      entity_id: 'component:entry',
      evidence_id: evidence.stable_id,
    });

    fireEvent.click(screen.getByRole('tab', { name: /学习路线/ }));
    fireEvent.click(screen.getByRole('button', { name: /先看入口编排/ }));
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-projection',
      kind: 'learning_step',
      stable_id: 'step-1',
      label: '先看入口编排',
      entity_id: 'component:entry',
      evidence_id: evidence.stable_id,
    });
  });

  it('lays external singleton components out as a grid instead of wrapping them', () => {
    const externalNodes = Array.from({ length: 6 }, (_, index) => ({
      ...snapshot.graph.nodes[1],
      id: `component:external-${index}`,
      entity_kind: 'component' as const,
      name: `外部组件 ${index}`,
      architecture_layer_id: `layer:external-${index}`,
      architecture_layer_name: `外部层 ${index}`,
    }));
    const externalLayers = externalNodes.map((node, index) => ({
      ...snapshot.graph.layers[1],
      id: `layer:external-${index}`,
      name: `外部层 ${index}`,
      component_ids: [node.id],
    }));
    const multiLayerSnapshot: Snapshot = {
      ...canonicalSnapshot,
      snapshot_id: 'snapshot-many-external-layers',
      graph: {
        ...canonicalSnapshot.graph,
        nodes: [...canonicalSnapshot.graph.nodes, ...externalNodes],
        layers: [canonicalSnapshot.graph.layers[0], ...externalLayers],
        edges: externalNodes.map((node, index) => ({
          ...snapshot.graph.edges[0],
          id: `relation:external-${index}`,
          target: node.id,
        })),
      },
    };

    const entryScope = getArchitectureScopes(multiLayerSnapshot, 'layer:entry')[0];
    const scope = buildLayerScopeFlow(multiLayerSnapshot, 'layer:entry', { expandedScopeId: entryScope.id });
    const externalComponents = scope.nodes.filter(node => node.type === 'component' && node.data.external);
    expect(externalComponents).toHaveLength(6);
    expect(new Set(externalComponents.map(node => node.position.x)).size).toBeGreaterThan(1);
    expect(scope.nodes.some(node => node.type === 'layer' && node.data.portal)).toBe(false);
  });

  it('does not expose structural-candidate implementation details to users', () => {
    render(
      <RepositoryWorkspace
        snapshot={inferredSnapshot}
        project={project}
        onOpenEvidence={vi.fn()}
        onQueueTopic={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/结构候选/)).not.toBeInTheDocument();
    expect(screen.queryByText(/语义 Provider/)).not.toBeInTheDocument();
    expect(screen.queryByText('静态推断')).not.toBeInTheDocument();
  });

  it('links graph, value points, learning steps, evidence, and topic prompts', () => {
    const openEvidence = vi.fn();
    const queueTopic = vi.fn();
    const selectionChange = vi.fn();
    render(
      <RepositoryWorkspace
        snapshot={snapshot}
        project={project}
        onOpenEvidence={openEvidence}
        onQueueTopic={queueTopic}
        onSelectionChange={selectionChange}
      />,
    );

    expect(screen.getByTestId('component-details')).toHaveTextContent('入口编排');
    fireEvent.click(screen.getByRole('button', { name: 'node:领域服务' }));
    fireEvent.click(screen.getByRole('button', { name: "展开" }));
    expect(screen.getByTestId('component-details')).toHaveTextContent('执行核心业务规则');
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-1',
      kind: 'component',
      stable_id: 'component:domain',
      label: '领域服务',
    });

    fireEvent.click(screen.getByRole('button', { name: /架构总览/ }));
    fireEvent.click(screen.getByRole('button', { name: "显示所有关系" }));
    fireEvent.click(screen.getByRole('button', { name: 'edge:1 条关系' }));
    expect(screen.getByTestId('relation-details')).toHaveTextContent('入口组件把已校验输入交给领域服务');
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-1',
      kind: 'relation',
      stable_id: 'relation:entry-domain',
      label: '入口调用领域服务',
    });

    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    fireEvent.click(screen.getByRole('button', { name: /入口与领域职责分离/ }));
    expect(screen.getByTestId('value-point-details')).toHaveTextContent('避免接口层承载业务规则');
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-1',
      kind: 'value_point',
      stable_id: 'value:orchestration',
      label: '入口与领域职责分离',
    });
    fireEvent.click(screen.getByRole('button', { name: "就问这个" }));
    expect(queueTopic).toHaveBeenCalledWith({
      kind: 'value-point',
      stableId: 'value:orchestration',
      prompt: expect.stringContaining('入口与领域职责分离'),
    });

    fireEvent.click(screen.getByRole('button', { name: /main\.main/ }));
    expect(openEvidence).toHaveBeenCalledWith(expect.objectContaining({ path: 'main.py', start_line: 4 }));

    fireEvent.click(screen.getByRole('tab', { name: /学习路线/ }));
    fireEvent.click(screen.getByRole('button', { name: /先看入口编排/ }));
    expect(screen.getByTestId('learning-step-details')).toHaveTextContent('能指出入口没有实现业务规则');
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-1',
      kind: 'learning_step',
      stable_id: 'step-1',
      label: '先看入口编排',
    });
  });

  it('renders inline file mentions in component and value-point details', () => {
    const openEvidence = vi.fn();
    const richSnapshot: Snapshot = {
      ...snapshot,
      graph: {
        ...snapshot.graph,
        nodes: snapshot.graph.nodes.map((node, index) => index === 0
          ? { ...node, responsibility: '读取 devcontainer.json 后调用 main.py:4。' }
          : node),
      },
      value_points: snapshot.value_points.map(point => ({
        ...point,
        claim: '通过 main.py:4 说明入口与领域职责分离。',
      })),
    };
    render(
      <RepositoryWorkspace
        snapshot={richSnapshot}
        project={project}
        onOpenEvidence={openEvidence}
        onQueueTopic={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.getByText('devcontainer.json').closest('.markdown-file-reference-label'))
      .not.toBeNull();
    expect(screen.getByRole('button', { name: '打开源码 main.py:4' })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    fireEvent.click(screen.getByRole('button', { name: /入口与领域职责分离/ }));
    expect(screen.getByTestId('value-point-details'))
      .toHaveTextContent('通过 main.py:4 说明入口与领域职责分离。');
    expect(screen.getByRole('button', { name: '打开源码 main.py:4' })).toBeVisible();
  });

  it('refreshes selected and saved details from a same-id language variant', () => {
    const selectionChange = vi.fn();
    const props = { project, onOpenEvidence: vi.fn(), onQueueTopic: vi.fn(), onSelectionChange: selectionChange };
    const view = render(<RepositoryWorkspace {...props} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole('button', { name: "显示所有关系" }));
    fireEvent.click(screen.getByRole('button', { name: 'edge:1 条关系' }));
    fireEvent.click(screen.getByRole('tab', { name: /价值点/ }));
    const english: Snapshot = { ...snapshot, display_language: 'en',
      graph: { ...snapshot.graph, edges: snapshot.graph.edges.map(e => ({ ...e, label: 'Calls the domain service', description: 'Translated relation details' })) },
      value_points: snapshot.value_points.map(v => ({ ...v, title: 'Separate entry and domain', claim: 'Translated value details' })),
    };
    view.rerender(<RepositoryWorkspace {...props} snapshot={english} />);
    expect(screen.getByTestId('value-point-details')).toHaveTextContent('Translated value details');
    fireEvent.click(screen.getByRole('tab', { name: /架构图/ }));
    expect(screen.getByTestId('relation-details')).toHaveTextContent('Translated relation details');
    expect(selectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ stable_id: 'relation:entry-domain', label: 'Calls the domain service' }));
    expect(screen.getByRole('status')).toHaveTextContent('暂无中文分析结果，当前展示英文');
  });

  it('localizes application-owned repository details without changing snapshot text', () => {
    const responsibility = '承载当前 commit 的全部架构层、职责范围和组件。';
    const rootSnapshot: Snapshot = { ...snapshot, graph: { ...snapshot.graph,
      nodes: snapshot.graph.nodes.map((node, index) => index === 0 ? {
        ...node, entity_kind: 'repository', responsibility,
        grouping_rationale: '仓库是当前分析快照的唯一主层级根节点。',
      } : node),
    } };
    render(<RepositoryWorkspace snapshot={rootSnapshot} project={project}
      onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
    try {
      act(() => setUiLanguage('en'));
      expect(screen.getByTestId('component-details')).not.toHaveTextContent('Contains all architecture layers');
      expect(screen.getByTestId('component-details')).not.toHaveTextContent('The repository is the root');
      expect(screen.getByTestId('component-details')).toHaveTextContent('Related code');
      expect(screen.getByTestId('component-details').querySelector('.certainty')).toBeNull();
      expect(rootSnapshot.graph.nodes[0].responsibility).toBe(responsibility);
    } finally {
      act(() => setUiLanguage('zh-CN'));
    }
  });

  it('preserves a valid relation selection when the same snapshot reloads', () => {
    const selectionChange = vi.fn();
    const view = render(
      <RepositoryWorkspace
        snapshot={snapshot}
        project={project}
        onOpenEvidence={vi.fn()}
        onQueueTopic={vi.fn()}
        onSelectionChange={selectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "显示所有关系" }));
    fireEvent.click(screen.getByRole('button', { name: 'edge:1 条关系' }));
    expect(screen.getByTestId('relation-details')).toBeVisible();

    view.rerender(
      <RepositoryWorkspace
        snapshot={{ ...snapshot, graph: { ...snapshot.graph } }}
        project={project}
        onOpenEvidence={vi.fn()}
        onQueueTopic={vi.fn()}
        onSelectionChange={selectionChange}
      />,
    );

    expect(screen.getByTestId('relation-details')).toBeVisible();
    expect(selectionChange).toHaveBeenLastCalledWith({
      snapshot_id: 'snapshot-1',
      kind: 'relation',
      stable_id: 'relation:entry-domain',
      label: '入口调用领域服务',
    });
  });
});

it('keeps only the minimap extension and restores via the divider without remounting content', () => {
  // Drive the animation explicitly so worker contention cannot expire a wall-clock wait.
  let now = 0, nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const animation = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  const cancellation = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const original = window.getComputedStyle;
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const result = original(element, pseudo);
    if (element.classList.contains('workspace-body')) result.setProperty('--workspace-stacked', '1');
    return result;
  });
  const bounds = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x:0, y:0, left:0, top:0, right:600, bottom:1000, width:600, height:1000, toJSON: () => ({}) });
  const view = render(<RepositoryWorkspace snapshot={snapshot} project={project}
    onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
  try {
    const graph = screen.getByTestId('mock-flow'), details = screen.getByTestId('component-details');
    // JSDOM does not evaluate @container visibility; assert the mounted control/state, not a browser layout.
    const bar = view.container.querySelector<HTMLDivElement>('.workspace-divider')!;
    expect(view.container.querySelector('.workspace-body')).toHaveClass('has-workspace-split');
    expect(bar).not.toHaveAttribute('hidden');
    const controls = screen.getByTestId('graph-controls');
    expect(controls.lastElementChild).toHaveAttribute('aria-label', '小地图');
    expect(screen.queryByRole('button', { name: '恢复初始上下比例' })).not.toBeInTheDocument();
    const evidenceRenders = vi.spyOn(languageGlyph, 'languageFromPath');
    fireEvent.keyDown(bar, { key: 'End' });
    act(() => {
      now = SPLIT_SNAP_DURATION_MS;
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(now));
    });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(details.parentElement).toHaveAttribute('inert');
    expect(details.parentElement).toHaveAttribute('aria-hidden', 'true');
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(evidenceRenders).not.toHaveBeenCalled();
    evidenceRenders.mockRestore();
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(details.parentElement).not.toHaveAttribute('inert');
    expect(screen.getByTestId('mock-flow')).toBe(graph);
    expect(screen.getByTestId('component-details')).toBe(details);
  } finally {
    view.unmount(); styles.mockRestore(); bounds.mockRestore();
    animation.mockRestore(); cancellation.mockRestore(); clock.mockRestore();
  }
});
it('updates built-in graph control labels and memoized details with the interface language', () => {
  const view = render(<RepositoryWorkspace snapshot={snapshot} project={project}
    onOpenEvidence={vi.fn()} onQueueTopic={vi.fn()} onSelectionChange={vi.fn()} />);
  const labels = () => JSON.parse(screen.getByTestId('mock-flow').getAttribute('data-control-labels')!);
  try {
    expect(labels()).toMatchObject({ 'controls.zoomIn.ariaLabel': '放大', 'controls.zoomOut.ariaLabel': '缩小', 'controls.fitView.ariaLabel': '适应视图' });
    expect(screen.getByTestId('component-details')).toHaveTextContent('相关代码');
    act(() => setUiLanguage('en'));
    expect(labels()).toMatchObject({ 'controls.zoomIn.ariaLabel': 'Zoom in', 'controls.zoomOut.ariaLabel': 'Zoom out', 'controls.fitView.ariaLabel': 'Fit view' });
    expect(screen.getByTestId('component-details')).not.toHaveTextContent('相关代码');
    act(() => setUiLanguage('zh-CN'));
    expect(labels()['controls.zoomIn.ariaLabel']).toBe('放大');
    expect(screen.getByTestId('component-details')).toHaveTextContent('相关代码');
  } finally { view.unmount(); act(() => setUiLanguage('zh-CN')); }
});
