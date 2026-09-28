import { WorkspaceEvidenceList as EvidenceList } from './WorkspaceEvidenceList';
import { usePhoneDevice } from './usePhoneDevice';
import { t, translateFor, useUiLanguage } from './ui-language';
import { memo, useId, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  Controls,
  ControlButton,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type EdgeMouseHandler,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import BookOpenCheck from '@sketchyicons/react/icons/book-open-check';
import Braces from '@sketchyicons/react/icons/braces';
import ChevronLeft from '@sketchyicons/react/icons/chevron-left';
import Minimize2 from '@sketchyicons/react/icons/minimize-2';
import CheckCircle2 from '@sketchyicons/react/icons/circle-check';
import Focus from '@sketchyicons/react/icons/focus';
import Layers3 from '@sketchyicons/react/icons/layers';
import MapIcon from '@sketchyicons/react/icons/map';
import Link2 from '@sketchyicons/react/icons/link-2';
import MessageSquarePlus from '@sketchyicons/react/icons/message-square-plus';
import Route from '@sketchyicons/react/icons/route';
import './workspace-split.css';
import { useWorkspaceSplit } from './useWorkspaceSplit';
import { apiClient } from './api';
import { SplitGripIcon } from './WorkspaceSplitIcons';
import { InkOutline } from './InkOutline';
import { FieldIllustration } from './FieldIllustration';
import { Ink } from './field-ink';
import type {
  ConversationSelection,
  GraphEdge,
  GraphEvidence,
  GraphNode,
  LearningStep,
  Project,
  Snapshot,
  ValuePoint,
} from './types';
import { LanguageGlyph, hasLanguageGlyph, languageFromPath } from './language-glyph';
import {
  buildLayerOverviewFlow,
  buildLayerScopeFlow,
  getArchitectureLayers,
  handleSides,
  type ArchitectureFlowNode,
  type ComponentFlowNode,
  type ComponentNodeData,
  type GroupFlowNode,
  type GroupNodeData,
  type LayerFlowNode,
  type LayerNodeData,
} from './component-flow';

type WorkspaceTab = 'architecture' | 'value-points' | 'learning-plan';
type SelectedItem =
  | { kind: 'component'; value: GraphNode; entityId?: string | null; evidenceId?: string | null }
  | { kind: 'relation'; value: GraphEdge; entityId?: string | null; evidenceId?: string | null }
  | { kind: 'value-point'; value: ValuePoint }
  | { kind: 'learning-step'; value: LearningStep };

function firstTabSelection(snapshot: Snapshot, tab: WorkspaceTab, project?: Project): SelectedItem | null {
  // The architecture view starts with nothing picked: the details panel waits for a component or relation the
  // learner clicks, instead of describing the whole repository, which is never drawn as a node of its own.
  if (tab === 'architecture') return null;
  if (tab === 'value-points' && snapshot.value_points[0]) return { kind: 'value-point', value: snapshot.value_points[0] };
  if (tab === 'learning-plan') {
    // The route shown is the learner's own when one was generated; open on the step they are at.
    const plan = project?.study.dynamic_learning_plan?.length ? project.study.dynamic_learning_plan : snapshot.learning_plan.steps;
    const step = plan[Math.min(project?.study.current_step ?? 0, plan.length - 1)] ?? plan[0];
    return step ? { kind: 'learning-step', value: step } : null;
  }
  return null;
}

export { LanguageGlyph } from './language-glyph';

function projectionSelectionEnabled(snapshot: Snapshot, snapshotId: string): boolean {
  return snapshot.graph.projections?.human?.snapshot_id === snapshotId
    || snapshot.graph.projections?.agent?.snapshot_id === snapshotId;
}

function firstEvidenceId(item: SelectedItem): string | null {
  if (item.kind === 'component' || item.kind === 'relation') {
    return item.evidenceId ?? item.value.evidence[0]?.stable_id ?? null;
  }
  if (item.kind === 'value-point') return item.value.evidence[0]?.stable_id ?? null;
  return item.value.evidence_refs[0] ?? null;
}

function firstEntityId(item: SelectedItem): string | null {
  if (item.kind === 'component') return item.entityId ?? item.value.id;
  if (item.kind === 'relation') return item.entityId ?? item.value.source ?? null;
  if (item.kind === 'value-point') {
    const evidence = item.value.evidence[0];
    return evidence?.source_id ?? evidence?.target_id ?? null;
  }
  return item.value.component_ids[0] ?? null;
}

function conversationSelection(item: SelectedItem, snapshot: Snapshot): ConversationSelection {
  const snapshotId = snapshot.snapshot_id;
  const includeProjectionMetadata = projectionSelectionEnabled(snapshot, snapshotId);
  const metadata = includeProjectionMetadata
    ? { entity_id: firstEntityId(item), evidence_id: firstEvidenceId(item) }
    : {};
  if (item.kind === 'component') {
    return { snapshot_id: snapshotId, kind: 'component', stable_id: item.value.id, label: item.value.name, ...metadata };
  }
  if (item.kind === 'relation') {
    return { snapshot_id: snapshotId, kind: 'relation', stable_id: item.value.id, label: item.value.label, ...metadata };
  }
  if (item.kind === 'value-point') {
    return { snapshot_id: snapshotId, kind: 'value_point', stable_id: item.value.stable_id, label: item.value.title, ...metadata };
  }
  return { snapshot_id: snapshotId, kind: 'learning_step', stable_id: item.value.step_id, label: item.value.title, ...metadata };
}

function detailSelectedFor(item: SelectedItem | null, snapshot: Snapshot): ConversationSelection | null {
  return item ? conversationSelection(item, snapshot) : null;
}

function refreshSelection(snapshot: Snapshot, project: Project, item: SelectedItem): SelectedItem | null {
  if (item.kind === 'component') {
    const value = snapshot.graph.nodes.find(node => node.id === item.value.id);
    return value ? (value === item.value ? item : { ...item, value }) : null;
  }
  if (item.kind === 'relation') {
    const value = snapshot.graph.edges.find(edge => edge.id === item.value.id);
    return value ? (value === item.value ? item : { ...item, value }) : null;
  }
  if (item.kind === 'value-point') {
    const value = snapshot.value_points.find(point => point.stable_id === item.value.stable_id);
    return value ? (value === item.value ? item : { ...item, value }) : null;
  }
  const value = (project.study.dynamic_learning_plan?.length
    ? project.study.dynamic_learning_plan
    : snapshot.learning_plan.steps
  ).find(step => step.step_id === item.value.step_id);
  return value ? (value === item.value ? item : { ...item, value }) : null;
}

/** What "就问这个" needs: the object as a conversation card, whether it is already attached, and how to attach it. */
type TopicCard = { selection: ConversationSelection; attached: boolean; onAdd: (selection: ConversationSelection) => void };

/** Attaches the object to the message being written, like a file added to a chat, instead of writing a prompt. */
function AddContextButton({ topic }: { topic: TopicCard | null }) {
  if (!topic) return null;
  return <button type="button" className={`btn btn-primary workspace-topic-button${topic.attached ? ' attached' : ''}`}
    disabled={topic.attached} onClick={() => topic.onAdd(topic.selection)}>
    {topic.attached
      ? <><CheckCircle2 size={14} /> {t('已添加到对话')}</>
      : <><MessageSquarePlus size={14} /> {t(' 就问这个')}</>}
  </button>;
}

export function contextKey(selection: Pick<ConversationSelection, 'kind' | 'stable_id'>): string {
  return `${selection.kind}:${selection.stable_id}`;
}

function ComponentNode({ data, selected }: NodeProps<ComponentFlowNode>) {
  useUiLanguage();
  const component = data.component;
  const extraClass = [
    selected || data.focused ? ' selected' : '',
    data.external ? ' external' : '',
    data.dimmed ? ' dimmed' : '',
  ].join('');
  return (
    <div className={`component-node${extraClass}`}><InkOutline />
      <Handle id="left-target" type="target" position={Position.Left} />
      <Handle id="right-target" type="target" position={Position.Right} />
      <Handle id="top-target" type="target" position={Position.Top} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} />
      <div className="component-node-layer">
        <Layers3 size={12} />
        <span>{data.external
          ? t("外部 · {0}", data.scopeName ?? component.architecture_layer_name ?? t("基础组件"))
          : (data.scopeName ?? component.architecture_layer_name ?? t("基础组件"))}</span>
      </div>
      <div className="component-node-title">{component.name}</div>
      <div className="component-node-responsibility">
        <InlineWorkspaceText text={component.responsibility} />
      </div>
      <div className="component-node-meta">
        <span>{component.member_count} {t(" 项代码")}</span>
        {(data.projectionAggregateMemberEntityIds?.length ?? 0) > 0 && (
          <span>{t("包含 {0} 项内容", data.projectionAggregateMemberEntityIds?.length)}</span>
        )}
      </div>
      {data.onOverviewEnter && <button type="button" className="overview-node-enter nodrag nopan"
        onClick={event => { event.stopPropagation(); data.onOverviewEnter?.(); }}>{t("展开")}</button>}
      <Handle id="left-source" type="source" position={Position.Left} />
      <Handle id="right-source" type="source" position={Position.Right} />
      <Handle id="top-source" type="source" position={Position.Top} />
      <Handle id="bottom-source" type="source" position={Position.Bottom} />
    </div>
  );
}

function LayerNode({ data }: NodeProps<LayerFlowNode>) {
  useUiLanguage();
  const layer = data.layer;
  const isScope = data.rangeKind === 'scope';
  const meta = data.portal
    ? t("{0} 个相关组件 · {1} 条关系 · 点击展开", data.relatedComponentCount ?? data.componentCount, data.relationCount ?? 0)
    : t("{0} 个组件 · {1}", data.componentCount, data.overview ? t("查看关系") : isScope ? t("点击展开") : t("点击进入"));
  return (
    <div className={`layer-node${isScope ? ' scope' : ''}${data.portal ? ' portal' : ''}${data.external ? ' external' : ''}${data.dimmed ? ' dimmed' : ''}${data.focused ? ' focused' : ''}`}><InkOutline />
      <Handle id="left-target" type="target" position={Position.Left} />
      <Handle id="right-target" type="target" position={Position.Right} />
      <Handle id="top-target" type="target" position={Position.Top} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} />
      <div className="layer-node-kicker">
        <Layers3 size={13} />
        <span>{data.portal
          ? (data.external ? (isScope ? t("外部分组") : t("外部架构层")) : (isScope ? t("相关分组") : t("相关架构层")))
          : (isScope ? t("组件分组") : t("架构层"))}</span>
      </div>
      <div className="layer-node-title">{layer.name}</div>
      <div className="layer-node-description">
        <InlineWorkspaceText text={layer.responsibility} />
      </div>
      <div className="layer-node-meta">{meta}</div>
      {data.onOverviewEnter && <button type="button" className="overview-node-enter nodrag nopan"
        onClick={event => { event.stopPropagation(); data.onOverviewEnter?.(); }}>{t("展开")}</button>}
      <Handle id="left-source" type="source" position={Position.Left} />
      <Handle id="right-source" type="source" position={Position.Right} />
      <Handle id="top-source" type="source" position={Position.Top} />
      <Handle id="bottom-source" type="source" position={Position.Bottom} />
    </div>
  );
}

function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  useUiLanguage();
  const group = data as GroupNodeData;
  return (
    <div className={`group-node${group.external ? ' external' : ''}`}>
      <Handle id="left-target" type="target" position={Position.Left} />
      <Handle id="right-target" type="target" position={Position.Right} />
      <Handle id="top-target" type="target" position={Position.Top} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} />
      <button
        type="button"
        className="group-collapse nodrag nopan"
        aria-label={t("收起分组：{0}", group.label)}
        title={t("收起 {0}", group.label)}
        onClick={event => { event.stopPropagation(); group.onCollapse?.(); }}
      >
        <Minimize2 size={16} />
      </button>
      <Handle id="left-source" type="source" position={Position.Left} />
      <Handle id="right-source" type="source" position={Position.Right} />
      <Handle id="top-source" type="source" position={Position.Top} />
      <Handle id="bottom-source" type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { component: ComponentNode, layer: LayerNode, group: GroupNode };

function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  data,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35,
  });

  return (
    <g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={18}
      />
      {label && (hovered || selected || (data as { alwaysLabel?: boolean } | undefined)?.alwaysLabel) && (
        <EdgeLabelRenderer>
          <div
            className="relation-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

const edgeTypes = { relation: RelationEdge };

const WORKSPACE_BARE_FILE_NAMES = new Set([
  '.dockerignore', '.env', '.gitignore', '.npmrc', '.prettierrc', '.yarnrc',
  'containerfile', 'dockerfile', 'gemfile', 'gnumakefile', 'gradlew', 'license', 'makefile', 'mvnw', 'pipfile', 'procfile', 'rakefile', 'readme',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum',
]);
const WORKSPACE_BARE_FILE_EXTENSIONS = new Set([
  'lock', 'orig', 'resolved', 'lockb', 'hcl', 'baseline', 'bazel', 'toml', 'cfg', 'conf', 'cmd',
]);

interface WorkspaceFileReference {
  path: string;
  line: number | null;
  endLine: number | null;
}

function parseWorkspaceFileReference(value: string): WorkspaceFileReference | null {
  let reference = value.trim().replace(/^[([{<\"'`]+/, '').replace(/[\]),.;!?，。；！？}>(\"'`]+$/, '');
  if (!reference || reference.includes('\n') || reference.length > 240) return null;
  const suffix = reference.match(/(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?|:(\d+):\d+)$/i);
  const path = suffix ? reference.slice(0, suffix.index).trim() : reference;
  if (!path || /:\/\//.test(path) || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return null;
  if (path.endsWith('/') || path.split(/[\\/]/).some(part => part === '..') || !/^[A-Za-z0-9_@+$~./\\-]+$/.test(path)) return null;
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const knownBareName = WORKSPACE_BARE_FILE_NAMES.has(fileName.toLowerCase()) || /^dockerfile(?:\.|$)/i.test(fileName);
  const looksLikeFile = knownBareName
    || (fileName.includes('.') && !fileName.startsWith('.')
      && (hasLanguageGlyph(languageFromPath(path)) || WORKSPACE_BARE_FILE_EXTENSIONS.has(extension)));
  if (!looksLikeFile) return null;
  const line = suffix ? Number(suffix[1] ?? suffix[3] ?? suffix[5]) : null;
  const endLine = suffix ? Number(suffix[2] ?? suffix[4] ?? line) : null;
  if (line !== null && (endLine === null || !Number.isInteger(line) || line < 1
    || !Number.isInteger(endLine) || endLine < line)) return null;
  return { path, line, endLine };
}

function workspaceEvidenceMatches(evidence: GraphEvidence, reference: WorkspaceFileReference): boolean {
  const requested = reference.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const candidate = evidence.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const pathMatches = candidate === requested
    || candidate.endsWith(`/${requested}`)
    || (!requested.includes('/') && candidate.split('/').at(-1) === requested);
  if (!pathMatches) return false;
  if (reference.line === null) return true;
  const start = evidence.start_line;
  const end = evidence.end_line ?? start;
  return typeof start === 'number' && reference.line >= start
    && (typeof end !== 'number' || reference.line <= end);
}

function WorkspaceFileLabel({
  reference,
  text,
  evidence,
  onOpenEvidence,
}: {
  reference: WorkspaceFileReference;
  text: string;
  evidence: GraphEvidence[];
  onOpenEvidence?: (item: GraphEvidence) => void;
}) {
  const matchedEvidence = evidence.find(item => workspaceEvidenceMatches(item, reference));
  const lineLabel = reference.line === null
    ? ''
    : reference.endLine && reference.endLine !== reference.line
      ? `:${reference.line}-${reference.endLine}`
      : `:${reference.line}`;
  const content = <><LanguageGlyph language={languageFromPath(reference.path)} /><code>{text}</code></>;
  if (reference.line !== null && matchedEvidence && onOpenEvidence) {
    return (
      <button
        type="button"
        className="markdown-file-reference"
        aria-label={t("打开源码 {0}{1}", reference.path, lineLabel)}
        onClick={() => onOpenEvidence(matchedEvidence)}
      >
        {content}
      </button>
    );
  }
  return <span className="markdown-file-reference-label">{content}</span>;
}

function InlineWorkspaceText({
  text,
  evidence = [],
  onOpenEvidence,
}: {
  text: string;
  evidence?: GraphEvidence[];
  onOpenEvidence?: (item: GraphEvidence) => void;
}): ReactNode {
  // Model text marks identifiers with Markdown backticks; show them as code, never as raw marks.
  const codePattern = /`([^`\n]+)`/g;
  const tokenPattern = /[A-Za-z0-9_@+$~./\\-]+(?::\d+(?:-\d+)?)?/g;
  const nodes: ReactNode[] = [];
  const fileLabel = (key: string, value: string, reference: WorkspaceFileReference) => (
    <WorkspaceFileLabel key={key} reference={reference} text={value} evidence={evidence} onOpenEvidence={onOpenEvidence} />
  );
  const pushPlain = (segment: string, offset: number) => {
    let cursor = 0;
    let match: RegExpExecArray | null;
    tokenPattern.lastIndex = 0;
    while ((match = tokenPattern.exec(segment)) !== null) {
      const reference = parseWorkspaceFileReference(match[0]);
      if (!reference) continue;
      if (match.index > cursor) nodes.push(segment.slice(cursor, match.index));
      nodes.push(fileLabel(`${offset + match.index}:${match[0]}`, match[0], reference));
      cursor = match.index + match[0].length;
    }
    if (cursor < segment.length) nodes.push(segment.slice(cursor));
  };
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > cursor) pushPlain(text.slice(cursor, match.index), cursor);
    const value = match[1].trim();
    const reference = parseWorkspaceFileReference(value);
    nodes.push(reference
      ? fileLabel(`${match.index}:${value}`, value, reference)
      : <code key={`${match.index}:${value}`} className="workspace-inline-code">{value}</code>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushPlain(text.slice(cursor), cursor);
  if (nodes.length === 1 && typeof nodes[0] === 'string') return nodes[0];
  return <>{nodes}</>;
}

function relationKindLabel(kind: string) {
  const labels: Record<string, string> = {
    calls: t("调用"),
    imports: t("导入"),
    inherits: t("继承"),
    implements: t("实现"),
    returns: t("返回"),
    tested_by: t("由测试覆盖"),
    routes_to: t("路由到"),
    reads: t("读取"),
    writes: t("写入"),
  };
  return labels[kind] ?? kind;
}

function DetailsPanel({
  selected,
  detailStatus,
  onRetryDetail,
  onOpenEvidence,
  topic,
  tab,
  noValuePoints = false,
}: {
  tab: WorkspaceTab;
  noValuePoints?: boolean;
  selected: SelectedItem | null;
  detailStatus?: 'loading' | 'error';
  onRetryDetail?: () => void;
  onOpenEvidence: (evidence: GraphEvidence) => void;
  topic: TopicCard | null;
}) {
  useUiLanguage();
  if (!selected) {
    return (
      <div className="workspace-details-empty">
        <Focus size={22} />
        {tab === 'architecture' ? <>
          <strong>{t("选择一个组件或关系")}</strong>
          <span>{t("查看它的作用、相关代码和组件关系。")}</span>
        </> : tab === 'value-points' && noValuePoints ? <>
          <strong>{t("这里暂时没有详情")}</strong>
          <span>{t("切到架构图，选一个组件看看它的作用和相关代码。")}</span>
        </> : tab === 'value-points' ? <>
          <strong>{t("选择一个价值点")}</strong>
          <span>{t("查看它解决的问题、实现方式和相关代码。")}</span>
        </> : <>
          <strong>{t("选择一个学习步骤")}</strong>
          <span>{t("查看这一步的目标和完成检查。")}</span>
        </>}
      </div>
    );
  }

  if ((selected.kind === 'component' || selected.kind === 'relation') && detailStatus) {
    return <div className="workspace-details-scroll" role="status">
      <div className="workspace-detail-heading"><h3>{selected.kind === 'component' ? selected.value.name : selected.value.label}</h3></div>
      <p>{detailStatus === 'loading' ? t('正在加载完整代码参考…') : t('完整代码参考加载失败。')}</p>
      {detailStatus === 'error' && <button type="button" className="btn btn-primary" onClick={onRetryDetail}>{t('重试')}</button>}
    </div>;
  }

  if (selected.kind === 'component') {
    const component = selected.value;
    return (
      <div key={component.id} className="workspace-details-scroll" data-testid="component-details">
        <div className="workspace-detail-heading">
          <div>
            <div className="workspace-eyebrow">{t("组件")}</div>
            <h3>{component.name}</h3>
          </div>
        </div>
        <section>
          <h4>{t("作用")}</h4>
          <p><InlineWorkspaceText text={component.responsibility} evidence={component.evidence} onOpenEvidence={onOpenEvidence} /></p>
        </section>
        <section>
          <h4>{t("分组依据")}</h4>
          <p><InlineWorkspaceText text={component.grouping_rationale} evidence={component.evidence} onOpenEvidence={onOpenEvidence} /></p>
        </section>
        <section>
          <h4>{t("架构层")}</h4>
          <p>{component.architecture_layer_name ?? t("暂未归类")}</p>
          {component.architecture_layer_rationale && (
            <p className="workspace-secondary"><InlineWorkspaceText text={component.architecture_layer_rationale} evidence={component.evidence} onOpenEvidence={onOpenEvidence} /></p>
          )}
        </section>
        <AddContextButton topic={topic} />
        <section>
          <h4>{t("相关代码")}</h4>
          <EvidenceList key={component.id}
            evidence={component.members.length ? component.members : component.evidence}
            onOpenEvidence={onOpenEvidence}
          />
        </section>
      </div>
    );
  }

  if (selected.kind === 'relation') {
    const relation = selected.value;
    return (
      <div className="workspace-details-scroll" data-testid="relation-details">
        <div className="workspace-detail-heading">
          <div>
            <div className="workspace-eyebrow">{t("组件关系")}</div>
            <h3>{relation.label}</h3>
          </div>
        </div>
        <section>
          <h4>{t("关系类型")}</h4>
          <p>{relationKindLabel(relation.relation_kind)}</p>
        </section>
        <section>
          <h4>{t("解释")}</h4>
          <p><InlineWorkspaceText text={relation.description} evidence={relation.evidence} onOpenEvidence={onOpenEvidence} /></p>
        </section>
        <AddContextButton topic={topic} />
        <section>
          <h4>{t("代码参考")}</h4>
          <EvidenceList key={relation.id} evidence={relation.evidence} onOpenEvidence={onOpenEvidence} />
        </section>
      </div>
    );
  }

  if (selected.kind === 'value-point') {
    const point = selected.value;
    return (
      <div className="workspace-details-scroll" data-testid="value-point-details">
        <div className="workspace-detail-heading">
          <div>
            <div className="workspace-eyebrow">{t("价值点")}</div>
            <h3>{point.title}</h3>
          </div>
        </div>
        {point.problem && <section><h4>{t("解决的问题")}</h4><p><InlineWorkspaceText text={point.problem} evidence={point.evidence} onOpenEvidence={onOpenEvidence} /></p></section>}
        <section><h4>{t("核心思路")}</h4><p><InlineWorkspaceText text={point.claim} evidence={point.evidence} onOpenEvidence={onOpenEvidence} /></p></section>
        {point.implementation && <section><h4>{t("实现方式")}</h4><p><InlineWorkspaceText text={point.implementation} evidence={point.evidence} onOpenEvidence={onOpenEvidence} /></p></section>}
        {point.tradeoffs && <section><h4>{t("取舍")}</h4><p><InlineWorkspaceText text={point.tradeoffs} evidence={point.evidence} onOpenEvidence={onOpenEvidence} /></p></section>}
        {point.transfer_conditions && (
          <section><h4>{t("什么时候适合借鉴")}</h4><p><InlineWorkspaceText text={point.transfer_conditions} evidence={point.evidence} onOpenEvidence={onOpenEvidence} /></p></section>
        )}
        <AddContextButton topic={topic} />
        <section>
          <h4>{t("代码参考")}</h4>
          <EvidenceList key={point.stable_id} evidence={point.evidence} onOpenEvidence={onOpenEvidence} />
        </section>
      </div>
    );
  }

  const step = selected.value;
  return (
    <div className="workspace-details-scroll" data-testid="learning-step-details">
      <div className="workspace-detail-heading">
        <div>
          <div className="workspace-eyebrow">{t("学习步骤 ")}{step.order}</div>
          <h3>{step.title}</h3>
        </div>
        <BookOpenCheck size={18} />
      </div>
      <section><h4>{t("目标")}</h4><p><InlineWorkspaceText text={step.objective} /></p></section>
      <section><h4>{t("完成检查")}</h4><p><InlineWorkspaceText text={step.completion_check} /></p></section>
      <AddContextButton topic={topic} />
    </div>
  );
}

function ArchitectureView({
  snapshot,
  onSelect,
}: {
  snapshot: Snapshot;
  onSelect: (item: SelectedItem) => void;
}) {
  const phone = usePhoneDevice();
  const uiLanguage = useUiLanguage();
  const ariaLabelConfig = useMemo(() => ({
    'controls.ariaLabel': translateFor(uiLanguage, '图形操作'),
    'controls.zoomIn.ariaLabel': translateFor(uiLanguage, '放大'),
    'controls.zoomOut.ariaLabel': translateFor(uiLanguage, '缩小'),
    'controls.fitView.ariaLabel': translateFor(uiLanguage, '适应视图'),
    'minimap.ariaLabel': translateFor(uiLanguage, '小地图'),
  }), [uiLanguage]);
  const architectureLayers = useMemo(() => getArchitectureLayers(snapshot), [snapshot, uiLanguage]);
  const [overviewSelection, setOverviewSelection] = useState<string | null>(null);
  const [overviewHover, setOverviewHover] = useState<string | null>(null);
  const [showAllOverviewEdges, setShowAllOverviewEdges] = useState(false);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [navigation, setNavigation] = useState<{
    layerId: string | null;
    expandedScopeId: string | null;
    activeComponentId: string | null;
    expandedRelatedScopeId: string | null;
    focusComponentId: string | null;
  }>({ layerId: null, expandedScopeId: null, activeComponentId: null, expandedRelatedScopeId: null, focusComponentId: null });
  const previousSnapshotId = useRef(snapshot.snapshot_id);
  useEffect(() => {
    if (previousSnapshotId.current === snapshot.snapshot_id) return;
    previousSnapshotId.current = snapshot.snapshot_id;
    setOverviewSelection(null);
    setOverviewHover(null);
    setShowAllOverviewEdges(false);
    setNavigation({ layerId: null, expandedScopeId: null, activeComponentId: null, expandedRelatedScopeId: null, focusComponentId: null });
  }, [snapshot.snapshot_id]);
  const collapseScope = useCallback((scopeId: string) => {
    setNavigation(current => ({
      ...current,
      expandedScopeId: current.expandedScopeId === scopeId ? null : current.expandedScopeId,
      expandedRelatedScopeId: null,
      focusComponentId: null,
    }));
  }, []);
  const initial = useMemo(() => {
    const flow = navigation.layerId
      ? buildLayerScopeFlow(snapshot, navigation.layerId, navigation)
      : buildLayerOverviewFlow(snapshot);
    return {
      ...flow,
      nodes: flow.nodes.map(node => node.type === 'group'
        ? { ...node, data: { ...node.data, onCollapse: () => collapseScope(node.data.scopeId) } }
        : node),
    };
  }, [navigation, snapshot, collapseScope, uiLanguage]);
  const layoutKey = JSON.stringify([snapshot.snapshot_id, navigation.layerId, navigation.expandedScopeId, navigation.activeComponentId, navigation.expandedRelatedScopeId]);
  const previousLayoutKey = useRef(layoutKey);
  const [nodes, setNodes] = useNodesState<ArchitectureFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const containerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<ArchitectureFlowNode, Edge> | null>(null);
  const hasFittedRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);

  const scheduleFit = useCallback(() => {
    if (hasFittedRef.current || fitFrameRef.current !== null) return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const container = containerRef.current;
      const flow = flowRef.current;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0 || !flow) return;

      // React Flow calls onInit before custom nodes have their real dimensions.
      // Wait for that measurement so fitView cannot lock in a tiny initial zoom.
      const currentNodes = flow.getNodes();
      if (currentNodes.length > 0 && !currentNodes.every(node => (
        (node.measured?.width ?? 0) > 0 && (node.measured?.height ?? 0) > 0
      ))) return;

      void flow.fitView({ padding: 0.18, duration: 0 });
      hasFittedRef.current = true;
    });
  }, []);

  const onArchitectureNodesChange = useCallback((changes: NodeChange<ArchitectureFlowNode>[]) => {
    const measured = changes.some(change => {
      if (change.type !== 'dimensions') return false;
      const width = change.dimensions?.width;
      const height = change.dimensions?.height;
      return width != null && height != null;
    });
    setNodes(current => applyNodeChanges(changes, current));
    if (measured) {
      scheduleFit();
    }
  }, [scheduleFit, setNodes]);

  useEffect(() => {
    const positions = new Map(nodes.map(node => [node.id, {
      ...node.position,
      width: node.measured?.width ?? node.width ?? (node.type === 'layer' ? 320 : 260),
      height: node.measured?.height ?? node.height ?? (node.type === 'layer' ? 188 : 156),
    }]));
    setEdges(current => current.map(edge => ({
      ...edge,
      ...handleSides(edge.source, edge.target, positions),
    })));
  }, [nodes, setEdges]);

  useEffect(() => {
    const layoutChanged = previousLayoutKey.current !== layoutKey;
    previousLayoutKey.current = layoutKey;
    // Keep measured dimensions and manually moved card positions on focus.
    // Only expansion/navigation changes require a new layout and fitView.
    setNodes(current => {
      if (layoutChanged) return initial.nodes;
      const existing = new Map(current.map(node => [node.id, node]));
      return initial.nodes.map(node => {
        const previous = existing.get(node.id);
        return {
          ...node,
          position: previous?.position ?? node.position,
          measured: previous?.measured,
          selected: previous?.selected,
        };
      });
    });
    setEdges(initial.edges);
    if (layoutChanged) {
      hasFittedRef.current = false;
      scheduleFit();
    }
  }, [initial, layoutKey, scheduleFit, setEdges, setNodes]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    let previousWidth = 0, previousHeight = 0;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth, height = container.clientHeight;
      // Opening/width changes still fit. A vertical split must preserve pan and zoom.
      const needsFit = !hasFittedRef.current || Math.abs(width - previousWidth) > 0.5 || previousHeight === 0;
      previousWidth = width; previousHeight = height;
      if (needsFit) { hasFittedRef.current = false; scheduleFit(); }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    };
  }, [scheduleFit]);

  const enterNode = useCallback((node: ArchitectureFlowNode) => {
    if (node.type === 'group') return;
    if (node.type === 'layer') {
      const data = node.data as LayerNodeData;
      if (data.rangeKind === 'scope') {
        const scopeId = data.targetScopeId ?? data.layer.id;
        setNavigation(current => current.expandedScopeId || current.activeComponentId ? {
          ...current, expandedRelatedScopeId: scopeId, focusComponentId: null,
        } : {
          ...current, expandedScopeId: scopeId, activeComponentId: null, expandedRelatedScopeId: null, focusComponentId: null,
        });
      } else {
        setNavigation({
          layerId: data.targetLayerId ?? data.layer.id,
          expandedScopeId: null, activeComponentId: null, expandedRelatedScopeId: null, focusComponentId: null,
        });
      }
      return;
    }
    const data = node.data as ComponentNodeData;
    setNavigation(current => {
      // Choose a subject at the layer level. Once expanded, related cards only
      // change the selection; choosing another subject requires going back.
      if (!data.external && !data.scopeId && !current.expandedScopeId && !current.activeComponentId) {
        return {
          layerId: data.targetLayerId ?? current.layerId,
          activeComponentId: data.component.id, expandedScopeId: null,
          expandedRelatedScopeId: null, focusComponentId: null,
        };
      }
      return { ...current, focusComponentId: data.component.id };
    });
    onSelect({
      kind: 'component', value: data.component, entityId: data.component.id,
      evidenceId: data.projectionEvidenceIds?.[0] ?? data.component.evidence[0]?.stable_id ?? null,
    });
  }, [onSelect]);
  const onNodeClick = useCallback<NodeMouseHandler<ArchitectureFlowNode>>((event, node) => {
    // Within a layer, the first click already expands the scope. A second click
    // from the same double-click must not enter another card after it reflows.
    if (navigation.layerId && event.detail > 1) return;
    if (!navigation.layerId) {
      if (showAllOverviewEdges) { enterNode(node); return; }
      setOverviewSelection(node.id);
      if (node.type === 'component') {
        onSelect({ kind: 'component', value: node.data.component, entityId: node.data.component.id,
          evidenceId: node.data.component.evidence[0]?.stable_id ?? null });
      }
      return;
    }
    enterNode(node);
  }, [navigation.layerId, showAllOverviewEdges, enterNode, onSelect]);
  const onEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => {
    const data = edge.data as { relationIds?: string[]; evidenceIds?: string[] } | undefined;
    const relation = snapshot.graph.edges.find(item => item.id === edge.id)
      ?? data?.relationIds?.map(id => snapshot.graph.edges.find(item => item.id === id)).find(Boolean);
    if (relation) {
      onSelect({
        kind: 'relation',
        value: relation,
        entityId: relation.source,
        evidenceId: data?.evidenceIds?.[0] ?? relation.evidence[0]?.stable_id ?? null,
      });
    }
  }, [onSelect, snapshot.graph.edges]);

  const activeLayer = navigation.layerId
    ? architectureLayers.find(layer => layer.id === navigation.layerId) ?? null
    : null;
  const overviewFocus = showAllOverviewEdges ? null : overviewHover ?? overviewSelection;
  const overviewRelatedNodes = new Set(overviewFocus ? [overviewFocus] : []);
  if (!navigation.layerId && overviewFocus) {
    for (const edge of edges) {
      if (edge.source === overviewFocus) overviewRelatedNodes.add(edge.target);
      if (edge.target === overviewFocus) overviewRelatedNodes.add(edge.source);
    }
  }
  const displayedNodes = navigation.layerId ? nodes : nodes.map(node => {
    const feedback = { overview: !showAllOverviewEdges, focused: node.id === overviewFocus,
      onOverviewEnter: node.id === overviewSelection ? () => { setOverviewHover(null); enterNode(node); } : undefined,
      dimmed: Boolean(overviewFocus && !overviewRelatedNodes.has(node.id)) };
    const interaction = { selected: false, draggable: !feedback.dimmed && node.draggable !== false };
    if (node.type === 'layer') return { ...node, ...interaction, data: { ...node.data, ...feedback } };
    if (node.type === 'component') return { ...node, ...interaction, data: { ...node.data, ...feedback } };
    return node;
  });
  const displayedEdges = navigation.layerId ? edges : edges
    .filter(edge => showAllOverviewEdges || edge.source === overviewFocus || edge.target === overviewFocus)
    .map(edge => {
      const connected = edge.source === overviewFocus || edge.target === overviewFocus;
      return { ...edge, style: { ...edge.style,
        opacity: 1,
        stroke: connected ? 'var(--accent)' : edge.style?.stroke,
      } };
    });
  return (
    <div className="architecture-view">
      <div className="component-flow" data-testid="component-flow" ref={containerRef}
        onKeyDownCapture={event => {
          if (navigation.layerId) return;
          if (event.key === 'Escape') { setOverviewSelection(null); setOverviewHover(null); return; }
          const id = (event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
          const node = nodes.find(item => item.id === id);
          if (node && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault(); event.stopPropagation();
            setOverviewHover(null);
            if (showAllOverviewEdges || (event.key === 'Enter' && overviewSelection === id)) enterNode(node);
            else setOverviewSelection(node.id);
          }
        }}>
        {!navigation.layerId && <button type="button" className="architecture-all-edges"
          aria-pressed={showAllOverviewEdges} onClick={() => {
            setOverviewSelection(null);
            setOverviewHover(null);
            setShowAllOverviewEdges(value => !value);
          }}>
          <Link2 size={14} /> {t("显示所有关系")}</button>}
        <div className={`architecture-breadcrumb${!navigation.layerId ? ' overview' : ''}`}>
          {!navigation.layerId ? (
            <span>{t("架构总览 · ")}{architectureLayers.length} {t(" 个架构层")}</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setNavigation({
                  layerId: null, expandedScopeId: null, activeComponentId: null, expandedRelatedScopeId: null, focusComponentId: null,
                })}
              >
                <ChevronLeft size={14} /> {t(" 架构总览")}</button>
              <span className="architecture-breadcrumb-separator">›</span>
              <span>{activeLayer?.name ?? t("架构层")}</span>
              {navigation.activeComponentId && (
                <button
                  type="button"
                  className="architecture-focus-clear"
                  onClick={() => setNavigation(current => ({
                    layerId: activeLayer?.component_ids.length === 1 ? null : current.layerId,
                    expandedScopeId: null, activeComponentId: null,
                    expandedRelatedScopeId: null, focusComponentId: null,
                  }))}
                >
                  {t("收起相关组件")}</button>
              )}
              {navigation.focusComponentId && (
                <button
                  type="button"
                  className="architecture-focus-clear"
                  onClick={() => setNavigation(current => ({ ...current, focusComponentId: null }))}
                >
                  {t("取消选中")}</button>
              )}
            </>
          )}
        </div>
        {initial.omittedEdgeCount > 0 && (
          <div className="graph-density-note">
            {t("当前显示 {0}/{1} 条关系", initial.edges.length, initial.edges.length + initial.omittedEdgeCount)}</div>
        )}
        <ReactFlow<ArchitectureFlowNode, Edge>
        ariaLabelConfig={ariaLabelConfig}
        nodes={phone ? displayedNodes.map(node => ({ ...node, draggable: false })) : displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onArchitectureNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={(_event, node) => { if (!navigation.layerId && !showAllOverviewEdges && !overviewSelection) setOverviewHover(node.id); }}
        onNodeMouseLeave={() => setOverviewHover(null)}
        onPaneClick={() => { setOverviewSelection(null); setOverviewHover(null); }}
        onNodeDoubleClick={(_event, node) => { if (!navigation.layerId) { setOverviewHover(null); enterNode(node); } }}
        onEdgeClick={onEdgeClick}
        onInit={instance => {
          flowRef.current = instance;
          scheduleFit();
        }}
        nodesDraggable={!phone}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        maxZoom={2}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        >
          {showMiniMap && <MiniMap
          pannable
          zoomable
          nodeColor={node => {
            if (node.type === 'layer') {
              return (node.data as LayerNodeData).external ? 'var(--warn)' : 'var(--accent)';
            }
            if (node.type === 'group') {
              return (node.data as GroupNodeData).external ? 'var(--warn)' : 'var(--accent)';
            }
            const component = (node.data as ComponentNodeData).component;
            if ((node.data as ComponentNodeData).external) return 'var(--warn)';
            return ['supported', 'provider_supported', 'verified', 'direct'].includes(component.certainty)
              ? 'var(--accent)' : 'var(--fg-tertiary)';
          }}
          nodeStrokeColor={() => 'var(--panel-strong)'}
          nodeBorderRadius={4}
          />}
          <Controls showInteractive={false}>
            <ControlButton title={t('小地图')} aria-label={t('小地图')} aria-pressed={showMiniMap}
              onClick={() => setShowMiniMap(current => !current)}><MapIcon className="sketch-control-icon" size={16} /></ControlButton>
          </Controls>
          <Background color="var(--graph-grid)" variant={BackgroundVariant.Dots} gap={22} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}

const MemoArchitectureView = memo(ArchitectureView);
// Dragging only changes the split; unchanged evidence must not render on every move.
const MemoDetailsPanel = memo(DetailsPanel);

export { RepositoryThumbnail } from './RepositoryThumbnail';

function ValuePointsView({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected: SelectedItem | null;
  onSelect: (item: SelectedItem) => void;
}) {
  if (!snapshot.value_points.length) return <ValuePointsEmpty />;
  return (
    <div className="value-point-grid" data-testid="value-point-list">
      {snapshot.value_points.map((point, index) => (
        <button
          key={point.stable_id}
          className={`value-point-card${selected?.kind === 'value-point' && selected.value.stable_id === point.stable_id ? ' selected' : ''}`}
          onClick={() => onSelect({ kind: 'value-point', value: point })}
        >
          <InkOutline /><div className="value-point-card-top">
            <span>{String(index + 1).padStart(2, '0')}</span>
          </div>
          <h3>{point.title}</h3>
          <p><InlineWorkspaceText text={point.problem?.trim() || point.claim} /></p>
          <div className="value-point-card-meta">
            <span><Link2 size={12} /> {point.evidence.length} {t(" 处代码参考")}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * No value points: not an empty repository, just a page still to be written. An open notebook with a pencil; now
 * and then the pencil is picked up, hovers over the page as if deciding what to write, gets a twirl and is laid
 * gently back down.
 */
function ValuePointsEmpty() {
  return (
    <div className="value-points-empty">
      <svg viewBox="0 0 200 130" aria-hidden="true" focusable="false">
        <Ink points={[[37,40],[66,33],[99,39],[99,111],[66,105],[37,111],[35,76]]} width={3.4} closed fill="var(--panel)" />
        <Ink points={[[99,39],[132,33],[163,40],[165,76],[163,111],[132,105],[99,111]]} width={3.4} closed fill="var(--panel)" />
        <g stroke="var(--border-strong)" strokeWidth={1.8} strokeLinecap="round" fill="none">
          <path d="M46 56 Q66 51 90 56 M46 70 Q66 65 90 70 M46 84 Q62 80 80 84" />
          <path d="M108 56 Q132 51 154 56 M108 70 Q132 65 154 70" />
        </g>
        <g transform="translate(132 86) rotate(-28)">
          {/* Its shadow stays on the page (only turning with it), so a lifted pencil shows the gap. */}
          <g className="value-points-pencil-shadow"><path d="M-29 -1.6 H18 L27 2 L18 5.6 H-29 Z" fill="color-mix(in srgb, currentColor 16%, transparent)" /></g>
          <g className="value-points-pencil">
          <Ink points={[[-22,-3.6],[18,-3.6],[18,3.6],[-22,3.6]]} width={2.4} closed fill="#f2c55c" />
          <Ink points={[[18,-3.6],[27,0],[18,3.6]]} width={2.4} closed fill="#f3e3c3" />
          <path d="M24.2 -1.3 L27.4 0 L24.2 1.3 Z" fill="currentColor" />
          <Ink points={[[-22,-3.6],[-29,-3.6],[-29,3.6],[-22,3.6]]} width={2.4} closed fill="#eba7b5" />
          <path d="M-20.5 -2.2 H14" stroke="color-mix(in srgb, currentColor 30%, #f2c55c)" strokeWidth={1.2} strokeLinecap="round" />
        </g></g>
      </svg>
      <strong>{t("这次没有找到价值点")}</strong>
      <p>{t("分析没有提炼出值得单独拿出来学的设计。可以直接提问，或者从架构图里挑一个组件看看。")}</p>
    </div>
  );
}

function LearningPlanView({
  snapshot,
  project,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  project: Project;
  selected: SelectedItem | null;
  onSelect: (item: SelectedItem) => void;
}) {
  const steps = project.study.dynamic_learning_plan?.length
    ? project.study.dynamic_learning_plan
    : snapshot.learning_plan.steps;
  return (
    <div className="learning-plan" data-testid="learning-plan">
      {steps.length ? steps.map((step, index) => {
        const completed = index < project.study.current_step;
        const current = index === project.study.current_step;
        return (
          <button
            key={step.step_id}
            className={`learning-step${completed ? ' completed' : ''}${current ? ' current' : ''}${selected?.kind === 'learning-step' && selected.value.step_id === step.step_id ? ' selected' : ''}`}
            onClick={() => onSelect({ kind: 'learning-step', value: step })}
          >
            <div className="learning-step-index">{completed ? <CheckCircle2 size={15} /> : index + 1}</div>
            <div>
              <div className="learning-step-title">{step.title}</div>
              <p><InlineWorkspaceText text={step.objective} /></p>
              <span>{step.component_ids.length} {t(" 个组件 · ")}{step.evidence_refs.length} {t(" 处代码参考")}</span>
            </div>
          </button>
        );
      }) : (
        <div className="learning-plan-empty"><FieldIllustration compact /><p>{t("说“开始系统学习”即可生成路线；也可以先选择一个价值点作为重点。")}</p></div>
      )}
    </div>
  );
}

export function RepositoryWorkspace({
  snapshot,
  project,
  onOpenEvidence,
  onAddContext,
  attachedContexts = [],
  detailsVisible = true,
}: {
  snapshot: Snapshot;
  project: Project;
  onOpenEvidence: (evidence: GraphEvidence) => void;
  /** Adds the object to the message being written ("就问这个"). Browsing the graph attaches nothing by itself. */
  onAddContext: (selection: ConversationSelection) => void;
  /** Objects already attached to that message, so their button can say so. */
  attachedContexts?: ConversationSelection[];
  detailsVisible?: boolean;
}) {
  const [tab, setTab] = useState<WorkspaceTab>('architecture');
  const split = useWorkspaceSplit(tab === 'architecture');
  // Local layout properties avoid inheriting a changing CSS variable through every graph/evidence element.
  const canvasSize = (split.style as { '--workspace-canvas-share': string })['--workspace-canvas-share'];
  const phone = usePhoneDevice();
  const detailsId = useId();
  const uiLanguage = useUiLanguage();
  const [selected, setSelected] = useState<SelectedItem | null>(() => firstTabSelection(snapshot, 'architecture'));
  const detailCache = useRef(new Map<string, GraphNode | GraphEdge>());
  const [detailResult, setDetailResult] = useState<{ key: string; item?: GraphNode | GraphEdge; error?: boolean } | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const previousSnapshotId = useRef(snapshot.snapshot_id);
  const tabSelections = useRef<Partial<Record<WorkspaceTab, SelectedItem>>>({});

  const detailLanguage = snapshot.display_language === 'en' ? 'en' : 'zh-CN';
  useEffect(() => {
    detailCache.current.clear();
    setDetailResult(null);
  }, [project.project_id, snapshot.snapshot_id, detailLanguage]);
  const detailKind = selected?.kind === 'component' || selected?.kind === 'relation' ? selected.kind : null;
  const detailKey = (selected?.kind === 'component' || selected?.kind === 'relation') && selected.value.detail_available
    ? JSON.stringify([project.project_id, snapshot.snapshot_id, detailLanguage, detailKind, selected.value.id])
    : null;
  useEffect(() => {
    if (!detailsVisible || !detailKey || !detailKind || !selected || (selected.kind !== 'component' && selected.kind !== 'relation')) return;
    const cached = detailCache.current.get(detailKey);
    if (cached) {
      detailCache.current.delete(detailKey);
      detailCache.current.set(detailKey, cached);
      setDetailResult({ key: detailKey, item: cached });
      return;
    }
    let active = true;
    setDetailResult({ key: detailKey });
    apiClient.getSnapshotDetail(project.project_id, snapshot.snapshot_id, detailLanguage, detailKind, selected.value.id)
      .then(result => {
        if (!active) return;
        if (result.snapshot_id !== snapshot.snapshot_id || result.display_language !== detailLanguage
          || result.kind !== detailKind || result.item.id !== selected.value.id) throw new Error('Snapshot detail mismatch');
        const item = result.item as GraphNode | GraphEdge;
        detailCache.current.delete(detailKey);
        detailCache.current.set(detailKey, item);
        while (detailCache.current.size > 32) {
          const oldest = detailCache.current.keys().next().value;
          if (oldest === undefined) break;
          detailCache.current.delete(oldest);
        }
        setDetailResult({ key: detailKey, item });
      })
      .catch(() => { if (active) setDetailResult({ key: detailKey, error: true }); });
    return () => { active = false; };
  }, [detailKey, detailKind, detailLanguage, detailAttempt, detailsVisible, project.project_id, selected, snapshot.snapshot_id]);

  const detailSelected: SelectedItem | null = detailKey && detailResult?.key === detailKey && detailResult.item && selected
    ? { ...selected, value: detailResult.item } as SelectedItem : selected;
  const detailStatus = !detailKey || (detailResult?.key === detailKey && detailResult.item)
    ? undefined
    : detailResult?.key === detailKey && detailResult.error ? 'error' : 'loading';
  const retryDetail = useCallback(() => {
    if (detailKey) detailCache.current.delete(detailKey);
    setDetailAttempt(attempt => attempt + 1);
  }, [detailKey]);

  useEffect(() => {
    const snapshotChanged = previousSnapshotId.current !== snapshot.snapshot_id;
    previousSnapshotId.current = snapshot.snapshot_id;
    if (snapshotChanged) tabSelections.current = {};
    const refreshed = !snapshotChanged && selected ? refreshSelection(snapshot, project, selected) : null;
    if (refreshed) {
      if (refreshed !== selected) setSelected(refreshed);
      return;
    }
    setSelected(firstTabSelection(snapshot, tab, project));
  }, [project, selected, snapshot, tab]);

  const select = useCallback((item: SelectedItem | null) => { setSelected(item); }, []);
  const attachedKeys = useMemo(() => new Set(attachedContexts.map(contextKey)), [attachedContexts]);
  const topicSelection = useMemo(() => detailSelectedFor(selected, snapshot), [selected, snapshot]);
  const topic = useMemo<TopicCard | null>(() => topicSelection
    ? { selection: topicSelection, attached: attachedKeys.has(contextKey(topicSelection)), onAdd: onAddContext }
    : null, [attachedKeys, onAddContext, topicSelection]);

  function switchTab(next: WorkspaceTab) {
    if (next === tab) return;
    if (selected) tabSelections.current[tab] = selected;
    const saved = tabSelections.current[next];
    const item = (saved ? refreshSelection(snapshot, project, saved) : null) ?? firstTabSelection(snapshot, next, project);
    setTab(next);
    select(item);
  }

  const resultLanguage = snapshot.display_language === 'en' ? t('英文') : t('中文');
  const requestedLanguage = uiLanguage === 'en' ? t('英文') : t('中文');
  const languageStatus = t('暂无{0}分析结果，当前展示{1}。', requestedLanguage, resultLanguage);

  return (
    <div className="repository-workspace">
      {snapshot.display_language && snapshot.display_language !== uiLanguage && (
        <div className="snapshot-language-notice" role="status">
          {languageStatus} {t('可新建项目选择{0}分析。', requestedLanguage)}
        </div>
      )}
      <header className="workspace-toolbar">
        <div className="workspace-tabs" role="tablist" aria-label={t("仓库学习")}>
          <button
            role="tab"
            aria-selected={tab === 'architecture'}
            className={tab === 'architecture' ? 'active' : ''}
            onClick={() => switchTab('architecture')}
          >
            <Braces size={14} /> {t(" 架构图")}</button>
          <button
            role="tab"
            aria-selected={tab === 'value-points'}
            className={tab === 'value-points' ? 'active' : ''}
            onClick={() => switchTab('value-points')}
          >
            <Route size={14} /> {t(" 价值点")}</button>
          <button
            role="tab"
            aria-selected={tab === 'learning-plan'}
            className={tab === 'learning-plan' ? 'active' : ''}
            onClick={() => switchTab('learning-plan')}
          >
            <BookOpenCheck size={14} /> {t(" 学习路线")}</button>
        </div>
        <div className="workspace-status-row">
          {snapshot.languages.map(language => (
            <span
              key={language.language}
              className={`language-quality tier-${language.quality_tier}`}
            >
              <LanguageGlyph language={language.language} />
            </span>
          ))}
        </div>
      </header>

      <div ref={split.bodyRef} className={`workspace-body${split.active ? ' has-workspace-split' : ''}${split.collapsed ? ' details-collapsed' : ''}`}
        data-split-touch={phone || undefined} style={split.active ? { gridTemplateRows: `minmax(0, ${canvasSize}) minmax(0, 1fr)` } : undefined}>
        <main className="workspace-canvas">
          {/* Keep the canvas mounted and measured so returning preserves its viewport and navigation. */}
          <div className="workspace-architecture-panel" aria-hidden={tab !== 'architecture'}
            inert={tab !== 'architecture'} style={{ opacity: tab === 'architecture' ? 1 : 0 }}>
            <MemoArchitectureView snapshot={snapshot} onSelect={select} />
          </div>
          {tab === 'value-points' && (
            <ValuePointsView snapshot={snapshot} selected={selected} onSelect={select} />
          )}
          {tab === 'learning-plan' && (
            <LearningPlanView
              snapshot={snapshot}
              project={project}
              selected={selected}
              onSelect={select}
            />
          )}
        </main>
        <div className={`workspace-divider${split.dragging ? ' is-dragging' : ''}`} hidden={!split.active}
          role="separator" tabIndex={0} aria-label={t('调整架构图与详情高度')} aria-orientation="horizontal"
          aria-controls={detailsId} aria-valuemin={60} aria-valuemax={100} aria-valuenow={split.percent}
          aria-valuetext={t('架构图 {0}%，详情 {1}%', split.percent, 100 - split.percent)}
          style={{ top: canvasSize }}
          {...split.separatorProps}><SplitGripIcon /></div>
        <aside id={detailsId} className="workspace-details" aria-hidden={split.collapsed || undefined} inert={split.collapsed}>
          <MemoDetailsPanel
            selected={detailSelected}
            detailStatus={detailStatus}
            onRetryDetail={retryDetail}
            onOpenEvidence={onOpenEvidence}
            topic={topic}
            tab={tab}
            noValuePoints={!snapshot.value_points.length}
          />
        </aside>
      </div>
    </div>
  );
}
