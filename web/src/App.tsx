import { InlineMessageEditor } from './InlineMessageEditor';
import { chatHistoryUsage, chatCapacityReached, isChatCapacityError } from './chat-capacity';
import { useTextareaAutosize } from './useTextareaAutosize';
import { usePhoneDevice } from './usePhoneDevice';
import { detailedAnalysisStages } from './analysis-stage-catalog';
import { ActivityIcon } from './ActivityIcon';
import { activityPhaseKey, activityPhaseLabel, activityIconName, activityStatusLabel, analysisActivityLabel, analysisProgressLabels, analysisEventLabel, analysisStageKey, type ActivityPhaseKey } from './activity-presentation';
import { UserRound, Plus, Settings, Send, Sun, Moon, X, LogOut, ChevronRight, ChevronLeft, ChevronDown as ChevronDownSketch } from './HandIcons';
import { t, getUiLanguage, setUiLanguage, useUiLanguage, translateFor, type UiLanguage } from './ui-language';
import { LanguagePicker } from './LanguagePicker';
import { providerVariantLabel } from './provider-variant-label';
import { lazy, Suspense, Fragment, memo, useCallback, useMemo, useState, useEffect, useLayoutEffect, useId, useRef } from 'react';
import { useSmoothChatScroll } from './useSmoothChatScroll';
import { useMediaQuery } from './useMediaQuery';
import { LastMessageActions, ConversationErrorNotice } from './ConversationFeedback';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js/lib/common';
import ReactMarkdown, { type Components as MarkdownComponents } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Box from '@sketchyicons/react/icons/box';
import LogIn from '@sketchyicons/react/icons/log-in';
import Check from '@sketchyicons/react/icons/check';
import MoreHorizontal from '@sketchyicons/react/icons/more-horizontal';
import PanelLeftClose from '@sketchyicons/react/icons/panel-left-close';
import PanelLeftOpen from '@sketchyicons/react/icons/panel-left-open';
import Pencil from '@sketchyicons/react/icons/pencil';
import RefreshCw from '@sketchyicons/react/icons/refresh-cw';
import ShieldCheck from '@sketchyicons/react/icons/shield-check';
import ThumbsDown from '@sketchyicons/react/icons/thumbs-down';
import ThumbsUp from '@sketchyicons/react/icons/thumbs-up';
import Trash2 from '@sketchyicons/react/icons/trash-2';
import { apiClient, userFacingError, conversationErrorMessage } from './api';
import { hasLanguageGlyph, LanguageGlyph, languageFromPath } from './language-glyph';
import { RepositoryThumbnail } from './RepositoryThumbnail';
import { LazyLoadBoundary } from './LazyLoadBoundary';
import type { TopicRequest } from './RepositoryWorkspace';
const RepositoryWorkspace = lazy(() => import('./RepositoryWorkspace').then(module => ({ default: module.RepositoryWorkspace })));
import type {
  ConversationSelection,
  AnalysisState,
  AuthConfigResponse,
  GraphEvidence,
  IdentityResponse,
  LearnerProfile,
  Message,
  Project,
  ProjectSummary,
  SettingsResponse,
  Snapshot,
  RuntimeProgressEvent,
} from './types';
import { useThemePreference } from './theme';
import { clearSnapshotCache, getMemorySnapshot, readCachedSnapshot, removeSnapshotCache, writeSnapshotCache } from './snapshot-cache';
import { SketchDoodle } from './SketchDoodle';
import { FieldIllustration, FieldMark, FieldScene } from './FieldIllustration';
import { InkOutline } from './InkOutline';
import { PaperScroll } from './PaperScroll';
import { ProviderModelList } from './ProviderModelList';
import './index.css';

function ProjectGitHubLink({ compact = false }: { compact?: boolean }) {
  const label = t('在GitHub查看源码，或点个Star :D');
  return <a className={`project-github-link${compact ? ' compact' : ''}`}
    href="https://github.com/Yecernia/what-the-repo" target="_blank" rel="noopener noreferrer"
    aria-label={label} title={label}>
    <img className="github-login-icon" src="/github.svg" alt="" />
    <span className="project-github-label">GitHub <span aria-hidden="true">↗</span></span>
  </a>;
}

const BARE_FILE_REFERENCE_NAMES = new Set([
  '.dockerignore', '.env', '.gitignore', '.npmrc', '.prettierrc', '.yarnrc',
  'containerfile', 'dockerfile', 'gemfile', 'gnumakefile', 'gradlew', 'license', 'makefile', 'mvnw', 'pipfile', 'procfile', 'rakefile', 'readme',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum',
]);
const BARE_FILE_REFERENCE_EXTENSIONS = new Set([
  'lock', 'orig', 'resolved', 'lockb', 'hcl', 'baseline', 'bazel', 'toml', 'cfg', 'conf', 'cmd',
]);

interface MarkdownFileReference {
  path: string;
  line: number | null;
  endLine: number | null;
}

type MessageEvidence = Message['evidence'][number];

function normalizeReferencePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function evidenceLineMatches(evidence: MessageEvidence, line: number | null): boolean {
  if (line === null) return true;
  const start = evidence.start_line;
  const end = evidence.end_line ?? start;
  return typeof start === 'number'
    && line >= start
    && (typeof end !== 'number' || line <= end);
}

function resolveMessageEvidence(
  evidence: MessageEvidence[],
  reference: MarkdownFileReference,
): MessageEvidence | undefined {
  const requested = normalizeReferencePath(reference.path);
  if (!requested) return undefined;
  const byPath = (candidate: MessageEvidence) => normalizeReferencePath(candidate.path) === requested;
  const bySuffix = (candidate: MessageEvidence) => {
    const candidatePath = normalizeReferencePath(candidate.path);
    return candidatePath.endsWith(`/${requested}`);
  };
  const byBasename = (candidate: MessageEvidence) => {
    const candidatePath = normalizeReferencePath(candidate.path);
    return !requested.includes('/') && candidatePath.split('/').at(-1) === requested;
  };
  const pick = (candidates: MessageEvidence[]): MessageEvidence | undefined => {
    if (new Set(candidates.map(candidate => normalizeReferencePath(candidate.path))).size !== 1) return undefined;
    const lineMatches = candidates.filter(candidate => evidenceLineMatches(candidate, reference.line));
    return reference.line === null ? candidates[0] : lineMatches[0];
  };

  return pick(evidence.filter(byPath))
    ?? pick(evidence.filter(bySuffix))
    ?? pick(evidence.filter(byBasename));
}

function shortReferencePath(path: string, evidence: MessageEvidence[]): string {
  const parts = normalizeReferencePath(path).split('/');
  const paths = new Set(evidence.map(item => normalizeReferencePath(item.path)));
  for (let count = 1; count < parts.length; count += 1) {
    const suffix = parts.slice(-count).join('/');
    if (![...paths].some(candidate => candidate !== normalizeReferencePath(path)
      && (candidate === suffix || candidate.endsWith(`/${suffix}`)))) return suffix;
  }
  return parts.join('/');
}

function activityCacheKey(projectId: string, messageId: string): string {
  return `${projectId}:${messageId}`;
}

function markdownFileReference(value: string): MarkdownFileReference | null {
  let reference = value.trim();
  if (!reference || reference.includes('\n') || reference.length > 240) return null;
  reference = reference.replace(/^[([{<'"`]+/, '').replace(/[\]),.;!?，。；！？}>"'`]+$/, '');
  if (!reference) return null;

  const suffix = reference.match(/(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?|:(\d+):\d+)$/i);
  const path = suffix ? reference.slice(0, suffix.index).trim() : reference;
  if (!path || /:\/\//.test(path) || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return null;
  if (path.endsWith('/') || path.split(/[\\/]/).some(part => part === '..') || !/^[A-Za-z0-9_@+$~./\\-]+$/.test(path)) return null;

  const fileName = path.split(/[\\/]/).pop() ?? path;
  const language = languageFromPath(path);
  const knownBareName = BARE_FILE_REFERENCE_NAMES.has(fileName.toLowerCase())
    || /^dockerfile(?:\.|$)/i.test(fileName)
    || (fileName.startsWith('.') && BARE_FILE_REFERENCE_EXTENSIONS.has(fileName.split('.').at(-1)?.toLowerCase() ?? ''));
  const hasExtension = fileName.includes('.') && !fileName.startsWith('.');
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const looksLikeFile = knownBareName
    || (hasExtension && (
      hasLanguageGlyph(language)
      || BARE_FILE_REFERENCE_EXTENSIONS.has(extension)
      || /[\\/]/.test(path)
    ));
  if (!looksLikeFile) return null;

  const line = suffix ? Number(suffix[1] ?? suffix[3] ?? suffix[5]) : null;
  const endLine = suffix ? Number(suffix[2] ?? suffix[4] ?? line) : null;
  if (line !== null && (endLine === null || !Number.isInteger(line) || line < 1
    || !Number.isInteger(endLine) || endLine < line)) return null;
  return { path, line, endLine };
}

function MarkdownFileReferenceButton({
  reference,
  text,
  onOpen,
}: {
  reference: MarkdownFileReference;
  text: string;
  onOpen: (reference: MarkdownFileReference) => void;
}) {
  const lineLabel = reference.line === null
    ? ''
    : reference.endLine && reference.endLine !== reference.line
      ? `:${reference.line}-${reference.endLine}`
      : `:${reference.line}`;
  return (
    <button
      type="button"
      className="markdown-file-reference"
      aria-label={t("打开源码 {0}{1}", reference.path, lineLabel)}
      title={reference.path + lineLabel}
      onClick={() => onOpen(reference)}
    >
      <LanguageGlyph language={languageFromPath(reference.path)} />
      <code>{text}</code>
    </button>
  );
}

function MarkdownFileReferenceLabel({
  reference,
  text,
}: {
  reference: MarkdownFileReference;
  text: string;
}) {
  return (
    <span className="markdown-file-reference-label" title={reference.path}>
      <LanguageGlyph language={languageFromPath(reference.path)} />
      <code>{text}</code>
    </span>
  );
}

const MarkdownCode = memo(function MarkdownCode({ value, className }: { value: string; className?: string }) {
  const highlighted = highlightedMarkdownCode(value.replace(/\n$/, ''), className);
  return highlighted
    ? <code className={`hljs${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
    : <code className={className}>{value}</code>;
});

function createMarkdownComponents(onFileReference: (reference: MarkdownFileReference) => void, evidence: MessageEvidence[], unresolved: string[]): MarkdownComponents {
  const renderFileReference = (reference: MarkdownFileReference, text: string) => {
    const suffix = reference.line === null ? '' : `:${reference.line}${reference.endLine !== reference.line ? `-${reference.endLine}` : ''}`;
    const resolved = unresolved.includes(reference.path + suffix) ? undefined : resolveMessageEvidence(evidence, reference);
    const canonical = resolved ? { ...reference, path: resolved.path } : reference;
    const label = resolved ? shortReferencePath(resolved.path, evidence) + suffix : text;
    return resolved && reference.line !== null
      ? <MarkdownFileReferenceButton reference={canonical} text={label} onOpen={onFileReference} />
      : <MarkdownFileReferenceLabel reference={canonical} text={label} />;
  };
  return {
    a: ({ children, href }) => {
      const text = String(children ?? '');
      const reference = markdownFileReference(text) ?? (href ? markdownFileReference(href) : null);
      return reference
        ? renderFileReference(reference, text || reference.path)
        : <span>{children}</span>;
    },
    img: ({ alt }) => <span>{alt ? t("[图片：{0}]", alt) : t("[图片已省略]")}</span>,
    code: ({ children, className }) => {
      const text = String(children ?? '').replace(/\n$/, '');
      const reference = className ? null : markdownFileReference(text);
      return reference
        ? renderFileReference(reference, text)
        : <MarkdownCode value={String(children ?? '')} className={className} />;
    },
  };
}

const REVIEW_PREFERENCE_KEY = 'what-the-repo-review-evidence:v1';
const CHAT_PANE_MIN_WIDTH = 420;
const PANE_RESIZER_WIDTH = 5;
const REPOSITORY_PANE_MARGIN = 10;
const REPOSITORY_MIN_WIDTH = 560;
const REPOSITORY_DEFAULT_WIDTH = 760;
const ICP_RECORD_URL = 'https://beian.miit.gov.cn/';

function ComplianceFooter() {
  const record = import.meta.env.VITE_ICP_RECORD?.trim();
  if (!record) return null;
  return (
    <footer className="site-compliance-footer" aria-label={t("网站备案信息")}>
      <a href={ICP_RECORD_URL} target="_blank" rel="noreferrer">{record}</a>
    </footer>
  );
}

const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css',
  docker: 'dockerfile', dockerfile: 'dockerfile', go: 'go', h: 'c', hpp: 'cpp', html: 'xml',
  java: 'java', js: 'javascript', cjs: 'javascript', mjs: 'javascript', json: 'json', jsx: 'javascript',
  md: 'markdown', mdx: 'markdown', php: 'php', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', fish: 'bash', sql: 'sql',
  ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml', jl: 'julia', erl: 'erlang', hrl: 'erlang', ex: 'elixir', exs: 'elixir', hs: 'haskell', lhs: 'haskell', vb: 'vbscript', vbs: 'vbscript',
  conf: 'ini', ini: 'ini', toml: 'ini', env: 'ini', ps1: 'powershell',
};

function sourceLanguage(path: string): string {
  const extension = languageFromPath(path);
  return SOURCE_LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

function highlightedSourceLine(value: string, language: string): string {
  return hljs.highlight(value || ' ', { language, ignoreIllegals: true }).value;
}

const MARKDOWN_LANGUAGE_ALIASES: Record<string, string> = {
  c: 'c', cpp: 'cpp', csharp: 'csharp', cs: 'csharp', css: 'css',
  docker: 'dockerfile', dockerfile: 'dockerfile', go: 'go', html: 'xml',
  ini: 'ini', java: 'java', javascript: 'javascript', js: 'javascript',
  json: 'json', jsx: 'javascript', markdown: 'markdown', md: 'markdown',
  php: 'php', powershell: 'powershell', ps1: 'powershell', python: 'python', py: 'python',
  ruby: 'ruby', rb: 'ruby', rust: 'rust', rs: 'rust', sh: 'bash', shell: 'bash',
  sql: 'sql', ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  xml: 'xml', yaml: 'yaml', yml: 'yaml',
};

function highlightedMarkdownCode(value: string, className?: string): string | null {
  const languageToken = className?.match(/(?:^|\s)language-([\w+-]+)/i)?.[1]?.toLowerCase();
  const language = languageToken ? MARKDOWN_LANGUAGE_ALIASES[languageToken] : undefined;
  const isBlock = Boolean(languageToken) || value.includes('\n');
  if (!isBlock) return null;
  try {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(value || ' ', { language, ignoreIllegals: true }).value
      : hljs.highlightAuto(value || ' ').value;
  } catch {
    return null;
  }
}



function ShinyText({ text, className = '' }: { text: string; className?: string }) {
  return <span className={`shiny-text ${className}`}>{text}</span>;
}

const PROVIDER_ICON_TONES: Record<string, string> = {
  openai: 'provider-icon-openai',
  anthropic: 'provider-icon-anthropic',
  deepseek: 'provider-icon-deepseek',
  google: 'provider-icon-google',
  moonshotai: 'provider-icon-moonshot',
  qwen: 'provider-icon-qwen',
  zai: 'provider-icon-zhipu',
  xai: 'provider-icon-xai',
  glm: 'provider-icon-zhipu',
  kimi: 'provider-icon-kimi',
  minimax: 'provider-icon-minimax',
  mimo: 'provider-icon-mimo',
  xiaomi: 'provider-icon-mimo',
  doubao: 'provider-icon-doubao',
  hunyuan: 'provider-icon-hunyuan',
  custom: 'provider-icon-custom',
};

const PROVIDER_ICON_ASSETS: Record<string, string> = {
  openai: '/providers/openai.svg',
  anthropic: '/providers/claude.svg',
  google: '/providers/google.svg',
  deepseek: '/providers/deepseek-color.png',
  qwen: '/providers/qwen-color.png',
  'qwen-token-plan': '/providers/qwen-color.png',
  'qwen-token-plan-cn': '/providers/qwen-color.png',
  'qwen-token-plan-individual': '/providers/qwen-color.png',
  'qwen-token-plan-personal-cn': '/providers/qwen-color.png',
  'qwen-token-plan-team-cn': '/providers/qwen-color.png',
  'qwen-coding-plan-cn': '/providers/qwen-color.png',
  'qwen-api-cn': '/providers/qwen-color.png',
  'qwen-api-intl': '/providers/qwen-color.png',
  zai: '/providers/zai-user.svg',
  glm: '/providers/zai-user.svg',
  'zai-api-cn': '/providers/zai-user.svg',
  'zai-coding-global': '/providers/zai-user.svg',
  'zai-coding-cn': '/providers/zai-user.svg',
  moonshotai: '/providers/kimi-user.webp',
  kimi: '/providers/kimi-user.webp',
  'moonshotai-cn': '/providers/kimi-user.webp',
  'kimi-coding': '/providers/kimi-user.webp',
  minimax: '/providers/minimax-color.png',
  'minimax-cn': '/providers/minimax-color.png',
  'minimax-token-plan-cn': '/providers/minimax-color.png',
  xiaomi: '/providers/xiaomimimo.png',
  'xiaomi-token-plan-cn': '/providers/xiaomimimo.png',
  'xiaomi-token-plan-ams': '/providers/xiaomimimo.png',
  'xiaomi-token-plan-sgp': '/providers/xiaomimimo.png',
  doubao: '/providers/doubao-color.png',
  'doubao-coding-plan-cn': '/providers/doubao-color.png',
  'doubao-agent-plan-cn': '/providers/doubao-color.png',
  hunyuan: '/providers/hunyuan-color.png',
  'hunyuan-tokenhub-api-cn': '/providers/hunyuan-color.png',
  'hunyuan-token-plan-cn': '/providers/hunyuan-color.png',
  'hunyuan-token-plan-enterprise-cn': '/providers/hunyuan-color.png',
  'hunyuan-coding-plan-cn': '/providers/hunyuan-color.png',
  xai: '/providers/grok.svg',
};

// Keep the color treatment consistent even when a provider has no image
// (legacy connections may still use the initials fallback).

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'GPT',
  anthropic: 'Claude',
  google: 'Gemini',
  deepseek: 'DeepSeek',
  zai: 'GLM',
  glm: 'GLM',
  moonshotai: 'Kimi',
  xai: 'Grok',
  qwen: '千问',
  minimax: 'MiniMax',
  mimo: 'MiMo',
  xiaomi: 'MiMo',
  doubao: '豆包',
  hunyuan: '混元',
  custom: '自定义接口',
};

const PROVIDER_DEFAULT_LABELS: Record<string, string[]> = {
  openai: ['openai', 'OpenAI（GPT）', 'OpenAI (GPT)'],
  anthropic: ['anthropic', 'Anthropic（Claude）', 'Anthropic (Claude)'],
  google: ['google', 'Google（Gemini）', 'Google (Gemini)'],
  deepseek: ['deepseek', 'DeepSeek'],
  zai: ['zai', '智谱（GLM）', '智谱 (GLM)'],
  glm: ['glm', '智谱 GLM', '智谱（GLM）'],
  moonshotai: ['moonshotai', '月之暗面（Kimi）', '月之暗面 (Kimi)'],
  xai: ['xai', 'xAI（Grok）', 'xAI (Grok)'],
  qwen: ['qwen', '通义千问'],
  minimax: ['minimax', 'MiniMax'],
  mimo: ['mimo', '小米 MiMo'],
  xiaomi: ['xiaomi', '小米 MiMo'],
  doubao: ['doubao', '豆包'],
  hunyuan: ['hunyuan', '腾讯混元'],
  custom: ['custom', '自定义 OpenAI 兼容接口'],
};

const HIDDEN_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'xai']);

function providerIconKey(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (PROVIDER_ICON_ASSETS[normalized]) return normalized;
  if (/^deepseek(?:[-_]|$)/.test(normalized)) return 'deepseek';
  if (/^(zai|glm)(?:[-_]|$)/.test(normalized)) return 'zai';
  if (/^(moonshotai|kimi)(?:[-_]|$)/.test(normalized)) return 'moonshotai';
  if (/^qwen(?:[-_]|$)/.test(normalized)) return 'qwen';
  if (/^minimax(?:[-_]|$)/.test(normalized)) return 'minimax';
  if (/^(xiaomi|mimo)(?:[-_]|$)/.test(normalized)) return 'xiaomi';
  if (/^doubao(?:[-_]|$)/.test(normalized)) return 'doubao';
  if (/^hunyuan(?:[-_]|$)/.test(normalized)) return 'hunyuan';
  return normalized || provider;
}

function providerDisplayName(provider: string, fallback = provider): string {
  return PROVIDER_DISPLAY_NAMES[provider] ? t(PROVIDER_DISPLAY_NAMES[provider]) : fallback;
}

function providerFamilyDisplayName(family: string, fallback: string): string {
  return providerDisplayName(family, fallback)
    .replace(/^智谱\s*/i, '')
    .replace(/^腾讯\s*/i, '')
    .replace(/^小米\s*/i, '')
    .trim();
}

type ProviderPresetOption = SettingsResponse['provider_presets'][number];

function providerFamilyId(preset: ProviderPresetOption): string {
  return preset.family || preset.id;
}

function providerFamilyOptions(presets: ProviderPresetOption[]): ProviderPresetOption[] {
  const seen = new Set<string>();
  const families = presets.filter(preset => {
    if (HIDDEN_PROVIDER_IDS.has(preset.id)) return false;
    const family = providerFamilyId(preset);
    if (seen.has(family)) return false;
    seen.add(family);
    return true;
  });
  const preferredOrder = ['deepseek', 'hunyuan', 'qwen', 'kimi', 'doubao', 'mimo', 'minimax', 'glm'];
  return families.sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(providerFamilyId(left));
    const rightIndex = preferredOrder.indexOf(providerFamilyId(right));
    return (leftIndex < 0 ? preferredOrder.length : leftIndex)
      - (rightIndex < 0 ? preferredOrder.length : rightIndex);
  });
}

function providerVariantOptions(presets: ProviderPresetOption[], family: string): ProviderPresetOption[] {
  return presets.filter(preset => !HIDDEN_PROVIDER_IDS.has(preset.id) && providerFamilyId(preset) === family);
}

function summaryUpdatedLabel(value: string | null | undefined): string {
  if (!value) return t("尚未生成");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("最近更新");
  return t("更新于 {0}", date.toLocaleString(getUiLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
}

function connectionDisplayName(provider: string, label: string): string {
  return PROVIDER_DEFAULT_LABELS[provider]?.includes(label)
    ? providerDisplayName(provider, label)
    : label;
}

function friendlyModelOptionLabel(label: string, provider?: string): string {
  if (!provider) return label;
  const prefixes = PROVIDER_DEFAULT_LABELS[provider] ?? [];
  const matched = prefixes.find(prefix => label === prefix || label.startsWith(`${prefix} / `));
  return matched ? `${providerDisplayName(provider)}${label.slice(matched.length)}` : label;
}

function ProviderIcon({ provider, label, size = 'md' }: { provider: string; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  const initials = (label || provider || '?').slice(0, 2).toUpperCase();
  const iconKey = providerIconKey(provider);
  const asset = PROVIDER_ICON_ASSETS[iconKey];
  return <span className={`provider-icon ${PROVIDER_ICON_TONES[iconKey] ?? 'provider-icon-custom'} provider-icon-${size}`} aria-hidden="true">
    {asset ? <img className="provider-icon-glyph" src={asset} alt="" /> : initials}
  </span>;
}

interface SketchSelectOption {
  value: string;
  label: string;
}

function SketchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false,
  className = '',
  menuTitle,
}: {
  value: string;
  options: SketchSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  menuTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find(option => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div ref={rootRef} className={`sketch-select${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
    <button type="button" role="combobox" className="sketch-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId}
      disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span>{selected?.label ?? value}</span><ChevronDownSketch size={15} aria-hidden="true" />
    </button>
    {open && <div id={listboxId} className="sketch-select-menu" role="listbox" aria-label={ariaLabel}>
      {menuTitle && <div className="sketch-select-menu-title">{menuTitle}</div>}
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value}
        className={option.value === value ? 'active' : ''} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{option.value === value && <Check size={13} />}
      </button>)}
    </div>}
  </div>;
}

function formatElapsed(milliseconds: number, live = false): string {
  const seconds = live
    ? Math.max(0, Math.floor(milliseconds / 1000))
    : Math.max(1, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}

function modelLabel(model: string, settings: SettingsResponse | null): string {
  if (settings && model === settings.free_experience_model) {
    return t("{0}（免费体验）", settings.free_experience_provider_model);
  }
  const option = settings?.model_options.find(item => item.selector === model);
  return option ? friendlyModelOptionLabel(option.label, option.provider) : model;
}

function modelReady(model: string, settings: SettingsResponse | null): boolean {
  if (!model || !settings) return false;
  if (model === settings.free_experience_model) return settings.free_experience_configured;
  const option = settings.model_options.find(item => item.selector === model)
    ?? settings.model_options.find(item => item.model_id === model);
  if (option) {
    return settings.providers.some(connection => (
      connection.connection_id === option.connection_id && connection.has_api_key
    ));
  }
  // Compatibility for projects saved before connection-qualified selectors.
  // Current API responses always include model_options, so multi-key decisions
  // still use the exact connection branch above.
  return settings.available_models.includes(model) && settings.has_api_key;
}

function thinkingLevelLabel(level: import('./types').ThinkingLevel): string {
  return level === 'off' ? t("关闭")
    : level === 'minimal' ? t("极低")
      : level === 'low' ? t("低")
        : level === 'medium' ? t("中")
          : level === 'high' ? t("高")
            : level === 'xhigh' ? t("极高")
              : t("最大");
}

function ConversationModelSelect({
  value,
  availableModels,
  settings,
  onChange,
  disabled = false,
}: {
  value: string;
  availableModels: string[];
  settings: SettingsResponse | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = settings?.model_options ?? [];
  const selected = options.find(option => option.selector === value);
  const selectedLabel = selected?.model_id ?? modelLabel(value, settings);
  const freeExperience = settings && settings.free_experience_configured
    && availableModels.includes(settings.free_experience_model)
    ? { value: settings.free_experience_model, label: t("{0}（免费体验）", settings.free_experience_provider_model) }
    : null;
  const uiLanguage = useUiLanguage();
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof options>();
    for (const option of options) {
      // The deployment-provided DeepSeek model is rendered as the dedicated
      // free-experience row above, so it must not appear as a connection group.
      if (option.connection_id === 'deployment-free' || option.selector === settings?.free_experience_model) continue;
      const current = grouped.get(option.connection_id) ?? [];
      current.push(option);
      grouped.set(option.connection_id, current);
    }
    const ordered = [...grouped.entries()];
    const connectionOrder = new Map((settings?.providers ?? []).map((connection, index) => [connection.connection_id, index]));
    ordered.sort((left, right) => (connectionOrder.get(left[0]) ?? Number.MAX_SAFE_INTEGER) - (connectionOrder.get(right[0]) ?? Number.MAX_SAFE_INTEGER));
    return ordered.map(([connectionId, modelOptions]) => {
      const connection = settings?.providers.find(item => item.connection_id === connectionId);
      const label = connection
        ? connectionDisplayName(connection.provider, connection.label)
        : providerDisplayName(modelOptions[0]?.provider ?? connectionId, connectionId);
      return { connectionId, label, modelOptions };
    });
  }, [options, settings, uiLanguage]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActiveConnectionId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setActiveConnectionId(null);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const activeGroup = groups.find(group => group.connectionId === activeConnectionId) ?? null;
  const closeMenu = () => {
    setOpen(false);
    setActiveConnectionId(null);
  };
  return (
    <div ref={rootRef} className="sketch-select compact composer-model-select model-picker">
      <button type="button" role="combobox" className="sketch-select-trigger" aria-label={t("本项目模型")}
        aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen(current => !current)}>
        <ActivityIcon className="narrow-model-icon" name="model" size={24} /><span className="wide-model-label">
          <span>{selected?.connection_id === 'deployment-free' ? t('{0}（免费体验）', selected.model_id) : selectedLabel}</span>
          <ChevronDownSketch size={15} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="sketch-select-menu model-picker-menu" role="listbox" aria-label={t("本项目模型")}>
          {activeGroup ? (
            <>
              <button type="button" className="model-picker-back" onClick={() => setActiveConnectionId(null)}>
                <ChevronLeft size={14} /> <span>{activeGroup.label}</span>
              </button>
              {activeGroup.modelOptions.map(option => (
                <button key={option.selector} type="button" role="option" aria-selected={option.selector === value}
                  className={option.selector === value ? 'active' : ''}
                  onClick={() => { onChange(option.selector); closeMenu(); }}>
                  <span>{option.model_id}</span>
                  {option.selector === value && <Check size={13} />}
                </button>
              ))}
            </>
          ) : (
            <>
              {freeExperience && (
                <button type="button" role="option" aria-selected={freeExperience.value === value}
                  onClick={() => { onChange(freeExperience.value); closeMenu(); }}
                  className={freeExperience.value === value ? 'active' : ''}>
                  <span>{freeExperience.label}</span>{freeExperience.value === value && <Check size={13} />}
                </button>
              )}
              {groups.map(group => (
                <button key={group.connectionId} type="button" role="option"
                  aria-selected={selected?.connection_id === group.connectionId}
                  className={selected?.connection_id === group.connectionId ? 'active' : ''}
                  aria-label={t("选择配置 {0}", group.label)} onClick={() => setActiveConnectionId(group.connectionId)}>
                  <span>{group.label}</span>{selected?.connection_id === group.connectionId && <Check size={13} />}<ChevronRight size={14} />
                </button>
              ))}
              {!freeExperience && !groups.length && availableModels.map(item => (
                <button key={item} type="button" role="option" aria-selected={item === value}
                  className={item === value ? 'active' : ''} onClick={() => { onChange(item); closeMenu(); }}>
                  <span>{item}</span>{item === value && <Check size={13} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function thinkingSelectOptions(
  levels: import('./types').ThinkingLevel[],
  mode: 'pi' | 'provider-default',
): Array<{ value: import('./types').ThinkingLevel; label: string }> {
  if (mode === 'provider-default') return [{ value: 'off', label: t("{0}默认", '') }];
  return levels.map(level => ({ value: level, label: thinkingLevelLabel(level) }));
}

function thinkingModeForOption(option: { connection_id?: string; thinking_mode?: 'pi' | 'provider-default' } | null | undefined): 'pi' | 'provider-default' {
  if (option?.thinking_mode) return option.thinking_mode;
  // Missing capability metadata is intentionally conservative: let the
  // upstream choose its default instead of presenting an explicit "off".
  return 'provider-default';
}

function verificationDisplayMessage(message: string): string {
  const normalized = message.trim().replace(/^(?:(?:模型连接)?验证失败[：:]\s*)+/u, '');
  const count = /^验证成功，已读取 (\d+) 个可对话模型$/.exec(normalized);
  if (count) return t('验证成功，已读取 {0} 个可对话模型', count[1]);
  return normalized ? t(normalized) : t("服务连接失败，请稍后重试。");
}

type ActivityPhase = {
  key: ActivityPhaseKey;
  latest: RuntimeProgressEvent;
  events: RuntimeProgressEvent[];
};

function groupActivityPhases(events: RuntimeProgressEvent[]): ActivityPhase[] {
  const phaseIndexes = new Map<ActivityPhaseKey, number>();
  return events.reduce<ActivityPhase[]>((phases, event) => {
    const key = activityPhaseKey(event);
    const existingIndex = phaseIndexes.get(key);
    if (existingIndex !== undefined) {
      const existing = phases[existingIndex];
      existing.latest = event;
      existing.events.push(event);
      return phases;
    }
    phaseIndexes.set(key, phases.length);
    phases.push({ key, latest: event, events: [event] });
    return phases;
  }, []);
}

function largestMentionedCount(events: RuntimeProgressEvent[], patterns: RegExp[]): number | null {
  let count: number | null = null;
  for (const event of events) {
    const source = `${event.label} ${event.text ?? ''}`;
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      const value = Number(match?.[1]);
      if (Number.isFinite(value) && value >= 0) count = Math.max(count ?? 0, value);
    }
  }
  return count;
}

function activityPhaseDetail(phase: ActivityPhase): string | null {
  if (phase.key === 'repository' || phase.key === 'evidence') {
    const files = largestMentionedCount(phase.events, [
      /(?:查阅|读取|定位|找到|发现|涉及|共)\s*(\d+)\s*(?:个|份|处)?\s*(?:相关)?文件/,
      /(\d+)\s*(?:个|份|处)?\s*(?:相关)?文件/,
    ]);
    if (files !== null) return t("已找到 {0} 个相关文件", files);
  }
  if (phase.key === 'architecture') {
    const relations = largestMentionedCount(phase.events, [/(\d+)\s*条(?:调用)?关系/]);
    if (relations !== null) return t("已整理 {0} 条调用关系", relations);
  }
  return null;
}

function completedActivityLabel(phases: ActivityPhase[], fileCount?: number): string {
  if (fileCount !== undefined && fileCount > 0) return t("回答完成 · 参考 {0} 个文件", fileCount);
  const allEvents = phases.flatMap(phase => phase.events);
  const files = largestMentionedCount(allEvents, [
    /(?:查阅|读取|定位|找到|发现|涉及|共)\s*(\d+)\s*(?:个|份|处)?\s*(?:相关)?文件/,
    /(\d+)\s*(?:个|份|处)?\s*(?:相关)?文件/,
  ]);
  if (files !== null) return t("回答完成 · 参考 {0} 个文件", files);
  const relations = largestMentionedCount(allEvents, [/(\d+)\s*条(?:调用)?关系/]);
  if (relations !== null) return t("回答完成 · 找到 {0} 条关系", relations);
  if (phases.some(phase => ['evidence', 'repository', 'architecture'].includes(phase.key))) {
    return t("回答完成");
  }
  return t("已完成");
}

function messageEvidenceFileCount(message: Message): number {
  return new Set(
    message.evidence
      .map(evidence => evidence.path.trim())
      .filter(Boolean),
  ).size;
}

interface PendingConversationInfo {
  optimisticId: string;
  startedAt: number;
  optimisticUser: Message;
  replaceMessageId?: string;
}

function sortMessagesByCreatedAt(messages: Message[]): Message[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.message.created_at);
      const rightTime = Date.parse(right.message.created_at);
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) {
        return left.index - right.index;
      }
      return leftTime - rightTime;
    })
    .map(item => item.message);
}

function mergeLocalMessages(
  authoritative: Project,
  current: Project | null,
  pending?: PendingConversationInfo,
): Project {
  if (current && current.project_id !== authoritative.project_id) return authoritative;
  if (pending?.replaceMessageId) {
    const index = authoritative.messages.findIndex(message => message.message_id === pending.replaceMessageId);
    if (index >= 0) return { ...authoritative, messages: [...authoritative.messages.slice(0, index), pending.optimisticUser] };
  }
  const authoritativeIds = new Set(authoritative.messages.map(message => message.message_id));
  const cachedPending = current?.messages.find(message => message.message_id === pending?.optimisticId);
  const pendingMessage = cachedPending && !cachedPending.error
    ? cachedPending
    : pending?.optimisticUser;
  const localMessages = pendingMessage
    && !authoritativeIds.has(pendingMessage.message_id)
    && !authoritative.messages.some(candidate => (
      candidate.role === 'user'
      && candidate.content === pendingMessage.content
      && Number.isFinite(Date.parse(candidate.created_at))
      && Number.isFinite(Date.parse(pendingMessage.created_at))
      && Date.parse(candidate.created_at) >= Date.parse(pendingMessage.created_at) - 1_000
    ))
    ? [pendingMessage]
    : [];
  if (localMessages.length === 0) return authoritative;
  return { ...authoritative, messages: sortMessagesByCreatedAt([...authoritative.messages, ...localMessages]) };
}

function mergeResponseMessages(
  current: Project,
  optimisticId: string,
  incoming: Message[],
  replaceMessageId?: string,
): Project {
  const replacementIndex = replaceMessageId ? current.messages.findIndex(message => message.message_id === replaceMessageId) : -1;
  if (replacementIndex >= 0) current = { ...current, messages: current.messages.slice(0, replacementIndex) };
  const incomingIds = new Set(incoming.map(message => message.message_id));
  const messages = [
    ...current.messages.filter(message => (
      message.message_id !== optimisticId
      && !incomingIds.has(message.message_id)
    )),
    ...incoming,
  ];
  return { ...current, messages: sortMessagesByCreatedAt(messages) };
}

interface PendingConversation extends PendingConversationInfo {
  token: string;
  runId: string | null;
  activity: RuntimeProgressEvent[];
  streamingAssistant: Message;
}

function stripTransientMessages(project: Project): Project {
  const messages = project.messages.filter(message => !message.message_id.startsWith('client:'));
  return messages.length === project.messages.length ? project : { ...project, messages };
}

function analysisTimerKey(projectId: string, jobId: string | null): string {
  return `${projectId}:${jobId ?? 'pending'}`;
}

function stageLabel(stage: string) {
  const m: Record<string, string> = {
    idle: t("等待分析"), fetching: t("获取源码…"), scanning: t("扫描…"),
    extracting: t("解析…"), clustering: t("整理组件…"), interpreting: t("分析架构…"),
    done: t("已分析"), failed: t("分析失败"),
  };
  return m[stage] ?? stage;
}

function messagePreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact;
}

function analysisProgressRuntimeEvents(analysis: AnalysisState): RuntimeProgressEvent[] {
  return (analysis.progress_events ?? []).map(event => {
    const labels = analysisProgressLabels[event.kind] ?? [t("正在分析仓库"), t("当前步骤已完成")];
    const label = event.status === 'failed' ? t("分析未完成") : event.status === 'running' ? labels[0] : labels[1];
    return {
      stage: `analysis:${event.kind}:${event.sequence}`,
      label: t(label),
      status: ['skipped', 'degraded', 'reused'].includes(event.status) ? 'completed' : event.status as RuntimeProgressEvent['status'],
      analysis_progress: event,
      elapsed_ms: event.elapsed_ms,
      sequence: event.sequence,
      timestamp: event.timestamp,
      event_type: 'analysis_progress',
      kind: 'summary',
    };
  });
}

function mergeAnalysisProgressEvents(
  current: RuntimeProgressEvent[],
  next: RuntimeProgressEvent,
): RuntimeProgressEvent[] {
  if (next.visible === false) return current;
  const nextKey = analysisStageKey(next);
  if (!nextKey || next.event_type === 'analysis_progress') return mergeProgressEvents(current, next);

  // Polling can emit the same analysis stage again with a different job status.
  // Replace that stage in place so a completed and running row never coexist.
  const replaced: RuntimeProgressEvent[] = [];
  let found = false;
  for (const event of current) {
    if (analysisStageKey(event) !== nextKey) {
      replaced.push(event);
    } else if (!found) {
      replaced.push(next);
      found = true;
    }
  }
  if (found) return replaced;

  const settled = current.map(event => (
    analysisStageKey(event) && event.status === 'running'
      ? { ...event, status: 'completed' as const }
      : event
  ));
  return mergeProgressEvents(settled, next);
}

function SettingsDialog({
  onClose,
  identity,
}: {
  onClose: () => void;
  identity: IdentityResponse;
}) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [providerId, setProviderId] = useState('deepseek');
  const [connectionId, setConnectionId] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [connectionDialog, setConnectionDialog] = useState<'new' | 'models' | null>(null);
  const [connectionMenuId, setConnectionMenuId] = useState<string | null>(null);
  const [connectionVerification, setConnectionVerification] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    message: string;
    models: string[];
  }>({ status: 'idle', message: '', models: [] });
  const [connectionVerificationToken, setConnectionVerificationToken] = useState('');
  const [verifiedConnectionInputKey, setVerifiedConnectionInputKey] = useState('');
  const [languages, setLanguages] = useState('');
  const [explanationPreference, setExplanationPreference] = useState('');
  const [memorySummaryDraft, setMemorySummaryDraft] = useState('');
  const [showMemorySummary, setShowMemorySummary] = useState(false);
  const memoryDialogRef = useRef<HTMLDivElement>(null);
  const memoryPreviewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (showMemorySummary) memoryDialogRef.current?.focus(); }, [showMemorySummary]);
  const closeMemorySummary = () => {
    setShowMemorySummary(false);
    requestAnimationFrame(() => memoryPreviewRef.current?.focus());
  };
  const [msg, setMsgText] = useState('');
  const [msgKind, setMsgKind] = useState<'success' | 'error'>('error');
  function setMsg(text: string, kind: 'success' | 'error' = 'error') {
    setMsgText(text);
    setMsgKind(kind);
  }
  const [loading, setLoading] = useState(false);

  function applyProfile(next: LearnerProfile) {
    setProfile(next);
    setMemorySummaryDraft(next.memory_summary ?? '');
  }

  useEffect(() => {
    Promise.all([apiClient.getSettings(), apiClient.getProfile()]).then(([s, p]) => {
      setSettings(s); setBaseUrl(s.base_url);
      const first = s.providers[0];
      if (first) {
        setConnectionId(first.connection_id); setProviderId(first.provider); setConnectionLabel(first.label);
        setBaseUrl(first.base_url ?? '');
      }
      applyProfile(p.profile);
      setLanguages(p.profile.languages.join(', '));
      setExplanationPreference(p.profile.explanation_preference);
    }).catch(e => setMsg(userFacingError(e, t("设置暂时无法加载，请稍后重试。"))));
  }, []);

  const connectionInputKey = `${providerId}\u0000${connectionLabel.trim()}\u0000${baseUrl.trim()}\u0000${apiKey}`;

  function invalidateNewConnectionVerification() {
    setConnectionVerificationToken('');
    setVerifiedConnectionInputKey('');
    if (connectionVerification.status !== 'idle') {
      setConnectionVerification({ status: 'idle', message: '', models: [] });
    }
  }

  async function verifyConnection(targetId = connectionId) {
    if (!targetId) return;
    setLoading(true);
    setConnectionVerification({ status: 'loading', message: t("正在验证并拉取模型列表…"), models: [] });
    try {
      const r = await apiClient.verifySettings(targetId);
      const message = r.ok ? r.message : verificationDisplayMessage(r.message);
      setConnectionVerification({
        status: r.ok ? 'success' : 'error',
        message,
        models: r.models,
      });
      const s = await apiClient.getSettings();
      setSettings(s);
      setConnectionMenuId(null);
      setMsg(r.ok ? t("已获取 {0} 个可用模型", r.models.length) : message, r.ok ? 'success' : 'error');
    } catch (e: unknown) {
      const message = verificationDisplayMessage(userFacingError(e, t("服务连接失败，请稍后重试。")));
      setConnectionVerification({ status: 'error', message, models: [] });
      setMsg(message);
    }
    setLoading(false);
  }

  async function verifyNewConnection(modelId?: string): Promise<boolean> {
    setLoading(true);
    setConnectionVerification(current => ({ ...current, status: 'loading', message: modelId ? t('正在验证模型…') : t("正在验证并拉取模型列表…") }));
    try {
      const r = await apiClient.verifyProviderConnection({
        ...(connectionDialog === 'models' ? { existing_connection_id: connectionId } : {
          provider: providerId, label: connectionLabel || undefined, base_url: baseUrl || undefined, api_key: apiKey,
        }),
        model_id: modelId,
        models: connectionVerification.models,
        verification_token: connectionVerificationToken || undefined,
      });
      const message = modelId ? t(r.message) : verificationDisplayMessage(r.message);
      if (!r.ok || !r.verification_token) {
        setConnectionVerification(current => ({ ...current, status: 'error', message }));
      } else {
        setConnectionVerificationToken(r.verification_token);
        setVerifiedConnectionInputKey(connectionInputKey);
        setConnectionVerification({ status: 'success', message, models: r.models });
      }
      setMsg('');
      return Boolean(r.ok && r.verification_token);
    } catch (e: unknown) {
      setConnectionVerification(current => ({ ...current,
        status: 'error',
        message: verificationDisplayMessage(userFacingError(e, t("请检查 API Key、所选套餐和网络。"))),
      }));
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function addConnection() {
    if (connectionDialog === 'new' && !apiKey.trim()) {
      setConnectionVerification({ status: 'error', message: t("请先填写 API Key"), models: [] });
      return;
    }
    if (!connectionVerification.models.length || (connectionDialog === 'new' && (!connectionVerificationToken || verifiedConnectionInputKey !== connectionInputKey))) {
      setConnectionVerification(current => ({ ...current, status: 'error', message: t("请先获取或验证模型。") }));
      return;
    }
    setLoading(true);
    try {
      const s = connectionDialog === 'models' ? await apiClient.updateProviderModels(connectionId, {
        models: connectionVerification.models, verification_token: connectionVerificationToken || undefined,
      }) : await apiClient.addProviderConnection({
        provider: providerId,
        label: connectionLabel || undefined,
        base_url: baseUrl || undefined,
        api_key: apiKey,
        verification_token: connectionVerificationToken,
        models: connectionVerification.models,
      });
      setSettings(s);
      setApiKey('');
      setConnectionVerificationToken('');
      setVerifiedConnectionInputKey('');
      setConnectionVerification({ status: 'idle', message: '', models: [] });
      setConnectionDialog(null);
      setMsg(connectionDialog === 'models' ? t('模型列表已保存') : t("API 配置已添加"), 'success');
    } catch (e: unknown) {
      setConnectionVerification(current => ({ ...current,
        status: 'error',
        message: verificationDisplayMessage(userFacingError(e, t("API 配置添加失败，请稍后重试。"))),
      }));
    }
    setLoading(false);
  }

  async function removeConnection(targetId = connectionId) {
    if (!targetId) return;
    setLoading(true);
    try {
      const s = await apiClient.deleteProviderConnection(targetId);
      setSettings(s);
      const first = s.providers[0];
      setConnectionId(first?.connection_id ?? '');
      setMsg(t("API 配置已删除"), 'success');
    } catch (e: unknown) { setMsg(userFacingError(e, t("API 配置删除失败，请稍后重试。"))); }
    setLoading(false);
  }

  function selectConnection(id: string) {
    const connection = settings?.providers.find(item => item.connection_id === id);
    if (!connection) return;
    setConnectionId(id);
    setConnectionMenuId(null);
  }

  function selectProvider(next: string) {
    invalidateNewConnectionVerification();
    setProviderId(next);
    const preset = settings?.provider_presets.find(item => item.id === next);
    if (preset && next !== 'custom') setBaseUrl('');
    if (next === 'custom') setBaseUrl('');
  }

  function selectProviderFamily(family: string) {
    const preset = providerVariantOptions(settings?.provider_presets ?? [], family)[0];
    if (preset) selectProvider(preset.id);
  }

  function openNewConnection() {
    const preset = settings?.provider_presets[0];
    setConnectionId('');
    setProviderId(preset?.id ?? 'deepseek');
    setConnectionLabel('');
    setBaseUrl('');
    setApiKey('');
    setConnectionMenuId(null);
    setConnectionVerification({ status: 'idle', message: '', models: [] });
    setConnectionVerificationToken('');
    setVerifiedConnectionInputKey('');
    setMsg('');
    setConnectionDialog('new');
  }

  function closeConnectionDialog() {
    if (loading) return;
    setConnectionDialog(null);
    setConnectionVerification({ status: 'idle', message: '', models: [] });
    setConnectionVerificationToken('');
    setVerifiedConnectionInputKey('');
  }

  function openModelList(targetId: string) {
    const connection = settings?.providers.find(item => item.connection_id === targetId);
    if (!connection) return;
    setConnectionId(targetId);
    setProviderId(connection.provider);
    setConnectionLabel(connection.label);
    setApiKey('');
    setBaseUrl(connection.base_url ?? '');
    setConnectionMenuId(null);
    setConnectionVerification({ status: 'idle', message: '', models: connection.custom_models });
    setConnectionVerificationToken('');
    setVerifiedConnectionInputKey('');
    setConnectionDialog('models');
  }

  async function saveProfile() {
    setLoading(true);
    try {
      const response = await apiClient.updateProfile({
        enabled: profile?.enabled ?? true,
        languages: splitList(languages),
        explanation_preference: explanationPreference,
      });
      applyProfile(response.profile);
      setMsg(t("学习偏好已保存"), 'success');
    } catch (e: unknown) { setMsg(userFacingError(e, t("学习偏好保存失败，请稍后重试。"))); }
    setLoading(false);
  }

  async function toggleProfile() {
    if (!profile) return;
    setLoading(true);
    try {
      const response = await apiClient.updateProfile({
        enabled: !profile.enabled,
        languages: splitList(languages),
        explanation_preference: explanationPreference,
      });
      applyProfile(response.profile);
      setMsg(response.profile.enabled ? t("已启用个性化讲解") : t("已暂停个性化讲解"), 'success');
    } catch (e: unknown) { setMsg(userFacingError(e, t("学习偏好暂时未更新，请稍后重试。"))); }
    setLoading(false);
  }

  async function clearProfile() {
    setLoading(true);
    try {
      const response = await apiClient.clearProfile();
      applyProfile(response.profile);
      setLanguages(''); setExplanationPreference('');
      setMsg(t("学习信息已清空"), 'success');
    } catch (e: unknown) { setMsg(userFacingError(e, t("学习信息清空失败，请稍后重试。"))); }
    setLoading(false);
  }

  async function saveMemorySummary() {
    setLoading(true);
    try {
      const response = await apiClient.updateMemorySummary(memorySummaryDraft);
      applyProfile(response.profile);
      setMsg(t("记忆摘要已保存"), 'success');
    } catch (e: unknown) {
      setMsg(userFacingError(e, t("记忆摘要保存失败，请稍后重试。")));
    }
    setLoading(false);
  }

  async function regenerateMemorySummary() {
    setLoading(true);
    try {
      const response = await apiClient.regenerateMemorySummary();
      applyProfile(response.profile);
      setMsg(t("记忆摘要已重新整理"), 'success');
    } catch (e: unknown) {
      setMsg(userFacingError(e, t("记忆摘要暂时无法重新整理，请稍后重试。")));
    }
    setLoading(false);
  }

  const isOk = msgKind === 'success';
  const canManageApiKey = settings?.can_manage_api_key ?? false;
  const guestIdentity = identity.kind === 'guest';
  const providerPresets = settings?.provider_presets ?? [];
  const providerFamilies = providerFamilyOptions(providerPresets);
  const selectedPreset = providerPresets.find(item => item.id === providerId) ?? null;
  const selectedFamily = selectedPreset ? providerFamilyId(selectedPreset) : providerId;
  const providerVariants = providerVariantOptions(providerPresets, selectedFamily);

  return (
    <div className="settings-panel" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-dialog settings-page-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"
        inert={showMemorySummary} aria-hidden={showMemorySummary || undefined}><InkOutline paper />
        <PaperScroll>
        <div className="settings-heading">
          <div className="settings-title-wrap">
            <h2 id="settings-title">{t("设置")}</h2>
            <SketchDoodle variant="underline" className="settings-title-doodle" />
          </div>
          <button className="btn btn-icon settings-symbol-button" aria-label={t("关闭设置")} onClick={onClose}><X size={20} /></button>
        </div>
        <div className="settings-section">
          <div className="profile-heading-row">
            <h3>{t("模型设置")}</h3>
            {!guestIdentity && canManageApiKey && (
              <button className="btn btn-icon settings-symbol-button settings-symbol-add" type="button" data-tooltip={t("添加 API 配置")} aria-label={t("添加 API 配置")}
              onClick={openNewConnection}>
                <Plus className="sketch-action-icon sketch-action-plus" size={20} />
              </button>
            )}
          </div>
          {settings?.api_key_management === 'deployment' ? (
            <div className="settings-status-note"><ShieldCheck size={14} /> {t(" 由网站管理员提供")}</div>
          ) : guestIdentity ? (
            <div className="settings-status-note"><ShieldCheck size={14} /> {t(" 访客使用免费体验模型；登录后可配置个人 API Key。")}</div>
          ) : (
            <>
              {settings?.providers.length ? (
                <div className="settings-connection-list">
                   {settings.providers.map(connection => (
                     <div key={connection.connection_id}
                       className={`settings-connection-item${connection.connection_id === connectionId ? ' active' : ''}`}>
                       <button type="button" className="settings-connection-main" onClick={() => selectConnection(connection.connection_id)}>
                         <ProviderIcon provider={connection.provider} label={connection.provider} size="sm" />
                         <span><strong>{connectionDisplayName(connection.provider, connection.label)}</strong><small>{connection.api_key_masked ?? t("未配置")} · {connection.retired ? t("此套餐暂不可用") : connection.last_verified_at ? t("已验证 · {0} 个模型", connection.custom_models.length) : t("待验证")}</small></span>
                       </button>
                       <div className="connection-menu-wrap">
                         <button type="button" className="btn btn-icon connection-menu-button" aria-label={t("管理 {0}", connection.label)} data-tooltip={t("配置操作")}
                           aria-expanded={connectionMenuId === connection.connection_id}
                           onClick={() => setConnectionMenuId(current => current === connection.connection_id ? null : connection.connection_id)}>
                           <MoreHorizontal size={16} />
                         </button>
                         {connectionMenuId === connection.connection_id && (
                           <div className="connection-menu" role="menu">
                             {!connection.retired && <button type="button" role="menuitem" onClick={() => openModelList(connection.connection_id)}><Settings size={13} /> {t('管理模型')}</button>}
                             {!connection.retired && <button type="button" role="menuitem" onClick={() => void verifyConnection(connection.connection_id)}><RefreshCw size={13} /> {t(" 刷新模型列表")}</button>}
                             <button type="button" role="menuitem" className="danger" onClick={() => { setConnectionMenuId(null); void removeConnection(connection.connection_id); }}><Trash2 size={13} /> {t(" 删除")}</button>
                           </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
               ) : null}
             </>
           )}
           {connectionVerification.status !== 'idle' && !connectionDialog && <div className={`connection-verification ${connectionVerification.status}`}>
             <strong>{connectionVerification.status === 'loading' ? t("正在验证") : connectionVerification.status === 'success' ? t("验证成功") : t("验证失败")}</strong>
             <p>{connectionVerification.message}</p>
             {connectionVerification.models.length > 0 && <div className="verified-model-list">
               {connectionVerification.models.map(item => <span key={item}>{item}</span>)}
             </div>}
           </div>}
          {settings && !settings.free_experience_configured && <div className="settings-status-note warning">{t("免费模型暂未开放。")}</div>}
          {msg && <div style={{ fontSize: 12, color: isOk ? 'var(--ok)' : 'var(--err)' }}>{msg}</div>}
        </div>
        {connectionDialog && createPortal((
          <div className="connection-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeConnectionDialog(); }}>
            <div className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
              <InkOutline paper />
              <PaperScroll label={t('滚动配置')}>
              <div className="connection-modal-heading">
                <div><span className={`settings-eyebrow${connectionDialog === 'models' ? ' connection-name' : ''}`}>{connectionDialog === 'models' ? connectionDisplayName(providerId, connectionLabel) : t("模型设置")}</span><h3 id="connection-dialog-title">{connectionDialog === 'models' ? t('管理模型') : t("添加 API 配置")}</h3></div>
                <button className="btn btn-icon settings-symbol-button" type="button" disabled={loading} aria-label={t("关闭弹窗")} onClick={closeConnectionDialog}><X size={20} /></button>
              </div>
              {connectionDialog === 'new' && <>
              <label className="form-label">{t("选择服务商")}</label>
              <div className="provider-picker" role="radiogroup" aria-label={t("模型服务商")}>
                {providerFamilies.map(preset => {
                  const family = providerFamilyId(preset);
                  const active = selectedFamily === family;
                  const familyLabel = providerFamilyDisplayName(family, preset.family_label || preset.label);
                  return (
                    <button key={family} type="button" disabled={loading} role="radio" aria-checked={active}
                      className={`provider-choice${active ? ' active' : ''}`} onClick={() => selectProviderFamily(family)}>
                      <ProviderIcon provider={preset.id} label={familyLabel} size="md" /><span>{familyLabel}</span>
                    </button>
                  );
                })}
              </div>
              {providerVariants.length > 1 && (
                <div className="provider-variant-row">
                  <div>
                    <label className="form-label">{t("套餐与地区")}</label>
                    <SketchSelect ariaLabel={t("套餐与地区")} value={providerId} disabled={loading}
                      options={providerVariants.map(preset => ({ value: preset.id, label: providerVariantLabel(preset) }))}
                      onChange={selectProvider} />
                  </div>
                </div>
              )}
              {providerVariants.length === 1 && selectedPreset && providerId !== 'custom' && (
                <div className="provider-variant-note">{providerVariantLabel(selectedPreset)}</div>
              )}
              <div className="settings-two-columns">
                <div><label className="form-label">{t("配置名称")}</label><input className="form-input" disabled={loading} value={connectionLabel} onChange={e => { invalidateNewConnectionVerification(); setConnectionLabel(e.target.value); }} placeholder={t("例如：我的 DeepSeek")} /></div>
                <div><label className="form-label">API Key</label><input className="form-input" disabled={loading} type="password" value={apiKey} onChange={e => { invalidateNewConnectionVerification(); setApiKey(e.target.value); }} placeholder={t("填入 API Key")} /></div>
              </div>
              {providerId === 'custom' && <div><label className="form-label">{t("接口地址")}</label><input className="form-input" disabled={loading} value={baseUrl} onChange={e => { invalidateNewConnectionVerification(); setBaseUrl(e.target.value); }} placeholder="https://api.example.com/v1" /></div>}
              </>}
              <ProviderModelList models={connectionVerification.models} busy={loading}
                canVerify={connectionDialog === 'models' || Boolean(apiKey.trim() && (providerId !== 'custom' || baseUrl.trim()))}
                onFetch={async () => { await verifyNewConnection(); }} onVerify={verifyNewConnection}
                onRemove={model => setConnectionVerification(current => ({ ...current, models: current.models.filter(item => item !== model) }))} />
              {connectionVerification.status !== 'idle' && <div className={`connection-verification ${connectionVerification.status}`}>
                <strong>{connectionVerification.status === 'loading' ? t("正在验证") : connectionVerification.status === 'success' ? t("验证成功") : t("验证失败")}</strong>
                <p>{connectionVerification.message}</p>
              </div>}
              <div className="settings-actions">
                <button className="btn" type="button" disabled={loading} onClick={closeConnectionDialog}>{t("取消")}</button>
                <button className="btn btn-primary" type="button" onClick={() => void addConnection()} disabled={loading || !connectionVerification.models.length || (connectionDialog === 'new' && (!connectionVerificationToken || verifiedConnectionInputKey !== connectionInputKey))}>
                  {connectionDialog === 'models' ? <Check size={14} /> : <Plus size={14} />} {connectionDialog === 'models' ? t('保存模型列表') : t("添加 API 配置")}
                </button>
              </div>
              </PaperScroll>
            </div>
          </div>
        ), document.body)}
        <div className="settings-section settings-divider">
          <div className="profile-heading-row">
            <h3><UserRound size={13} /> {t(" 学习偏好")}</h3>
            <button type="button" role="switch" aria-label={t("按我的情况讲解")}
              aria-checked={profile?.enabled ?? true}
              className={`profile-switch${profile?.enabled === false ? '' : ' active'}`}
              onClick={toggleProfile} disabled={loading || !profile}>
              <span />
            </button>
          </div>
          <p className="settings-status-note">{t("用于所有项目的讲解和学习路线。")}</p>
          {profile?.enabled === false && (
            <div className="settings-status-note">{t("已暂停使用和自动更新学习信息，已保存的内容会保留。")}</div>
          )}
          <button ref={memoryPreviewRef} className="memory-summary-preview" type="button" aria-label={t("记忆摘要")}
            onClick={() => { setMsg(''); setShowMemorySummary(true); }}>
            <span className="memory-summary-preview-heading"><strong>{t("记忆摘要")}</strong><ChevronRight size={18} /></span>
            <p>{memorySummaryDraft || t("还没有形成稳定的记忆摘要。")}</p>
            <small>{summaryUpdatedLabel(profile?.memory_summary_updated_at)} · {profile?.memory_summary_mode === 'edited' ? t("已手动修改") : t("自动生成")}</small>
          </button>
          <div className="settings-preference-fields">
          <div>
            <label className="form-label">{t("熟悉语言")}</label>
            <input className="form-input" aria-label={t("熟悉语言")} value={languages}
              onChange={e => setLanguages(e.target.value)} placeholder="C, C++, Go" />
          </div>
            <div>
              <label className="form-label">{t("希望怎么讲")}</label>
              <input className="form-input" aria-label={t("希望怎么讲")} value={explanationPreference}
                onChange={e => setExplanationPreference(e.target.value)} />
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveProfile} disabled={loading}>{t("保存偏好")}</button>
            <button className="btn btn-danger" onClick={clearProfile} disabled={loading}>{t("清空学习信息")}</button>
          </div>
        </div>
        </PaperScroll>
      </div>
      {showMemorySummary && createPortal(
        <div className="settings-panel memory-panel" onClick={event => { if (event.target === event.currentTarget) closeMemorySummary(); }}>
          <div ref={memoryDialogRef} tabIndex={-1} className="settings-dialog memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-dialog-title"
            onKeyDown={event => {
              if (event.key === 'Escape') { event.stopPropagation(); closeMemorySummary(); }
              if (event.key !== 'Tab') return;
              const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea')];
              const first = controls[0], last = controls[controls.length - 1];
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
                event.preventDefault(); last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
            <InkOutline paper />
            <div className="settings-heading">
              <h2 id="memory-dialog-title">{t("记忆摘要")}</h2>
              <button className="btn btn-icon settings-symbol-button" type="button" aria-label={t("关闭记忆摘要")}
                onClick={closeMemorySummary}><X size={20} /></button>
            </div>
            <textarea className="form-input memory-summary-input" aria-label={t("记忆摘要")}
              value={memorySummaryDraft} onChange={event => setMemorySummaryDraft(event.target.value)}
              placeholder={t("还没有形成稳定的记忆摘要。")}
              maxLength={4000} />
            {msg && <p className={`memory-status${isOk ? ' success' : ''}`}>{msg}</p>}
            <div className="memory-dialog-actions">
              <button className="btn" type="button" onClick={regenerateMemorySummary} disabled={loading || !profile}>
                <RefreshCw size={14} /> {t("重新整理记忆摘要")}</button>
              <button className="btn btn-primary" type="button" onClick={saveMemorySummary} disabled={loading || !profile}>
                <Check size={14} /> {t(" 保存摘要")}</button>
            </div>
          </div>
        </div>, document.body)}
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
}

function NewProjectForm({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const [projectLanguage, setProjectLanguage] = useState<UiLanguage>(getUiLanguage);
  const t = (message: string, ...values: unknown[]) => translateFor(projectLanguage, message, ...values);
  const [value, setValue] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function createProject() {
    if (!value.trim()) { setError(t("请输入 GitHub 仓库地址")); return; }
    setLoading(true); setError('');
    try {
      const r = await apiClient.createProject({
        kind: 'github',
        value: value.trim(),
        title: title.trim(),
        display_language: projectLanguage,
      });
      onCreated(r.project.project_id);
    } catch (e: unknown) { setError(userFacingError(e, t("项目创建失败，请稍后重试。"))); }
    setLoading(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) { setError(t("请输入 GitHub 仓库地址")); return; }
    await createProject();
  }

  return (
    <form className="new-project-form" onSubmit={submit} lang={projectLanguage}><InkOutline paper />
      <div className="new-project-heading">
        <h2 id="new-project-title">{t("新的学习项目")}</h2>
        <LanguagePicker value={projectLanguage} onChange={setProjectLanguage} label={t('项目语言')} />
        <button className="btn btn-icon" type="button" aria-label={t('关闭弹窗')} onClick={onClose}><X size={14} /></button>
      </div>
      <div>
        <label className="form-label" htmlFor="new-project-source">{t("公开 GitHub 仓库地址")}</label>
        <input id="new-project-source" className="form-input" value={value} onChange={e => setValue(e.target.value)} autoFocus
          placeholder="https://github.com/owner/repo" />
      </div>
      <div>
        <label className="form-label" htmlFor="new-project-name">{t("项目名称（可选）")}</label>
        <input id="new-project-name" className="form-input" value={title} onChange={e => setTitle(e.target.value)}
          placeholder={t("留空则使用仓库名称")} />
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--err)' }}>{error}</div>}
      <button className="btn btn-primary" type="submit"
        disabled={loading}>
        {loading ? t("创建中…") : t("开始分析")}
      </button>
    </form>
  );
}

function NewProjectDialog({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    dialogRef.current?.querySelector<HTMLInputElement>('#new-project-source')?.focus();
    return () => { if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);
  return createPortal(
    <dialog ref={dialogRef} className="new-project-dialog" aria-labelledby="new-project-title"
      onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <NewProjectForm onCreated={onCreated} onClose={onClose} />
    </dialog>, document.body,
  );
}

function SourceModal({ projectId, snapshotId, path, line, stableId, onClose }: {
  projectId: string; snapshotId: string; path: string; line: number; stableId?: string | null; onClose: () => void;
}) {
  const [data, setData] = useState<{
    snapshot_id: string;
    path: string;
    lines: string[];
    start_line: number;
    truncated: boolean;
    redirect?: import('./types').RevisionRedirect | null;
  } | null>(null);
  const [err, setErr] = useState('');
  const sourceRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setData(null);
    setErr('');
    apiClient.getSource(projectId, snapshotId, path, Math.max(1, line - 40), line + 160, stableId)
      .then(result => { if (active) setData(result); })
      .catch(e => { if (active) setErr(userFacingError(e, t("源码暂时无法读取，请稍后重试。"))); });
    return () => { active = false; };
  }, [projectId, snapshotId, path, line, stableId]);
  useLayoutEffect(() => {
    const viewport = sourceRef.current;
    const target = targetLineRef.current;
    if (!data || !viewport || !target) return;
    // Position only this scroller; keep all returned lines and their original numbers.
    const targetTop = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    const context = Math.min(target.getBoundingClientRect().height * 6, viewport.clientHeight * .25);
    viewport.scrollTop = Math.max(0, targetTop - context);
  }, [data, line]);
  const displayPath = data?.path ?? path;
  const language = sourceLanguage(displayPath);
  return (
    <div className="settings-panel" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-dialog source-dialog" role="dialog" aria-modal="true"
        aria-label={t("源码 {0}:{1}", path, line)}>
        <div className="source-dialog-heading">
          <div className="source-dialog-title">
            <LanguageGlyph language={languageFromPath(path)} />
            <code className="source-dialog-path">{path}:{line}</code>
          </div>
          <button className="btn btn-icon" aria-label={t("关闭源码预览")} onClick={onClose}><X size={14} /></button>
        </div>
        {err && <div style={{ color: 'var(--err)', fontSize: 12 }}>{err}</div>}
        {data && (
          <>
            {data.redirect && data.redirect.kind !== 'unchanged' && (
              <div style={{ color: 'var(--warn)', fontSize: 12, marginBottom: 8 }}>
                {data.redirect.kind === 'renamed' ? `${path} → ${data.path}`
                  : data.redirect.kind === 'split' || data.redirect.kind === 'merged'
                    ? t("新版本中有多个可能匹配的位置，当前显示 {0}。", data.path)
                    : t("已打开新版本中对应的代码。")}
              </div>
            )}
            {data.truncated && <div style={{ fontSize: 11, color: 'var(--warn)' }}>{t("这里只显示部分源码")}</div>}
            <div ref={sourceRef} className="source-code" role="region" aria-label={t("源码内容")} tabIndex={0}>
              {data.lines.map((l, i) => {
                const ln = (data.start_line || 1) + i;
                return (
                  <div key={i} ref={ln === line ? targetLineRef : undefined} data-line={ln} className={ln === line ? 'source-code-line highlighted' : 'source-code-line'}>
                    <span className="source-code-number">{ln}</span>
                    <code className={`hljs language-${language}`}
                      dangerouslySetInnerHTML={{ __html: highlightedSourceLine(l, language) }} />
                  </div>
                );
              })}
            </div>
          </>
        )}
        {!data && !err && <div className="spinner" />}
      </div>
    </div>
  );
}
const MessageMarkdown = memo(function MessageMarkdown({ msg, onEvidenceClick }: {
  msg: Message;
  onEvidenceClick: (path: string, line: number, snapshotId?: string | null, stableId?: string | null) => void;
}) {
  const language = useUiLanguage();
  const { evidence, unresolved_references: unresolved, analysis_snapshot_id: snapshotId } = msg;
  const components = useMemo(() => createMarkdownComponents(reference => {
    const resolved = resolveMessageEvidence(evidence, reference);
    onEvidenceClick(resolved?.path ?? reference.path, reference.line ?? resolved?.start_line ?? 1,
      resolved?.snapshot_id ?? snapshotId, resolved?.stable_id);
  }, evidence, unresolved ?? []), [evidence, unresolved, snapshotId, onEvidenceClick, language]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{msg.content}</ReactMarkdown>;
});

function MsgBubble({
  msg,
  activity,
  onEvidenceClick,
  onFeedback,
  onLearningAction,
  feedbackPending,
  learningActionPending,
  feedbackEnabled = true,
  activityStartedAt,
  messageRef,
  onEdit,
  onResend,
  edit,
}: {
  msg: Message;
  activity?: RuntimeProgressEvent[];
  activityStartedAt?: number | null;
  onEvidenceClick: (path: string, line: number, snapshotId?: string | null, stableId?: string | null) => void;
  onFeedback: (messageId: string, vote: import('./types').MessageFeedbackVote) => void;
  onLearningAction: (actionId: string, decision: 'confirm' | 'decline') => void;
  feedbackPending?: boolean;
  learningActionPending?: boolean;
  feedbackEnabled?: boolean;
  messageRef?: (node: HTMLDivElement | null) => void;
  onEdit?: () => void;
  onResend?: () => void;
  edit?: { content?: string; onCancel: () => void; onSubmit: (content: string) => void };
}) {
  if (edit) return <div className="msg user editing" ref={messageRef}><div className="msg-content">
    <InlineMessageEditor content={edit.content ?? msg.content} onCancel={edit.onCancel} onSubmit={edit.onSubmit} />
  </div></div>;
  const action = msg.learning_action;
  const evidenceFiles = msg.evidence.filter((item, index, all) => all.findIndex(candidate => (
    candidate.path === item.path && candidate.snapshot_id === item.snapshot_id
  )) === index);
  const activityEvents = activity && activity.length > 0
    ? activity
    : (msg.thinking_summary ?? []);
  const evidenceFileCount = msg.role === 'assistant' ? messageEvidenceFileCount(msg) : 0;
  const actionPending = action?.status === 'pending';
  const actionResolving = Boolean(actionPending && learningActionPending);
  const routeResolving = Boolean(actionResolving && (
    action?.action === 'start_learning_route'
    || action?.action === 'switch_learning_target'
  ));
  return (
    <div className={`msg ${msg.role}`} ref={messageRef}>
      <div className="msg-content">
        {msg.role === 'assistant' && !msg.placeholder
          && (activityEvents.length > 0
            || typeof msg.trace_id === 'string'
            || msg.latency_ms !== null) ? (
          <ActivityDisclosure
            events={activityEvents}
            startedAt={activityStartedAt}
            complete={!msg.message_id.startsWith('client:assistant:')}
            terminalStatus={msg.error ? (['cancelled', 'paused'].includes(activityEvents.at(-1)?.status ?? '') ? 'cancelled' : 'failed') : undefined}
            durationMs={msg.latency_ms ?? undefined}
            fileCount={evidenceFileCount}
            testId="answer-activity"
          />
        ) : null}
        <div className="msg-bubble">
          {msg.placeholder && (
            <div className="placeholder-notice">{t("⚠ 未接入模型 · 以下为静态分析结果")}</div>
          )}
          {msg.role === 'assistant'
            ? <MessageMarkdown msg={msg} onEvidenceClick={onEvidenceClick} />
           : <p style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</p>}
          {msg.evidence.length > 0 && (
            <div className="evidence-chips">
              {evidenceFiles.map((ev, i) => {
                const name = shortReferencePath(ev.path, msg.evidence);
                const label = ev.start_line ? `${name}:${ev.start_line}` : name;
                return (
                  <button key={i} type="button" className={`evidence-chip ${ev.kind}`}
                    title={ev.path}
                    aria-label={ev.start_line ? `${ev.path}:${ev.start_line}` : ev.path}
                    onClick={() => onEvidenceClick(ev.path, ev.start_line ?? 1, ev.snapshot_id ?? msg.analysis_snapshot_id, ev.stable_id)}
                    data-tooltip={ev.kind === 'unverified' ? t("模型引用了不存在的路径")
                      : ev.kind === 'out_of_scope' ? t("这处引用不在本次检查范围内") : undefined}>
                    <LanguageGlyph language={languageFromPath(ev.path ?? 'file')} className="evidence-chip-icon" />
                    <span className="evidence-chip-label">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {action && (
            <div
              className={`learning-action-card learning-action-${action.status}${actionResolving ? ' learning-action-processing' : ''}`}
              aria-busy={actionResolving}
            >
              <div className="learning-action-card-heading">
                <strong>{action.title}</strong>
                <span aria-live="polite">{actionResolving
                  ? (routeResolving ? t("正在生成路线") : t("正在执行"))
                  : action.status === 'pending' ? t("需要你的确认") : (
                  action.status === 'executed' ? t("已完成") :
                    action.status === 'declined' ? t("已跳过") :
                      action.status === 'failed' ? t("暂未完成") : t("已处理")
                )}</span>
              </div>
              <p>{action.description}</p>
              {action.error && <p className="learning-action-error">{t("这项学习操作暂时未完成，请稍后重试。")}</p>}
              {actionPending && (
                <div className="learning-action-controls">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={Boolean(learningActionPending)}
                    onClick={() => onLearningAction(action.action_id, 'confirm')}
                  >
                    {actionResolving ? (
                      <><span className="spinner learning-action-spinner" aria-hidden="true" /> {routeResolving ? t("正在生成") : t("正在执行")}</>
                    ) : (
                      <><Check size={14} /> {t(" 确认")}</>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={Boolean(learningActionPending)}
                    onClick={() => onLearningAction(action.action_id, 'decline')}
                  >
                    <X size={14} /> {t(" 暂不")}</button>
                </div>
              )}
            </div>
          )}
          {feedbackEnabled && msg.role === 'assistant' && !msg.error && !msg.placeholder && (
            <div className="message-feedback" aria-label={t("评价这条回答")}>
              {msg.model && <div className="message-model-name">{msg.model}</div>}
              {msg.analysis_commit_sha && (
                <div className="message-version-meta">{t("回答基于版本 ")}<code>{msg.analysis_commit_sha.slice(0, 12)}</code></div>
              )}
              <div className="message-feedback-actions">
                <button type="button"
                  className={`message-feedback-button${msg.feedback?.vote === 'up' ? ' selected' : ''}`}
                  aria-label={t("回答有帮助")}
                  aria-pressed={msg.feedback?.vote === 'up'}
                  data-tooltip={t("回答有帮助")}
                  disabled={feedbackPending}
                  onClick={() => onFeedback(msg.message_id, 'up')}>
                  <ThumbsUp className="sketch-action-icon sketch-action-feedback" size={17} strokeWidth={2.15} />
                </button>
                <button type="button"
                  className={`message-feedback-button${msg.feedback?.vote === 'down' ? ' selected' : ''}`}
                  aria-label={t("回答没帮助")}
                  aria-pressed={msg.feedback?.vote === 'down'}
                  data-tooltip={t("回答没帮助")}
                  disabled={feedbackPending}
                  onClick={() => onFeedback(msg.message_id, 'down')}>
                  <ThumbsDown className="sketch-action-icon sketch-action-feedback" size={17} strokeWidth={2.15} />
                </button>
              </div>
            </div>
          )}
        </div>
        {msg.role === 'user' && (onEdit || onResend) && <LastMessageActions onEdit={onEdit} onResend={onResend} />}
      </div>
    </div>
  );
}

function mergeProgressEvents(
  current: RuntimeProgressEvent[],
  next: RuntimeProgressEvent,
): RuntimeProgressEvent[] {
  // Answer deltas and the synthetic connection marker are metadata only. The
  // answer text is appended separately, while hidden events must not become
  // expandable history rows.
  if (next.visible === false) return current;
  if (next.sequence !== undefined) {
    const existing = current.findIndex(item => item.sequence === next.sequence);
    if (existing >= 0) {
      const replaced = [...current];
      replaced[existing] = next;
      return replaced.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    }
    return [...current, next].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
  }
  const last = current.at(-1);
  const sameConsecutiveEvent = Boolean(last
    && last.sequence === undefined
    && last.stage === next.stage
    && last.label === next.label
    && last.status === next.status
    && (last.tool_name ?? '') === (next.tool_name ?? ''));
  return sameConsecutiveEvent ? [...current.slice(0, -1), next] : [...current, next];
}

function dedupeAnalysisProgressEvents(events: RuntimeProgressEvent[]): RuntimeProgressEvent[] {
  const indexes = new Map<string, number>();
  return events.reduce<RuntimeProgressEvent[]>((result, event) => {
    const key = event.analysis_progress?.instance_id ?? analysisStageKey(event) ?? event.stage;
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      result[existingIndex] = event;
      return result;
    }
    indexes.set(key, result.length);
    result.push(event);
    return result;
  }, []);
}

function ActivityDisclosure({
  events,
  startedAt,
  durationMs,
  fileCount,
  complete = false,
  exactStages = false,
  testId,
  terminalStatus,
}: {
  events: RuntimeProgressEvent[];
  startedAt?: number | null;
  durationMs?: number;
  fileCount?: number;
  complete?: boolean;
  exactStages?: boolean;
  testId?: string;
  terminalStatus?: 'failed' | 'cancelled';
}) {
  const [expanded, setExpanded] = useState(false);
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (complete) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [complete]);
  const visibleEvents = events.filter(event => (
    event.visible !== false
    && event.kind !== 'answer'
    && !['run_completed', 'usage_updated'].includes(event.stage)
    && !(exactStages && ['full_analysis', 'incremental_analysis', 'scanning', 'interpreting'].includes(analysisStageKey(event) ?? '')
      && events.some(row => detailedAnalysisStages.some(stage => stage.id === analysisStageKey(row))))
  ));
  const phases = exactStages
    ? dedupeAnalysisProgressEvents(visibleEvents)
      .map(event => ({ key: activityPhaseKey(event), latest: event, events: [event] }))
    : groupActivityPhases(visibleEvents);
  const runningPhases = exactStages ? phases.filter(phase => phase.latest.status === 'running') : [];
  const current = runningPhases.at(-1) ?? phases.at(-1);
  const elapsed = complete
    ? (durationMs ?? current?.latest.elapsed_ms ?? 0)
    : Math.max(0, now - (startedAt ?? mountedAt.current));
  const hasDetails = phases.length > 0;
  const statusLabel = !complete && current ? activityStatusLabel(current.latest) : null;
  const outcome = terminalStatus ?? (complete && ['failed', 'cancelled', 'paused'].includes(current?.latest.status ?? '')
    ? (current?.latest.status === 'paused' ? 'cancelled' : current?.latest.status) : undefined);
  const canExpand = hasDetails && (!complete || Boolean(outcome));
  const summaryIcon = outcome === 'failed' ? 'failure' : outcome === 'cancelled' ? 'stop'
    : complete ? 'done' : activityIconName(current?.latest, exactStages);
  const summaryLabel = outcome === 'failed' ? t('回答失败')
    : outcome === 'cancelled' ? t('已取消')
    : complete
    ? completedActivityLabel(phases, fileCount)
    : statusLabel
      ? statusLabel
      : current
        ? exactStages ? (runningPhases.length ? runningPhases.map(phase => analysisEventLabel(phase.latest)).join(t('；')) : analysisEventLabel(current.latest)) : activityPhaseLabel(current.key, current.latest.status)
        : t("正在准备回答");
  return (
    <div className={`conversation-activity${canExpand && expanded ? ' expanded' : ''}`}
      role="status" aria-live="polite" data-testid={testId} data-status={outcome ?? (complete ? 'completed' : current?.latest.status)}>
      <div className="activity-summary">
        {canExpand ? (
          <button type="button" className="activity-toggle" aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}>
            <ChevronRight size={13} aria-hidden="true" />
            <ActivityIcon name={summaryIcon} className="activity-step-icon" />
            {complete || statusLabel ? <span>{summaryLabel}</span> : <ShinyText text={summaryLabel} />}
          </button>
        ) : (
          <div className="activity-toggle activity-toggle-static">
            <ActivityIcon name={summaryIcon} className="activity-step-icon" />
            <span>{summaryLabel}</span>
          </div>
        )}
        <time>{complete ? t("耗时 ") : ''}{formatElapsed(elapsed, !complete)}</time>
      </div>
      {canExpand && expanded && hasDetails && (
        <div className="activity-history">
          {phases.map((phase, index) => (
            <div className={`activity-step ${phase.latest.status}`}
              key={`${phase.key}:${phase.latest.sequence ?? phase.latest.stage}:${index}`}
              data-kind="summary">
              <ActivityIcon name={activityIconName(phase.latest, exactStages)} className="activity-step-icon" />
              <div className="activity-step-body">
                <div className="activity-step-heading">
                  <span>{activityStatusLabel(phase.latest) ?? (exactStages
                      ? analysisEventLabel(phase.latest, phase.latest.status)
                      : activityPhaseLabel(phase.key, phase.latest.status))}</span>
                  {activityPhaseDetail(phase) && <small>{activityPhaseDetail(phase)}</small>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationActivity({ events, startedAt }: {
  events: RuntimeProgressEvent[];
  startedAt: number | null;
}) {
  return <ActivityDisclosure events={events} startedAt={startedAt}
    testId="conversation-activity" />;
}

function LoginScreen({
  config,
  loading,
  error,
  onGuest,
}: {
  config: AuthConfigResponse;
  loading: boolean;
  error: string;
  onGuest: () => void;
}) {
  const language = useUiLanguage();
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <div className="field-wordmark"><FieldMark /><span>what-the-repo</span></div>
        <LanguagePicker value={language} onChange={setUiLanguage} label={t('界面语言')} />
      </header>
      <div className="auth-layout">
      <FieldScene className="auth-illustration" />
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-copy">
          <h1 id="auth-title">{t('从好奇开始。')}<SketchDoodle variant="underline" className="auth-heading-line" /></h1>
          <p>{t("快速理解，深入学习陌生仓库")}</p>
        </div>
        <button className="btn btn-primary auth-action" type="button"
          onClick={() => { window.location.href = apiClient.githubLoginUrl('/'); }}>
          <img className="inline-brand-icon github-login-icon" src="/github.svg" alt="" /> {t(" 使用 GitHub 登录")}</button>
        {config.guest_enabled && (
          <div className="guest-choice">
            <button className="btn auth-action" type="button" onClick={onGuest} disabled={loading}>
              <LogIn size={16} /> {loading ? t("正在创建访客空间…") : t("以访客身份体验")}
            </button>
            <div className="guest-notice">
              <ShieldCheck size={15} />
              <span>{t("访客记录仅在当前浏览器可用。更换设备、清除 Cookie 或登录凭据过期后，可能无法找回；登录 GitHub 可保存到账号。")}</span>
            </div>
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
      </section>
      </div>
      <ComplianceFooter />
    </main>
  );
}

export default function App() {
  const uiLanguage = useUiLanguage();
  useEffect(() => { document.documentElement.lang = uiLanguage; }, [uiLanguage]);
  const theme = useThemePreference();
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [mergeNotice, setMergeNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotTarget, setSnapshotTarget] = useState<{ projectId: string; snapshotId: string | null } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [input, setInput] = useState('');
  const historyUsage = useMemo(() => chatHistoryUsage(project?.messages ?? []), [project?.messages]);
  const newMessageBlocked = chatCapacityReached(historyUsage, project?.chat_limits, input);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [rejectedEdit, setRejectedEdit] = useState<{ projectId: string; messageId: string; content: string } | null>(null);
  const [conversationError, setConversationError] = useState<{ projectId: string; text: string; capacity?: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [conversationActivity, setConversationActivity] = useState<RuntimeProgressEvent[]>([]);
  const [conversationStartedAt, setConversationStartedAt] = useState<number | null>(null);
  const [conversationRunId, setConversationRunId] = useState<string | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState<Message | null>(null);
  const [completedActivities, setCompletedActivities] = useState<Record<string, RuntimeProgressEvent[]>>({});
  const [feedbackPending, setFeedbackPending] = useState<Record<string, boolean>>({});
  const [learningActionPending, setLearningActionPending] = useState<Record<string, boolean>>({});
  const [analysisActivity, setAnalysisActivity] = useState<RuntimeProgressEvent[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [analysisJobDetails, setAnalysisJobDetails] = useState<{ attempt: number; max_attempts: number; error: string | null; error_code?: string | null; scheduling_state?: import('./types').AnalysisJob['scheduling_state'] } | null>(null);
  const [reviewEvidence, setReviewEvidence] = useState(() => (
    window.localStorage.getItem(REVIEW_PREFERENCE_KEY) === 'true'
  ));
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sourceModal, setSourceModal] = useState<{
    projectId: string;
    snapshotId: string;
    projectEpoch: number;
    path: string;
    line: number;
    stableId?: string | null;
  } | null>(null);
  const [conversationSelection, setConversationSelection] = useState<ConversationSelection | null>(null);
  const isMobile = useMediaQuery('(max-width: 680px)');
  const isPhone = usePhoneDevice();
  const landscape = useMediaQuery('(orientation: landscape)');
  const isPhoneLandscape = isPhone && landscape && !isMobile;
  const singlePageProject = isMobile || isPhoneLandscape;
  const [desktopSidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarCollapsed = !isMobile && desktopSidebarCollapsed;
  const mobileSidebarTrigger = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMobile || !mobileSidebarOpen) return;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>('.sidebar-actions button')?.focus({ preventScroll: true });
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileSidebarOpen(false); return; }
      if (event.key !== 'Tab' || !sidebar) return;
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]'))
        .filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    sidebar?.addEventListener('keydown', keyDown);
    return () => {
      sidebar?.removeEventListener('keydown', keyDown);
      mobileSidebarTrigger.current?.focus({ preventScroll: true });
    };
  }, [isMobile, mobileSidebarOpen]);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [sidebarMinWidth, setSidebarMinWidth] = useState(260);
  const sidebarHeaderRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const header = sidebarHeaderRef.current;
    const title = header?.querySelector<HTMLElement>('.sidebar-title');
    const name = header?.querySelector<HTMLElement>('.sidebar-product-name');
    const mark = header?.querySelector<SVGElement>('.field-mark');
    const actions = header?.querySelector<HTMLElement>('.sidebar-actions');
    if (!header || !title || !name || !mark || !actions) return;
    const measure = () => {
      if (!name.scrollWidth) return;
      const headerStyle = getComputedStyle(header);
      const titleStyle = getComputedStyle(title);
      const minimum = Math.ceil(name.scrollWidth + mark.getBoundingClientRect().width + actions.getBoundingClientRect().width
        + (parseFloat(headerStyle.paddingLeft) || 0) + (parseFloat(headerStyle.paddingRight) || 0)
        + (parseFloat(headerStyle.columnGap) || 0) + (parseFloat(titleStyle.columnGap) || 0)) + 2;
      setSidebarMinWidth(minimum);
      setSidebarWidth(width => Math.max(width, minimum));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(name);
    observer.observe(actions);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => { observer.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); };
  }, [sidebarCollapsed, identity, authReady]);
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [repositoryWidth, setRepositoryWidth] = useState(REPOSITORY_DEFAULT_WIDTH);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const sidebarResizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => sidebarResizeCleanup.current?.(), []);
  useEffect(() => {
    if (!accountMenuOpen) return;
    accountRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [accountMenuOpen]);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const chatScrollRef = useSmoothChatScroll(activeId, project?.messages.length ?? 0, streamingAssistant?.content);
  const streamRenderFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (streamRenderFrame.current !== null) cancelAnimationFrame(streamRenderFrame.current);
    streamRenderFrame.current = null;
  }, []);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const conversationActivityRef = useRef<RuntimeProgressEvent[]>([]);
  const mainRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const projectEpochRef = useRef(0);
  const loadRequestRef = useRef(0);
  const analysisTimerStartsRef = useRef(new Map<string, number>());
  const projectCacheRef = useRef(new Map<string, Project>());
  const pendingConversationsRef = useRef(new Map<string, PendingConversation>());
  const [analysisJobStatus, setAnalysisJobStatus] = useState<string | null>(null);
  const [analysisDismissed, setAnalysisDismissed] = useState(false);
  activeIdRef.current = activeId;

  const rememberAnalysisStart = useCallback((
    projectId: string,
    jobId: string | null,
    createdAt: string | null = null,
    reset = false,
  ): number => {
    const key = analysisTimerKey(projectId, jobId);
    const pendingKey = analysisTimerKey(projectId, null);
    if (reset) {
      const startedAt = Date.now();
      analysisTimerStartsRef.current.set(key, startedAt);
      return startedAt;
    }
    const existing = analysisTimerStartsRef.current.get(key);
    if (existing !== undefined) return existing;
    const pending = analysisTimerStartsRef.current.get(pendingKey);
    const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
    const startedAt = pending
      ?? (Number.isFinite(parsed) ? parsed : Date.now());
    analysisTimerStartsRef.current.set(key, startedAt);
    if (jobId !== null && pending !== undefined) {
      analysisTimerStartsRef.current.delete(pendingKey);
    }
    return startedAt;
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const config = await apiClient.authConfig();
        if (!active) return;
        setAuthConfig(config);
        try {
          const current = await apiClient.authMe();
          if (active) {
            setIdentity(current);
            const summary = current.merge_summary;
            if (summary) {
              setMergeNotice(t("访客记录已保存到 GitHub 账号。"));
            }
          }
        } catch (error: unknown) {
          if (!(
            typeof error === 'object'
            && error !== null
            && 'status' in error
            && error.status === 401
            && config.auth_mode === 'github'
          )) {
            throw error;
          }
        }
      } catch (error: unknown) {
        if (active) setAuthError(userFacingError(error, t("登录服务暂时不可用，请稍后重试。")));
      } finally {
        if (active) setAuthReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  const syncProjectSummary = useCallback((nextProject: Project) => {
    setProjects(current => current.map(item => item.project_id === nextProject.project_id
      ? {
          ...item,
          title: nextProject.title,
          analysis_stage: nextProject.analysis.stage,
          teaching_phase: nextProject.study.phase,
          message_count: nextProject.messages.length,
          updated_at: nextProject.updated_at,
        }
      : item));
  }, []);

  const submitMessageFeedback = useCallback(async (
    messageId: string,
    vote: import('./types').MessageFeedbackVote,
  ) => {
    const projectId = activeIdRef.current;
    if (!projectId || feedbackPending[messageId]) return;
    const previous = project?.messages.find(message => message.message_id === messageId)?.feedback ?? null;
    const optimistic = { vote, updated_at: new Date().toISOString(), signal: previous?.signal ?? null };
    setFeedbackPending(current => ({ ...current, [messageId]: true }));
    setProject(current => current?.project_id === projectId
      ? {
          ...current,
          messages: current.messages.map(message => message.message_id === messageId
            ? { ...message, feedback: optimistic }
            : message),
        }
      : current);
    try {
      const result = await apiClient.recordMessageFeedback(projectId, messageId, vote);
      setProject(current => current?.project_id === projectId
        ? {
            ...current,
            messages: current.messages.map(message => message.message_id === messageId
              ? { ...message, feedback: result.feedback }
              : message),
          }
        : current);
    } catch {
      setProject(current => current?.project_id === projectId
        ? {
            ...current,
            messages: current.messages.map(message => message.message_id === messageId
              ? { ...message, feedback: previous }
              : message),
          }
        : current);
    } finally {
      setFeedbackPending(current => {
        const next = { ...current };
        delete next[messageId];
        return next;
      });
    }
  }, [feedbackPending, project]);

  const resolveLearningAction = useCallback(async (
    actionId: string,
    decision: 'confirm' | 'decline',
  ) => {
    const projectId = activeIdRef.current;
    if (!projectId || learningActionPending[actionId]) return;
    setLearningActionPending(current => ({ ...current, [actionId]: true }));
    try {
      const result = await apiClient.resolveLearningAction(projectId, actionId, decision);
      if (activeIdRef.current === projectId) {
        setProject(result.project);
        syncProjectSummary(result.project);
      }
    } catch (error: unknown) {
      if (activeIdRef.current === projectId) setLoadError(userFacingError(error, t("学习操作暂时未完成，请稍后重试。")));
    } finally {
      setLearningActionPending(current => {
        const next = { ...current };
        delete next[actionId];
        return next;
      });
    }
  }, [learningActionPending, syncProjectSummary]);

  useEffect(() => {
    if (!project) return;
    projectCacheRef.current.set(project.project_id, stripTransientMessages(project));
  }, [project]);

  useEffect(() => {
    if (!projectMenuId) return;
    const closeMenu = () => setProjectMenuId(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [projectMenuId]);

  useEffect(() => {
    if (!renamingProjectId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingProjectId]);

  useEffect(() => {
    messageRefs.current.clear();
  }, [activeId]);

  const registerMessageRef = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (node) messageRefs.current.set(messageId, node);
    else messageRefs.current.delete(messageId);
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    const requestId = ++loadRequestRef.current;
    setLoadError('');
    try {
      const detail = await apiClient.getProject(projectId);
      if (requestId !== loadRequestRef.current || activeIdRef.current !== projectId) return;
      const nextJob = detail.analysis_job;
      const cachedProject = projectCacheRef.current.get(projectId) ?? null;
      const nextProject = mergeLocalMessages(
        detail.project,
        cachedProject,
        pendingConversationsRef.current.get(projectId),
      );
      projectCacheRef.current.set(projectId, nextProject);
      setProject(nextProject);
      const nextJobStatus = nextJob?.status ?? null;
      const jobIsActive = nextJobStatus === 'queued' || nextJobStatus === 'running';
      const jobIsTerminal = ['succeeded', 'failed', 'cancelled'].includes(nextJobStatus ?? '');
      const expectedSnapshotId = detail.project.analysis.snapshot_id;
      const cachedSnapshot = expectedSnapshotId
        ? getMemorySnapshot(projectId, expectedSnapshotId, getUiLanguage())
        : null;
      if (cachedSnapshot) setSnapshot(cachedSnapshot);
      if (jobIsActive || (!jobIsTerminal && !['done', 'failed', 'idle'].includes(detail.project.analysis.stage))) {
        rememberAnalysisStart(
          projectId,
          nextJob?.job_id ?? null,
          nextJob?.created_at ?? null,
        );
      }
      setAnalysisJobId(nextJob?.job_id ?? null);
      setAnalysisJobDetails(nextJob ?? null);
      setAnalysisJobStatus(nextJobStatus);
      syncProjectSummary(detail.project);
      if (detail.snapshot_available && !jobIsActive) {
        setSnapshotTarget({ projectId, snapshotId: expectedSnapshotId });
      } else {
        setSnapshotTarget(null);
        if (!cachedSnapshot) setSnapshot(null);
      }
    } catch (error: unknown) {
      if (requestId === loadRequestRef.current && activeIdRef.current === projectId) {
        setLoadError(userFacingError(error, t("项目内容暂时无法加载，请稍后重试。")));
      }
    }
  }, [rememberAnalysisStart, syncProjectSummary]);

  // Language changes only reload the displayed snapshot. Project/chat loading
  // stays separate so drafts, navigation and running analysis are unaffected.
  useEffect(() => {
    if (!snapshotTarget || snapshotTarget.projectId !== activeId) return;
    const { projectId, snapshotId } = snapshotTarget;
    let disposed = false;
    setLoadError('');
    void (async () => {
      try {
        const cached = snapshotId ? await readCachedSnapshot(projectId, snapshotId, uiLanguage) : null;
        if (disposed || activeIdRef.current !== projectId) return;
        const next = cached ?? await apiClient.getSnapshot(projectId, uiLanguage);
        if (disposed || activeIdRef.current !== projectId) return;
        if (!cached) writeSnapshotCache(projectId, next);
        setSnapshot(next);
      } catch (error) {
        if (!disposed && activeIdRef.current === projectId) {
          setLoadError(userFacingError(error, t('项目内容暂时无法加载，请稍后重试。')));
        }
      }
    })();
    return () => { disposed = true; };
  }, [activeId, snapshotTarget, uiLanguage]);

  useEffect(() => {
    if (!identity) return;
    setLoadError('');
    Promise.all([
      apiClient.listProjects(),
      apiClient.getSettings(),
    ])
      .then(([ps, s]) => {
        setProjects(ps);
        setSettings(s);
      })
      .catch(e => setLoadError(userFacingError(e, t("项目列表暂时无法加载，请稍后重试。"))));
  }, [identity]);

  useEffect(() => {
    projectEpochRef.current += 1;
    setEditingMessageId(null);
    setConversationError(null);
    loadRequestRef.current += 1;
    const cachedProject = activeId ? projectCacheRef.current.get(activeId) ?? null : null;
    setProject(cachedProject);
    setSnapshot(activeId ? getMemorySnapshot(activeId, cachedProject?.analysis.snapshot_id, getUiLanguage()) : null);
    setSnapshotTarget(null);
    setAnalysisJobId(null);
    setAnalysisJobDetails(null);
    setAnalysisJobStatus(null);
    setAnalysisDismissed(false);
    setConversationSelection(null);
    setSourceModal(null);
    setInput('');
    const pendingConversation = activeId ? pendingConversationsRef.current.get(activeId) : null;
    setSending(Boolean(pendingConversation));
    setConversationStartedAt(pendingConversation?.startedAt ?? null);
    setStreamingAssistant(pendingConversation?.streamingAssistant ?? null);
    setConversationRunId(pendingConversation?.runId ?? null);
    setConversationActivity(pendingConversation?.activity ?? []);
    conversationActivityRef.current = pendingConversation?.activity ?? [];
    setAnalysisActivity([]);
    setLearningActionPending({});
    if (!activeId) {
      return;
    }
    void loadProject(activeId);
  }, [activeId, loadProject]);

  useTextareaAutosize(composerRef, input, 48, 1 / 3, project?.project_id);

  const polledAnalysisStage = project?.analysis.stage;
  const polledAnalysisProgressEvents = project?.analysis.progress_events;

  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!activeId || !polledAnalysisStage) return;
    const stage = polledAnalysisStage;
    const projectEpoch = projectEpochRef.current;
    const jobIsActive = analysisJobStatus === 'queued' || analysisJobStatus === 'running';
    const jobIsTerminal = ['succeeded', 'failed', 'cancelled'].includes(analysisJobStatus ?? '');
    if (analysisDismissed || jobIsTerminal || (!jobIsActive && ['done', 'failed', 'idle'].includes(stage))) return;
    let disposed = false;
    const poll = async () => {
      try {
        const r = await apiClient.getProject(activeId);
        if (
          disposed
          || activeIdRef.current !== activeId
          || projectEpochRef.current !== projectEpoch
        ) return;
        const nextJobStatus = r.analysis_job?.status ?? null;
        const nextJobActive = nextJobStatus === 'queued' || nextJobStatus === 'running';
        const nextJobTerminal = ['succeeded', 'failed', 'cancelled'].includes(nextJobStatus ?? '');
        if (nextJobActive || (!nextJobTerminal && !['done', 'failed', 'idle'].includes(r.project.analysis.stage))) {
          rememberAnalysisStart(
            activeId,
            r.analysis_job?.job_id ?? null,
            r.analysis_job?.created_at ?? null,
          );
        }
        const terminal = nextJobTerminal
          || (!nextJobActive && ['done', 'failed'].includes(r.project.analysis.stage));
        if (
          disposed
          || activeIdRef.current !== activeId
          || projectEpochRef.current !== projectEpoch
        ) return;
        setProject(current => mergeLocalMessages(
          r.project,
          current,
          pendingConversationsRef.current.get(activeId),
        ));
        setAnalysisJobId(r.analysis_job?.job_id ?? null);
        setAnalysisJobDetails(r.analysis_job ?? null);
        setAnalysisJobStatus(nextJobStatus);
        syncProjectSummary(r.project);
        if (terminal) {
          pollRef.current = null;
          setSnapshotTarget(r.snapshot_available ? { projectId: activeId, snapshotId: r.project.analysis.snapshot_id } : null);
          return;
        }
      } catch { /* */ }
      if (
        !disposed
        && activeIdRef.current === activeId
        && projectEpochRef.current === projectEpoch
      ) {
        pollRef.current = setTimeout(() => { void poll(); }, 2000);
      }
    };
    pollRef.current = setTimeout(() => { void poll(); }, 2000);
    return () => {
      disposed = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [activeId, analysisDismissed, analysisJobStatus, polledAnalysisStage, rememberAnalysisStart, syncProjectSummary]);

  useEffect(() => {
    if (!polledAnalysisStage || analysisDismissed) return;
    if (polledAnalysisProgressEvents?.length) {
      setAnalysisActivity(analysisProgressRuntimeEvents({
        ...project!.analysis,
        progress_events: polledAnalysisProgressEvents,
      }));
      return;
    }
    const stage = polledAnalysisStage;
    const jobIsActive = analysisJobStatus === 'queued' || analysisJobStatus === 'running';
    const status: RuntimeProgressEvent['status'] = (
      jobIsActive || !['done', 'failed'].includes(stage)
    ) ? 'running' : 'completed';
    const next: RuntimeProgressEvent = {
      stage: `analysis:${stage}:${analysisJobStatus ?? 'none'}`,
      label: analysisActivityLabel(stage, analysisJobStatus),
      status,
      elapsed_ms: 0,
    };
    setAnalysisActivity(current => {
      return mergeAnalysisProgressEvents(current, next);
    });
  }, [analysisDismissed, analysisJobStatus, polledAnalysisProgressEvents, polledAnalysisStage, project]);

  useEffect(() => {
    const snapshotId = snapshot?.snapshot_id;
    setConversationSelection(current => (
      current && current.snapshot_id === snapshotId ? current : null
    ));
    setSourceModal(current => (
      current
      && current.projectId === activeId
      && current.projectEpoch === projectEpochRef.current
        ? current
        : null
    ));
  }, [activeId, snapshot?.snapshot_id]);

  async function loginAsGuest() {
    setAuthLoading(true);
    setAuthError('');
    try {
      const guest = await apiClient.createGuest();
      setIdentity(guest);
    } catch (error: unknown) {
      setAuthError(userFacingError(error, t("访客体验暂时无法开启，请稍后重试。")));
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    await apiClient.logout();
    clearSnapshotCache();
    projectCacheRef.current.clear();
    setIdentity(null);
    setProjects([]);
    setActiveId(null);
    setProject(null);
    setSnapshot(null);
    setSettings(null);
    setCompletedActivities({});
    pendingConversationsRef.current.clear();
    setAccountMenuOpen(false);
    setShowSettings(false);
    setShowNew(false);
  }

  useEffect(() => { setEditingMessageId(null); setRejectedEdit(null); }, [activeId]);

  async function sendMessage(replacement?: { messageId: string; content: string }) {
    const text = (replacement?.content ?? input).trim();
    if (
      !text
      || !activeId
      || sending
      || pendingConversationsRef.current.has(activeId)
      || project?.project_id !== activeId
    ) return;
    const projectId = activeId;
    const projectEpoch = projectEpochRef.current;
    const targetId = replacement?.messageId;
    const replaceMessageId = targetId && !targetId.startsWith('client:') ? targetId : undefined;
    const retryRunId = targetId?.startsWith('client:') ? project.messages.find(message => message.message_id === targetId)?.trace_id ?? undefined : undefined;
    const targetIndex = targetId ? project.messages.findIndex(message => message.message_id === targetId) : -1;
    const originalMessages = project.messages;
    const retainedUsage = targetIndex >= 0 ? chatHistoryUsage(originalMessages.slice(0, targetIndex)) : historyUsage;
    if (chatCapacityReached(retainedUsage, project.chat_limits, text)) {
      setConversationError({ projectId, text: t('此项目已达到聊天上限'), capacity: true });
      return;
    }
    const optimisticId = `client:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const pendingToken = `conversation:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const startedAt = Date.now();
    const optimisticUser: Message = {
      message_id: optimisticId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    if (!replacement) setInput('');
    setEditingMessageId(null);
    setRejectedEdit(null);
    setConversationError(null);
    setSending(true);
    setConversationRunId(null);
    setConversationActivity([]);
    conversationActivityRef.current = [];
    const initialStreamingAssistant: Message = {
      message_id: `client:assistant:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
      evidence: [],
      model: project.model_override ?? settings?.model ?? null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    setConversationStartedAt(startedAt);
    setStreamingAssistant(initialStreamingAssistant);
    pendingConversationsRef.current.set(projectId, {
      token: pendingToken,
      optimisticId,
      startedAt,
      optimisticUser,
      replaceMessageId,
      runId: null,
      activity: [],
      streamingAssistant: initialStreamingAssistant,
    });
    setProject(current => current?.project_id === projectId
      ? { ...current, messages: [...(targetIndex >= 0 ? current.messages.slice(0, targetIndex) : current.messages), optimisticUser] }
      : current);
    try {
      const currentSelection = conversationSelection?.snapshot_id === snapshot?.snapshot_id
        ? conversationSelection
        : null;
      const response = typeof apiClient.sendMessageStream === 'function'
        ? await apiClient.sendMessageStream(
            projectId,
            text,
            currentSelection,
            event => {
              const pending = pendingConversationsRef.current.get(projectId);
              if (!pending || pending.token !== pendingToken) return;
              const nextActivity = mergeProgressEvents(pending.activity, event);
              const nextStreamingAssistant = event.stage === 'assistant_delta' && event.delta
                ? { ...pending.streamingAssistant, content: `${pending.streamingAssistant.content}${event.delta}` }
                : pending.streamingAssistant;
              pendingConversationsRef.current.set(projectId, {
                ...pending,
                runId: event.run_id ?? pending.runId,
                activity: nextActivity,
                streamingAssistant: nextStreamingAssistant,
              });
              if (
                activeIdRef.current === projectId
                && pendingConversationsRef.current.get(projectId)?.token === pendingToken
              ) {
                setConversationActivity(nextActivity);
                conversationActivityRef.current = nextActivity;
                if (event.stage !== 'request_created') setConversationRunId(event.run_id ?? pending.runId);
                if (event.stage === 'assistant_delta') {
                  // Keep every delta in the pending record, but render at most once per paint.
                  if (streamRenderFrame.current === null) streamRenderFrame.current = requestAnimationFrame(() => {
                    streamRenderFrame.current = null;
                    const latest = pendingConversationsRef.current.get(activeIdRef.current ?? '');
                    if (latest) setStreamingAssistant(latest.streamingAssistant);
                  });
                } else setStreamingAssistant(nextStreamingAssistant);
              }
            },
            reviewEvidence,
            replaceMessageId,
            retryRunId,
          )
        : await apiClient.sendMessage(projectId, text, currentSelection, reviewEvidence, replaceMessageId, retryRunId);
      const cachedAfterResponse = projectCacheRef.current.get(projectId);
      if (cachedAfterResponse) {
        projectCacheRef.current.set(
          projectId,
          mergeResponseMessages(cachedAfterResponse, optimisticId, [response.user_message, response.assistant_message], targetId),
        );
      }
      if (pendingConversationsRef.current.get(projectId)?.token === pendingToken) {
        pendingConversationsRef.current.delete(projectId);
      }
      if (activeIdRef.current === projectId) {
        if (response.error && response.error.code !== 'cancelled') setConversationError({
          projectId, text: conversationErrorMessage(response.error.code) ?? t('服务端错误，请稍后重试。'),
        });
        if (projectEpochRef.current !== projectEpoch) {
          setSending(false);
          setConversationActivity([]);
          conversationActivityRef.current = [];
          setConversationStartedAt(null);
          setConversationRunId(null);
          setStreamingAssistant(null);
          void loadProject(projectId);
          return;
        }
        setProject(current => {
          if (!current || current.project_id !== projectId) return current;
          return mergeResponseMessages(current, optimisticId, [response.user_message, response.assistant_message], targetId);
        });
        setStreamingAssistant(null);
        // Capture the stream before clearing the mutable ref below. React may
        // invoke the state updater after this callback returns.
        const completedActivity = response.assistant_message.thinking_summary
          ?? [...conversationActivityRef.current];
        setCompletedActivities(current => ({
          ...current,
          [activityCacheKey(projectId, response.assistant_message.message_id)]: completedActivity,
        }));
        setSending(false);
        setConversationActivity([]);
        conversationActivityRef.current = [];
        setConversationStartedAt(null);
        setConversationRunId(null);
        void loadProject(projectId);
      }
    } catch (e: unknown) {
      const failedPending = pendingConversationsRef.current.get(projectId);
      const streamErrorCode = typeof e === 'object'
        && e !== null
        && 'code' in e
        && typeof e.code === 'string'
        ? e.code
        : null;
      if (pendingConversationsRef.current.get(projectId)?.token === pendingToken) {
        pendingConversationsRef.current.delete(projectId);
      }
      const admissionRejected = isChatCapacityError(streamErrorCode)
        || ['chat_owner_busy', 'chat_queue_full', 'chat_wait_timeout', 'session_busy'].includes(streamErrorCode ?? '');
      if (admissionRejected) {
        const cached = projectCacheRef.current.get(projectId);
        if (cached) projectCacheRef.current.set(projectId, { ...cached, messages: originalMessages });
      }
      if (
        activeIdRef.current !== projectId
        || projectEpochRef.current !== projectEpoch
      ) {
        const cachedProject = projectCacheRef.current.get(projectId);
        if (cachedProject) projectCacheRef.current.set(projectId, stripTransientMessages(cachedProject));
        if (activeIdRef.current === projectId) {
          setSending(false);
          setConversationActivity([]);
          conversationActivityRef.current = [];
          setConversationStartedAt(null);
          setConversationRunId(null);
          setStreamingAssistant(null);
          void loadProject(projectId);
        }
        return;
      }
      if (admissionRejected) {
        setConversationError(isChatCapacityError(streamErrorCode)
          ? { projectId, text: t('此项目已达到聊天上限'), capacity: true }
          : { projectId, text: userFacingError(e, t('服务器错误，请稍后重试。')) });
        setProject(current => current?.project_id === projectId ? { ...current, messages: originalMessages } : current);
        if (replacement) {
          setRejectedEdit({ projectId, messageId: replacement.messageId, content: replacement.content });
          setEditingMessageId(replacement.messageId);
        } else {
          setInput(current => current || text);
        }
        void loadProject(projectId);
        return;
      }
      const cancelled = streamErrorCode === 'cancelled'
        || (e instanceof Error && e.message === t("本轮回答已取消。"));
      const visibleError = userFacingError(e, t('服务端错误，请稍后重试。'));
      if (!cancelled) setConversationError({ projectId, text: visibleError });
      const failureSummary: RuntimeProgressEvent = {
        stage: cancelled ? 'cancelled' : 'failed', label: cancelled ? t('已取消') : visibleError,
        status: cancelled ? 'cancelled' : 'failed', kind: 'summary', visible: true,
        elapsed_ms: Date.now() - startedAt, timestamp: new Date().toISOString(),
      };
      const err: Message = {
        ...(failedPending?.streamingAssistant ?? initialStreamingAssistant),
        message_id: `client:failed:${Date.now()}`,
        latency_ms: Date.now() - startedAt,
        error: cancelled ? 'cancelled' : 'message_failed',
      };
      setCompletedActivities(current => ({ ...current,
        [activityCacheKey(projectId, err.message_id)]: [...(failedPending?.activity ?? []), failureSummary],
      }));
      setProject(current => {
        if (!current || current.project_id !== projectId) return current;
        return {
          ...current,
          messages: streamErrorCode === 'last_message_changed' || streamErrorCode === 'session_busy'
            ? originalMessages : [...current.messages.map(message => message.message_id === optimisticId
              ? { ...message, trace_id: failedPending?.runId ?? undefined } : message), err],
        };
      });
      setConversationActivity([]);
      conversationActivityRef.current = [];
      setConversationStartedAt(null);
      setConversationRunId(null);
      setStreamingAssistant(null);
    } finally {
      if (
        activeIdRef.current === projectId
        && projectEpochRef.current === projectEpoch
      ) {
        setSending(false);
        setConversationActivity([]);
        conversationActivityRef.current = [];
        setConversationStartedAt(null);
        setConversationRunId(null);
        setStreamingAssistant(null);
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Virtual keyboards label Enter as a newline; sending stays on the explicit button.
    if (isPhone || window.matchMedia('(pointer: coarse)').matches) return;
    if (e.key === 'Enter' && !e.shiftKey && !sending) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function selectConversationModel(model: string) {
    if (!activeId || project?.project_id !== activeId) return;
    const projectId = activeId;
    try {
      await apiClient.setProjectModel(projectId, model);
      setProject(current => current?.project_id === projectId
        ? { ...current, model_override: model }
        : current);
    } catch (error: unknown) {
      setLoadError(userFacingError(error, t("项目模型暂时未更新，请稍后重试。")));
    }
  }

  async function selectConversationThinking(level: import('./types').ThinkingLevel) {
    const selectedModel = project?.model_override ?? settings?.model ?? '';
    if (!selectedModel) return;
    try {
      const next = await apiClient.selectModel(selectedModel, level);
      setSettings(next);
    } catch (error: unknown) {
      setLoadError(userFacingError(error, t("思考强度暂时未更新，请稍后重试。")));
    }
  }

  async function controlConversation() {
    const projectId = activeIdRef.current;
    const runId = conversationRunId;
    if (!projectId || !runId) return;
    try {
      await apiClient.cancelRun(projectId, runId);
      const event: RuntimeProgressEvent = {
        run_id: runId,
        stage: 'run_cancelling',
        label: t("正在取消"),
        status: 'running',
        elapsed_ms: 0,
      };
      const pending = pendingConversationsRef.current.get(projectId);
      if (pending && pending.runId === runId) {
        const nextActivity = mergeProgressEvents(pending.activity, event);
        pendingConversationsRef.current.set(projectId, { ...pending, activity: nextActivity });
        if (activeIdRef.current === projectId) {
          setConversationActivity(nextActivity);
          conversationActivityRef.current = nextActivity;
        }
      }
    } catch (error: unknown) {
      if (activeIdRef.current === projectId) {
        setLoadError(userFacingError(error, t("当前操作未完成，请重试。")));
      }
    }
  }

  function toggleEvidenceReview() {
    setReviewEvidence(current => {
      const next = !current;
      window.localStorage.setItem(REVIEW_PREFERENCE_KEY, String(next));
      return next;
    });
  }

  async function queueTopic(request: TopicRequest) {
    setInput(request.prompt);
    if (singlePageProject) setRepositoryOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openEvidence(evidence: GraphEvidence) {
    if (!evidence.path || !activeId || !snapshot) return;
    setSourceModal({
      projectId: activeId,
      snapshotId: snapshot.snapshot_id,
      projectEpoch: projectEpochRef.current,
      path: evidence.path,
      line: evidence.start_line ?? 1,
      stableId: evidence.stable_id,
    });
  }

  const openMessageEvidence = useCallback((path: string, line: number, snapshotId?: string | null, stableId?: string | null) => {
    if (!activeId || !snapshot) return;
    setSourceModal({
      projectId: activeId,
      snapshotId: snapshotId ?? snapshot.snapshot_id,
      projectEpoch: projectEpochRef.current,
      path,
      line,
      stableId,
    });
  }, [activeId, snapshot]);

  async function handleProjectCreated(id: string) {
    rememberAnalysisStart(id, null, null, true);
    setShowNew(false);
    const ps = await apiClient.listProjects();
    setProjects(ps); setActiveId(id);
  }

  async function reanalyzeProject() {
    if (!activeId) return;
    const projectId = activeId;
    const projectEpoch = projectEpochRef.current;
    setLoadError('');
    setAnalysisDismissed(false);
    rememberAnalysisStart(projectId, null, null, true);
    try {
      const status = await apiClient.reanalyze(projectId);
      if (
        activeIdRef.current !== projectId
        || projectEpochRef.current !== projectEpoch
      ) return;
      rememberAnalysisStart(projectId, status.job_id, null);
      setAnalysisJobId(status.job_id);
      setAnalysisJobStatus(status.job_status);
      await loadProject(projectId);
    } catch (error: unknown) {
      if (
        activeIdRef.current === projectId
        && projectEpochRef.current === projectEpoch
      ) {
        setLoadError(userFacingError(error, t("分析暂时未完成，请稍后重试。")));
      }
    }
  }

  async function deleteProject(id: string) {
    setProjectMenuId(null);
    setActionError('');
    try {
      await apiClient.deleteProject(id);
      removeSnapshotCache(id);
      projectCacheRef.current.delete(id);
      pendingConversationsRef.current.delete(id);
      for (const key of analysisTimerStartsRef.current.keys()) {
        if (key.startsWith(`${id}:`)) analysisTimerStartsRef.current.delete(key);
      }
      const ps = await apiClient.listProjects();
      setProjects(ps);
      if (activeIdRef.current === id) { setActiveId(null); setProject(null); }
    } catch (error: unknown) {
      setActionError(userFacingError(error, t("项目删除暂时未完成，请稍后重试。")));
    }
  }

  function beginProjectRename(summary: ProjectSummary) {
    setProjectMenuId(null);
    setRenamingProjectId(summary.project_id);
    setRenameDraft(summary.title);
  }

  async function renameProject(id: string) {
    const title = renameDraft.trim();
    if (!title) {
      renameInputRef.current?.focus();
      return;
    }
    try {
      const updated = await apiClient.renameProject(id, title);
      setProjects(current => current.map(item => item.project_id === id ? updated : item));
      setProject(current => current?.project_id === id
        ? { ...current, title: updated.title, updated_at: updated.updated_at }
        : current);
      setRenamingProjectId(null);
      setRenameDraft('');
    } catch (error: unknown) {
      setLoadError(userFacingError(error, t("项目名称暂时未更新，请稍后重试。")));
    }
  }

  function jumpToMessage(messageId: string) {
    messageRefs.current.get(messageId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizeCleanup.current?.();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = handle.previousElementSibling?.getBoundingClientRect().width || sidebarWidth;
    let boundary: { time: number; x: number } | null = null;
    let previousX = startX;
    document.body.classList.add('col-resizing');
    const resize = (move: PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      const maxWidth = Math.max(sidebarMinWidth, Math.floor(window.innerWidth / 3));
      const width = startWidth + move.clientX - startX;
      setSidebarWidth(Math.min(maxWidth, Math.max(sidebarMinWidth, width)));
      if (width > sidebarMinWidth) boundary = null;
      else if (!boundary) boundary = { time: performance.now(), x: move.clientX };
      else if (move.clientX < previousX && boundary.x - move.clientX >= 24 && performance.now() - boundary.time >= 180) {
        // A stationary pointer never collapses the rail: it needs another leftward move.
        stop();
        setSidebarCollapsed(true);
      }
      previousX = move.clientX;
    };
    const stop = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      sidebarResizeCleanup.current = null;
    };
    sidebarResizeCleanup.current = stop;
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
  }

  function startRepositoryResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const renderedWidth = event.currentTarget.nextElementSibling?.getBoundingClientRect().width;
    const startWidth = renderedWidth || repositoryWidth;
    document.body.classList.add('col-resizing');
    const resize = (move: PointerEvent) => {
      const mainWidth = mainRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const maxWidth = Math.max(
        0,
        mainWidth - CHAT_PANE_MIN_WIDTH - PANE_RESIZER_WIDTH - REPOSITORY_PANE_MARGIN,
      );
      const minWidth = Math.min(REPOSITORY_MIN_WIDTH, maxWidth);
      setRepositoryWidth(Math.min(
        maxWidth,
        Math.max(minWidth, startWidth - move.clientX + startX),
      ));
    };
    const stop = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop);
  }

  if (!authReady) {
    return (
      <main className="auth-shell" aria-label={t("正在加载")}>
        <div className="auth-loading"><div className="spinner" /><span>{t("正在加载…")}</span></div>
        <ComplianceFooter />
      </main>
    );
  }
  if (!authConfig) {
    return (
      <main className="auth-shell">
        <div className="auth-error">{authError || t("登录服务暂时不可用，请稍后重试。")}</div>
        <ComplianceFooter />
      </main>
    );
  }
  if (!identity) {
    return (
      <LoginScreen
        config={authConfig}
        loading={authLoading}
        error={authError}
        onGuest={loginAsGuest}
      />
    );
  }

  const analysisStage = project?.analysis.stage ?? 'idle';
  const analysisJobActive = analysisJobStatus === 'queued' || analysisJobStatus === 'running';
  const analysisJobTerminal = ['succeeded', 'failed', 'cancelled'].includes(analysisJobStatus ?? '');
  const analysisCanRetry = !analysisJobActive
    && (analysisStage === 'failed' || analysisJobStatus === 'failed' || analysisJobStatus === 'cancelled');
  const analysisRetryMessage = analysisJobStatus === 'cancelled'
    ? t("分析已停止，可重新分析。")
    : t(analysisJobDetails?.error ?? project?.analysis.error ?? '服务端错误，请稍后重试。');
  const analysisRetryEvent: RuntimeProgressEvent | null = analysisJobStatus === 'queued'
    && analysisJobDetails?.error_code === 'analysis_retry_scheduled'
    ? { stage: 'provider_retry', status: 'running', kind: 'summary', visible: true,
        label: `${t((analysisJobDetails.error ?? '上游错误').replace(/，请.*。$/u, ''))}，${t('正在重试（{0}/{1}）', analysisJobDetails.attempt, Math.max(0, analysisJobDetails.max_attempts - 1))}`,
        elapsed_ms: analysisActivity.at(-1)?.elapsed_ms ?? 0 } : null;
  const analysisWaitingEvent: RuntimeProgressEvent | null = analysisJobDetails?.scheduling_state?.startsWith('waiting')
    ? { stage: analysisJobDetails.scheduling_state === 'waiting_owner' ? 'analysis_waiting_owner' : 'analysis_waiting_capacity',
      status: 'running', kind: 'summary', visible: true, elapsed_ms: 0,
      label: analysisJobDetails.scheduling_state === 'waiting_owner' ? '等待个人分析名额' : '正在等待分析' } : null;
  const isAnalyzing = !analysisJobTerminal
    && !analysisDismissed
    && (analysisJobActive || !['done', 'failed', 'idle'].includes(analysisStage));
  const modelForDisplay = project?.model_override ?? settings?.model ?? '';
  const availableModels = settings?.available_models ?? [];
  const selectedModelReady = modelReady(modelForDisplay, settings);
  const selectedConversationModel = settings?.model_options.find(option => option.selector === modelForDisplay) ?? null;
  const conversationThinkingLevels = selectedConversationModel?.thinking_levels ?? ['off'];
  const conversationThinkingMode = thinkingModeForOption(selectedConversationModel);
  const conversationThinkingLevel = conversationThinkingLevels.includes(settings?.thinking_level ?? 'off')
    ? settings?.thinking_level ?? 'off'
    : conversationThinkingLevels.at(-1) ?? 'off';
  const analysisStartedAt = activeId
    ? analysisTimerStartsRef.current.get(analysisTimerKey(activeId, analysisJobId)) ?? null
    : null;
  const nextTheme = theme.resolved === 'dark' ? 'light' : 'dark';

  return (
    <div className={`layout${isMobile && mobileSidebarOpen ? ' mobile-sidebar-open' : ''}`}>
      {isMobile && <header className="mobile-topbar">
        <div className="mobile-topbar-start">
          <button ref={mobileSidebarTrigger} type="button" className="btn btn-icon"
            aria-label={t('展开项目栏')} aria-expanded={mobileSidebarOpen} aria-controls="project-sidebar"
            onClick={() => setMobileSidebarOpen(true)}><PanelLeftOpen size={22} /></button>
          <ProjectGitHubLink compact />
          <button type="button" className="btn btn-icon" aria-label={t('新建项目')}
            onClick={() => setShowNew(true)}>
            <Plus className="sketch-action-icon sketch-action-plus" size={20} strokeWidth={2.35} />
          </button>
        </div>
        {project && snapshot && <button type="button" className="btn mobile-project-toggle"
          aria-label={repositoryOpen ? t('返回聊天') : t('展开项目视图')}
          aria-expanded={repositoryOpen} onClick={() => setRepositoryOpen(value => !value)}>
          <span>{repositoryOpen ? t('返回聊天') : t('项目视图')}</span><ActivityIcon name={repositoryOpen ? "chat" : "relations"} size={23} />
        </button>}
      </header>}
      {isMobile && <button type="button" className="mobile-sidebar-backdrop" tabIndex={-1}
        aria-label={t('收起项目栏')} aria-hidden={!mobileSidebarOpen} disabled={!mobileSidebarOpen}
        onClick={() => setMobileSidebarOpen(false)} />}
      {(actionError || mergeNotice) && (
        <div className={`global-notice${actionError ? ' global-notice-error' : ''}`} role={actionError ? 'alert' : 'status'}>
          <span>{actionError || mergeNotice}</span>
          <button className="btn btn-icon" type="button" aria-label={actionError ? t("关闭错误提示") : t("关闭迁移提示")} data-tooltip={t("关闭")}
            onClick={() => { if (actionError) setActionError(''); else setMergeNotice(''); }}><X size={14} /></button>
        </div>
      )}
      {/* Sidebar */}
      <div
        ref={sidebarRef} id="project-sidebar" inert={isMobile && !mobileSidebarOpen}
        role={isMobile ? 'dialog' : undefined} aria-modal={isMobile && mobileSidebarOpen ? true : undefined}
        aria-label={isMobile ? 'what-the-repo' : undefined}
        className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}
        style={{ width: sidebarCollapsed ? 48 : Math.max(sidebarMinWidth, sidebarWidth), minWidth: sidebarCollapsed ? 48 : Math.max(sidebarMinWidth, sidebarWidth) }}
      >
        <div ref={sidebarHeaderRef} className="sidebar-header">
          {!sidebarCollapsed && <span className="sidebar-title"><FieldMark /><span className="sidebar-product-name">what-the-repo</span><SketchDoodle variant="underline" className="sidebar-title-doodle" /></span>}
          <div className="sidebar-actions">
            <button className="btn btn-icon" data-tooltip={sidebarCollapsed ? t("展开项目栏") : t("收起项目栏")}
              aria-label={sidebarCollapsed ? t("展开项目栏") : t("收起项目栏")}
              onClick={() => isMobile ? setMobileSidebarOpen(false) : setSidebarCollapsed(value => !value)}>
              {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            </button>
          </div>
        </div>
        {!isMobile && <ProjectGitHubLink compact={sidebarCollapsed} />}
        <button className="sidebar-new-project" aria-label={t("新建项目")}
          data-tooltip={sidebarCollapsed ? t("新建项目") : undefined} onClick={() => setShowNew(true)}>
          <Plus className="sketch-action-icon sketch-action-plus" size={20} strokeWidth={2.35} />
          {!sidebarCollapsed && <span>{t("新建项目")}</span>}
        </button>
        {!sidebarCollapsed && <div className="sidebar-body">
          {projects.map(p => (
            <div key={p.project_id}
              className={`project-item${activeId === p.project_id ? ' active' : ''}`}
              onClick={() => {
                if (renamingProjectId === p.project_id) return;
                const cachedProject = projectCacheRef.current.get(p.project_id) ?? null;
                setProject(cachedProject);
                setSnapshot(getMemorySnapshot(p.project_id, cachedProject?.analysis.snapshot_id, getUiLanguage()));
                setActiveId(p.project_id);
                setMobileSidebarOpen(false);
                setShowNew(false);
                setProjectMenuId(null);
              }}>
              {renamingProjectId === p.project_id ? (
                <form className="project-rename" onClick={event => event.stopPropagation()}
                  onSubmit={event => { event.preventDefault(); void renameProject(p.project_id); }}>
                  <input ref={renameInputRef} value={renameDraft} aria-label={t("项目标题")}
                    maxLength={120} onChange={event => setRenameDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        setRenamingProjectId(null);
                        setRenameDraft('');
                      }
                    }} />
                  <button className="btn btn-icon" type="submit" aria-label={t("保存标题")} data-tooltip={t("保存")}>
                    <Check size={13} />
                  </button>
                  <button className="btn btn-icon" type="button" aria-label={t("取消重命名")} data-tooltip={t("取消")}
                    onClick={() => { setRenamingProjectId(null); setRenameDraft(''); }}>
                    <X size={13} />
                  </button>
                </form>
              ) : (
                <>
                  <div className="project-item-title">{p.title}</div>
                  <div className="project-menu-wrap" onPointerDown={event => event.stopPropagation()}>
                    <button className="btn btn-icon project-menu-button" type="button"
                      aria-label={t("打开 {0} 项目菜单", p.title)} aria-expanded={projectMenuId === p.project_id}
                      data-tooltip={t("更多")}
                      onClick={event => {
                        event.stopPropagation();
                        setProjectMenuId(current => current === p.project_id ? null : p.project_id);
                      }}>
                      <MoreHorizontal size={15} />
                    </button>
                    {projectMenuId === p.project_id && (
                      <div className="project-menu" role="menu"
                        onClick={event => event.stopPropagation()}>
                        <button type="button" role="menuitem" onClick={() => beginProjectRename(p)}>
                          <Pencil size={13} /> {t(" 重命名")}</button>
                        <button type="button" role="menuitem" className="danger"
                          onClick={() => { void deleteProject(p.project_id); }}>
                          <Trash2 size={13} /> {t(" 删除")}</button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          {projects.length === 0 && (
            <div style={{ padding: '24px 16px', color: 'var(--fg-muted)', fontSize: 12, textAlign: 'center' }}>
              {t("点击 + 创建学习项目")}</div>
          )}
        </div>}
        <div className={`sidebar-account${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div ref={accountRef} className="account-menu-wrap" onBlur={event => {
            // Safari may blur to no focused element before dispatching a touch click.
            // Outside pointerdown already dismisses the menu; only real focus transfers close it here.
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setAccountMenuOpen(false);
          }} onKeyDown={event => {
            if (event.key === 'Escape') {
              setAccountMenuOpen(false);
              accountRef.current?.querySelector<HTMLButtonElement>('.account-action')?.focus();
            } else if (accountMenuOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const items = Array.from(accountRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}>
              <button className="account-action" type="button"
                aria-haspopup="menu" aria-expanded={accountMenuOpen}
                aria-label={sidebarCollapsed ? t("账户菜单") : undefined}
                data-tooltip={accountMenuOpen ? undefined : t("账户菜单")}
                onClick={() => setAccountMenuOpen(value => !value)}>
                <UserRound className="account-user-icon" size={28} strokeWidth={2.1} />
                {!sidebarCollapsed && <span><strong>{identity.kind === 'guest' ? t("访客") : identity.display_name}</strong>
                  <small>{identity.kind === 'guest' ? t("登录并同步") : `@${identity.login}`}</small></span>}
              </button>
            {accountMenuOpen && (
              <div className="account-menu" role="menu" aria-label={t("账户菜单")}>
                {identity.kind === 'guest'
                  ? <button type="button" role="menuitem" onClick={() => { window.location.href = apiClient.githubLoginUrl('/'); }}>
                      <UserRound size={18} /> {t("使用 GitHub 登录")}</button>
                  : <button type="button" role="menuitem" className="danger" onClick={logout}>
                      <LogOut size={16} strokeWidth={2.1} /> {t(" 退出登录")}</button>}
                <div className="account-language-title">{t('界面语言')}</div>
                {(['zh-CN', 'en'] as const).map(language => <button key={language} type="button" role="menuitemradio"
                  aria-checked={uiLanguage === language} onClick={() => {
                    setUiLanguage(language); setAccountMenuOpen(false);
                    accountRef.current?.querySelector<HTMLButtonElement>('.account-action')?.focus();
                  }}>
                  <span>{language === 'zh-CN' ? '简体中文' : 'English'}</span>
                  {uiLanguage === language && <Check size={15} />}
                </button>)}
              </div>
            )}
          </div>
          <button className="btn btn-icon sidebar-settings-button" aria-label={t("设置")} data-tooltip={t("设置")} onClick={() => setShowSettings(true)}>
            <Settings size={18} />
          </button>
          <button className="btn btn-icon sidebar-theme-button" type="button"
            data-tooltip={t("切换到{0}主题", nextTheme === 'dark' ? t("深色") : t("浅色"))}
            aria-label={t("切换到{0}主题", nextTheme === 'dark' ? t("深色") : t("浅色"))}
            onClick={() => theme.setPreference(nextTheme)}>
            {theme.resolved === 'dark'
              ? <Sun className="sketch-theme-icon" size={18} strokeWidth={2.15} />
              : <Moon className="sketch-theme-icon" size={18} strokeWidth={2.15} />}
          </button>
        </div>
      </div>
      <div
        className={`pane-resizer sidebar-resizer${sidebarCollapsed ? ' hidden' : ''}`}
        role="separator"
        aria-label={t("调整项目栏宽度")} aria-orientation="vertical"
        aria-hidden={sidebarCollapsed}
        tabIndex={sidebarCollapsed ? -1 : 0} aria-valuemin={sidebarMinWidth} aria-valuenow={sidebarWidth}
        aria-valuemax={Math.max(sidebarMinWidth, Math.floor(window.innerWidth / 3))}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (event.key === 'ArrowLeft' && sidebarWidth <= sidebarMinWidth) setSidebarCollapsed(true);
            else setSidebarWidth(width => Math.min(Math.max(sidebarMinWidth, Math.floor(window.innerWidth / 3)), Math.max(sidebarMinWidth, width + (event.key === 'ArrowLeft' ? -10 : 10))));
          }
        }}
        onPointerDown={startSidebarResize} onDoubleClick={() => setSidebarWidth(Math.max(260, sidebarMinWidth))} />

      {/* Main */}
      <div className="main" ref={mainRef} inert={isMobile && mobileSidebarOpen}>
        {!project ? (
          activeId && loadError ? (
            <div className="empty-state">
              <div className="workspace-error">
                <strong>{t("加载失败")}</strong>
                <span>{loadError}</span>
                <button className="btn" onClick={() => loadProject(activeId)}>{t("重试")}</button>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <FieldScene />
              <h2>{t('从好奇开始。')}</h2>
              <p>{t("快速理解，深入学习陌生仓库")}</p>
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                <Plus className="sketch-action-icon sketch-action-plus" size={17} strokeWidth={2.35} /> {t(" 新建项目")}</button>
            </div>
          )
        ) : (
          <div className={`product-workspace${repositoryOpen ? ' repository-open' : ''}${singlePageProject ? ' single-page-project' : ''}`}>
            <aside className="teaching-pane" inert={singlePageProject && repositoryOpen}>
              {!isMobile && (
                <div className="chat-toolbar">
                  {snapshot && <button className={`repository-peek${repositoryOpen ? ' active' : ''}`}
                    type="button"
                    aria-label={repositoryOpen ? t("收起项目视图") : t("展开项目视图")}
                    onClick={() => setRepositoryOpen(value => !value)}>
                    <span className="repository-peek-visual">
                      <RepositoryThumbnail snapshot={snapshot} />
                    </span>
                    <span className="repository-peek-copy">
                      <strong>{t("项目视图")}</strong>
                      <span>{snapshot.graph.nodes.filter(node => (node.entity_kind ?? 'component') === 'component').length} {t(" 组件 · ")}{snapshot.graph.edges.filter(edge => !edge.id.startsWith('hierarchy:edge:')).length} {t(" 关系")}</span>
                    </span>
                  </button>}
                </div>
              )}
              {project.messages.some(message => message.role === 'user') && (
                <nav className="message-rail" aria-label={t("快速浏览你的消息")}>
                  {project.messages.filter(message => message.role === 'user').map(message => {
                    const preview = messagePreview(message.content) || t("空消息");
                    return (
                      <button type="button" className="message-jump" key={message.message_id}
                        aria-label={t("跳转到你的消息：{0}", preview)}
                        data-preview={preview}
                        onClick={() => jumpToMessage(message.message_id)}>
                        <span className="message-jump-line" />
                      </button>
                    );
                  })}
                </nav>
              )}
              <div className="chat-area" ref={chatScrollRef}>
                <div className="chat-messages">
                {isAnalyzing && (
                  <ActivityDisclosure
                    events={analysisRetryEvent ? [...analysisActivity, analysisRetryEvent] : analysisWaitingEvent ? [analysisWaitingEvent] : analysisActivity}
                    startedAt={Number.isFinite(analysisStartedAt) ? analysisStartedAt : null}
                    exactStages
                    testId="analysis-activity"
                  />
                )}
                {analysisCanRetry && (
                  <div className="chat-analysis-error">
                    <span>{analysisRetryMessage}</span>
                    <button className="btn" type="button" onClick={reanalyzeProject}>
                      <RefreshCw size={12} /> {t(" 重新分析")}</button>
                  </div>
                )}
                {project.source.commit_sha && (
                  <div className="repository-version-strip" role="status">
                    {t("仓库版本 ")}<code>{project.source.commit_sha.slice(0, 12)}</code>
                  </div>
                )}
                {project.repository_migration?.status === 'executed' && (
                  <div className="repository-migration-card" role="status">
                    <div className="repository-migration-heading">
                      <strong>{t("已更新到新的仓库版本")}</strong>
                      <span>{project.repository_migration.from_commit_sha.slice(0, 12)} → {project.repository_migration.to_commit_sha.slice(0, 12)}</span>
                    </div>
                    <p>{t("项目已更新到新的仓库版本，历史回答保留原版本标注。")}</p>
                  </div>
                )}
                {project.messages.length === 0 && (
                  <div className="chat-empty">
                    <FieldIllustration compact />
                    {isAnalyzing ? t("仓库准备好后就可以尽情提问。") : (
                      <span>{t("尽情提问，或从右上角打开")}<span className="chat-empty-project-view">{t("项目视图")}<SketchDoodle variant="circle" className="chat-empty-project-circle" />
                        </span>{t('。')}
                      </span>
                    )}
                  </div>
                )}
                {project.messages.map((msg, index) => {
                  const previousModel = [...project.messages.slice(0, index)]
                    .reverse()
                    .find(message => message.role === 'assistant' && message.model)?.model ?? null;
                  const nextAssistantModel = project.messages.slice(index)
                    .find(message => message.role === 'assistant' && message.model)?.model ?? null;
                  const modelChanged = msg.role === 'user'
                    && project.messages[index - 1]?.role === 'assistant'
                    && Boolean(nextAssistantModel)
                    && Boolean(previousModel)
                    && nextAssistantModel !== previousModel;
                  return (
                    <Fragment key={msg.message_id}>
                      {modelChanged && (
                        <div className="message-model-change" role="separator">
                          <span />
                          <Box size={13} aria-hidden="true" />
                          <span>{t("模型已从 ")}{modelLabel(previousModel ?? '', settings)} {t(" 更改为 ")}{modelLabel(nextAssistantModel ?? '', settings)}{t('。')}</span>
                          <span />
                        </div>
                      )}
                      <MsgBubble msg={msg}
                        onEdit={!sending && msg.role === 'user' && !project.messages.slice(index + 1).some(message => message.role === 'user')
                          ? () => { setRejectedEdit(null); setEditingMessageId(msg.message_id); } : undefined}
                        edit={editingMessageId === msg.message_id && !sending ? {
                          content: rejectedEdit?.projectId === project.project_id && rejectedEdit.messageId === msg.message_id
                            ? rejectedEdit.content : undefined,
                          onCancel: () => setEditingMessageId(null),
                          onSubmit: content => { void sendMessage({ messageId: msg.message_id, content }); },
                        } : undefined}
                        onResend={!sending && msg.role === 'user' && !project.messages.slice(index + 1).some(message => message.role === 'user')
                          ? () => { void sendMessage({ messageId: msg.message_id, content: msg.content }); } : undefined}
                        activity={completedActivities[activityCacheKey(project.project_id, msg.message_id)]}
                        onEvidenceClick={openMessageEvidence}
                        onFeedback={submitMessageFeedback}
                        onLearningAction={resolveLearningAction}
                        feedbackPending={Boolean(feedbackPending[msg.message_id])}
                        learningActionPending={Boolean(learningActionPending[msg.learning_action?.action_id ?? ''])}
                        messageRef={node => registerMessageRef(msg.message_id, node)} />
                    </Fragment>
                  );
                })}
                {sending && streamingAssistant?.content ? (
                  <MsgBubble msg={streamingAssistant}
                    activity={conversationActivity}
                    activityStartedAt={conversationStartedAt}
                    onEvidenceClick={openMessageEvidence}
                    onFeedback={submitMessageFeedback}
                    onLearningAction={resolveLearningAction}
                    feedbackEnabled={false} />
                ) : sending ? (
                  <ConversationActivity events={conversationActivity}
                    startedAt={conversationStartedAt} />
                ) : null}
                {!sending && (conversationError?.projectId === project.project_id
                  ? <ConversationErrorNotice text={conversationError.capacity ? t('此项目已达到聊天上限') : conversationError.text} />
                  : newMessageBlocked && <ConversationErrorNotice text={t('此项目已达到聊天上限')} />)}
                </div>
              </div>
              <div className="composer-wrap">
                <div className="composer-inner">
                <div className="composer-surface"><InkOutline paper />
                  <textarea className="composer-textarea" rows={1} enterKeyHint="enter"
                    ref={composerRef}
                    placeholder={t("尽情提问")}
                     value={input} onChange={e => {
                       setInput(e.target.value);
                       setConversationError(current => current?.projectId === project.project_id && current.capacity ? null : current);
                     }}
                    onKeyDown={handleKeyDown} />
                  <div className="composer-controls"
                    onPointerDownCapture={event => {
                      // Keep an existing editing session focused while tapping controls or menu options.
                      // Cancelling pointer focus does not cancel click or native menu scrolling.
                      if (document.activeElement === composerRef.current && (event.target as Element).closest('button')) event.preventDefault();
                    }}
                    onMouseDownCapture={event => {
                      if (document.activeElement === composerRef.current && (event.target as Element).closest('button')) event.preventDefault();
                    }}>
                    <div className="composer-controls-left">
                      {availableModels.length > 0 ? (
                        <ConversationModelSelect
                          value={modelForDisplay}
                          availableModels={availableModels}
                          settings={settings}
                          disabled={sending}
                          onChange={next => { void selectConversationModel(next); }} />
                      ) : modelForDisplay ? (
                        <span className="composer-model-label" aria-label={modelForDisplay}><ActivityIcon className="narrow-model-icon" name="model" size={24} /><span className="wide-model-label">{modelForDisplay}</span></span>
                      ) : (
                        <button className="composer-configure" type="button"
                          aria-label={t("配置模型")}
                          onClick={() => setShowSettings(true)}>
                          <ActivityIcon className="narrow-model-icon" name="model" size={24} /><span className="wide-model-label"><Settings size={12} /> {t(" 配置模型")}</span></button>
                      )}
                      <SketchSelect compact className="thinking-select" ariaLabel={t("思考程度")} menuTitle={t("思考程度")}
                        value={conversationThinkingMode === 'provider-default' ? 'off' : conversationThinkingLevel}
                        disabled={sending || !selectedModelReady || conversationThinkingMode === 'provider-default'}
                        options={thinkingSelectOptions(conversationThinkingLevels, conversationThinkingMode)}
                        onChange={next => void selectConversationThinking(next as import('./types').ThinkingLevel)} />
                      <button type="button" role="switch" aria-checked={reviewEvidence}
                        aria-label={t("核对代码")}
                        className={`review-toggle${reviewEvidence ? ' active' : ''}`}
                        data-tooltip={t("回答前再核对一次代码依据，会多花一些时间。")}
                        onClick={toggleEvidenceReview}>
                        <ShieldCheck size={13} />
                        <span>{t("核对代码")}</span>
                        <i aria-hidden="true" />
                      </button>
                    </div>
                    {sending ? (
                      <div className="composer-run-controls">
                        <button className="send-button composer-cancel-button" type="button" onClick={() => void controlConversation()}
                          aria-label={t("取消本轮回答")} data-tooltip={t("取消本轮回答")} disabled={!conversationRunId}>
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <button className="send-button" onClick={() => void sendMessage()}
                        aria-label={t("发送消息")}
                        disabled={
                          project?.project_id !== activeId
                          || !input.trim()
                          || !selectedModelReady
                          || newMessageBlocked
                        }>
                        <Send className="sketch-action-icon sketch-action-send" size={30} />
                      </button>
                    )}
                  </div>
                </div>
                </div>
              </div>
            </aside>
            <div
              className={`pane-resizer repository-resizer${repositoryOpen ? '' : ' hidden'}`}
              role="separator"
              aria-label={t("调整对话与项目视图宽度")} aria-orientation="vertical"
              aria-hidden={!repositoryOpen}
              onPointerDown={startRepositoryResize}
              onDoubleClick={() => setRepositoryWidth(REPOSITORY_DEFAULT_WIDTH)} />
            <div className={`repository-pane${repositoryOpen ? ' open' : ' collapsed'}`}
              style={{
                width: repositoryOpen ? repositoryWidth : 0,
                maxWidth: repositoryOpen
                  ? `calc(100% - ${CHAT_PANE_MIN_WIDTH + PANE_RESIZER_WIDTH + REPOSITORY_PANE_MARGIN}px)`
                  : 0,
              }}
              aria-hidden={!repositoryOpen}>
              {isPhoneLandscape && repositoryOpen && <div className="landscape-project-navigation"><button type="button" className="btn" onClick={() => setRepositoryOpen(false)}><ActivityIcon name="chat" size={22} />{t('返回聊天')}</button></div>}
              {loadError ? (
                <div className="workspace-error">
                  <strong>{t("加载失败")}</strong>
                  <span>{loadError}</span>
                  <button className="btn" onClick={() => activeId && loadProject(activeId)}>{t("重试")}</button>
                </div>
              ) : snapshot ? (
                (!singlePageProject || repositoryOpen) && <LazyLoadBoundary beforeReload={() => {
                  if (input.trim() || editingMessageId || pendingConversationsRef.current.size > 0) {
                    return window.confirm(t('重新加载会中断当前回答并清除未发送的内容。请先复制保存草稿。仍要继续吗？'));
                  }
                  return true;
                }}><Suspense fallback={<div className="workspace-loading"><div className="spinner" /></div>}><RepositoryWorkspace
                  snapshot={snapshot}
                  project={project}
                  onOpenEvidence={openEvidence}
                  onQueueTopic={queueTopic}
                  onSelectionChange={setConversationSelection}
                /></Suspense></LazyLoadBoundary>
              ) : (
                <div className="workspace-loading">
                  {isAnalyzing && <div className="spinner" />}
                  <strong>{isAnalyzing ? stageLabel(analysisStage) : t("分析结果尚未可用")}</strong>
                  {project.analysis.error && <span>{t("分析结果暂时不可用，请稍后重试。")}</span>}
                </div>
              )}
            </div>
          </div>
        )}
        <ComplianceFooter />
      </div>

      {showNew && <NewProjectDialog onCreated={handleProjectCreated} onClose={() => setShowNew(false)} />}
      {showSettings && (
        <SettingsDialog
          identity={identity}
          onClose={async () => {
            setShowSettings(false);
            const s = await apiClient.getSettings().catch(() => null);
            if (s) setSettings(s);
          }}
        />
      )}
      {sourceModal
        && sourceModal.projectId === activeId
        && sourceModal.projectEpoch === projectEpochRef.current && (
        <SourceModal key={`${sourceModal.projectId}:${sourceModal.snapshotId}:${sourceModal.path}:${sourceModal.line}:${sourceModal.stableId ?? ''}`}
          projectId={sourceModal.projectId} snapshotId={sourceModal.snapshotId}
          path={sourceModal.path} line={sourceModal.line} stableId={sourceModal.stableId}
          onClose={() => setSourceModal(null)} />
      )}
    </div>
  );
}
