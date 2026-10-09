import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProjectGrowthMark } from './ProjectGrowthMark';
import { projectGrowth, projectGrowthLabel } from './project-growth';
import type { TeachingPhase } from './types';
import { setUiLanguage } from './ui-language';

afterEach(() => { setUiLanguage('zh-CN'); });

it('grows from a seed before a route starts, to a sprout while learning, to a small tree once the route is done', () => {
  const growth = (['orienting', 'proposing', 'explaining', 'assessing', 'remediating', 'completed'] as TeachingPhase[]).map(projectGrowth);
  expect(growth).toEqual(['seed', 'seed', 'sprout', 'sprout', 'sprout', 'tree']);
  expect(projectGrowth(undefined)).toBe('seed');
});

it('names the state for screen readers and on hover, in both languages', () => {
  setUiLanguage('zh-CN');
  expect(['seed', 'sprout', 'tree'].map(value => projectGrowthLabel(value as 'seed'))).toEqual(['还没开始学习', '正在学习', '已学完这条路线']);
  render(<button type="button" aria-label="打开项目 acme/tiny-agent" aria-describedby="growth-1">
    <ProjectGrowthMark id="growth-1" phase="assessing" /><span>acme/tiny-agent</span>
  </button>);
  const button = screen.getByRole('button', { name: '打开项目 acme/tiny-agent' });
  expect(button).toHaveAccessibleDescription('正在学习');
  const mark = document.getElementById('growth-1')!;
  expect(mark.dataset.growth).toBe('sprout');
  expect(mark.dataset.tooltip).toBe('正在学习');
  expect(mark.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

  setUiLanguage('en');
  expect(projectGrowthLabel('tree')).toBe('Finished this learning route');
  expect(projectGrowthLabel('seed')).toBe('Not started learning yet');
});
