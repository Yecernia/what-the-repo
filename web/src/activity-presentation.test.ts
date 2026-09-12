import { afterEach, describe, expect, it } from 'vitest';
import { activityIconName, activityPhaseKey, activityPhaseLabel, activityStatusLabel, analysisEventLabel, analysisIcons, analysisProgressLabels, phaseIcons } from './activity-presentation';
import { setUiLanguage } from './ui-language';
import type { RuntimeProgressEvent } from './types';

const event = (changes: Partial<RuntimeProgressEvent>): RuntimeProgressEvent => ({ stage: 'run_started', label: '', status: 'running', elapsed_ms: 0, ...changes });
afterEach(() => setUiLanguage('zh-CN'));

describe('summary presentation', () => {
  it('renders batch counts, replay and partial results in both languages', () => {
    const input = event({ stage: 'analysis:explaining_components:5', event_type: 'analysis_progress',
      analysis_progress: { kind: 'explaining_components', sequence: 5, status: 'running', timestamp: '', elapsed_ms: 0,
        completed_batches: 2, total_batches: 3, reused_batches: 1 } });
    setUiLanguage('zh-CN');
    expect(analysisEventLabel(input)).toContain('2/3 批');
    for (const status of ['skipped', 'degraded', 'reused', 'cancelled', 'failed'] as const) {
      input.analysis_progress!.status = status;
      expect(activityStatusLabel(input)).toBeTruthy();
      setUiLanguage('en');
      expect(activityStatusLabel(input)).not.toMatch(/[\u3400-\u9fff]/u);
      expect(analysisEventLabel(input)).toContain('1 batches reused');
      setUiLanguage('zh-CN');
    }
  });
  it('uses the same chat phase for the label and drawing, even when the label mentions code', () => {
    for (const [stage, phase] of [['understanding', 'understanding'], ['context', 'context'], ['reasoning', 'planning'], ['answer', 'answer']] as const) {
      const input = event({ display_stage: stage, stage, label: '正在解释相关代码' });
      expect(activityPhaseKey(input)).toBe(phase);
      expect(activityIconName(input)).toBe(phaseIcons[phase]);
    }
  });
  it('covers every analysis event independently of translated labels', () => {
    for (const kind of Object.keys(analysisProgressLabels)) {
      const input = event({ stage: `analysis:${kind}:1`, event_type: 'analysis_progress', label: 'unrelated translated label' });
      expect(activityIconName(input, true)).toBe(analysisIcons[kind]);
      expect(analysisEventLabel(input)).not.toBe(input.label);
    }
    expect(activityIconName(event({ stage: 'analysis:fetching:queued' }), true)).toBe('wait');
    expect(activityIconName(event({ stage: 'analysis:clustering:running' }), true)).toBe('components');
  });
  it('shows interruption and tool failure as their real status, with English translations', () => {
    setUiLanguage('en');
    for (const [status, icon] of [['paused','stop'], ['cancelled','stop'], ['failed','warning']] as const) {
      const input = event({ status });
      expect(activityIconName(input)).toBe(icon);
      expect(activityStatusLabel(input)).toBeTruthy();
      expect(activityStatusLabel(input)).not.toMatch(/[\u3400-\u9fff]/u);
    }
    expect(activityStatusLabel(event({ kind: 'tool', status: 'failed' }))).toBe('The lookup did not finish. Adjusting the query');
    expect(activityIconName(event({ stage: 'run_cancelling' }))).toBe('stop');
  });
  it('provides both active and completed English labels for all chat phases', () => {
    setUiLanguage('en');
    for (const phase of Object.keys(phaseIcons) as Array<keyof typeof phaseIcons>) {
      for (const status of ['running', 'completed'] as const) expect(activityPhaseLabel(phase, status)).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });
});
