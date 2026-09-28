import { afterEach, expect, it, vi } from 'vitest';
import hljs from 'highlight.js/lib/common';
import { highlightedSourceLine, sourceLanguage } from './source-highlighting';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['packages/markitdown-mcp/Dockerfile', 'dockerfile', 'FROM python:3.12'],
  ['Dockerfile.dev', 'dockerfile', 'RUN echo hello'],
  ['build.dockerfile', 'dockerfile', 'FROM node:24'],
  ['build.ps1', 'powershell', 'Write-Host "hello"'],
  ['main.jl', 'julia', 'function hello()'],
  ['main.erl', 'erlang', '-module(hello).'],
  ['main.hrl', 'erlang', '-define(HELLO, 1).'],
  ['main.ex', 'elixir', 'defmodule Hello do'],
  ['main.exs', 'elixir', 'def hello do'],
  ['main.hs', 'haskell', 'import Data.List'],
  ['main.lhs', 'haskell', 'import Data.List'],
  ['main.vb', 'vbnet', 'Public Class Hello'],
  ['main.vbs', 'vbscript', 'Dim hello'],
  ['pyproject.toml', 'ini', '[project]'],
  ['README.md', 'markdown', '# Hello'],
  ['main.py', 'python', 'def hello():'],
])('renders %s with its registered grammar', (path, language, source) => {
  expect(sourceLanguage(path)).toBe(language);
  expect(highlightedSourceLine(source, language)).toContain('class="hljs-');
});

it.each(['unknown.xyz', 'file.constructor', 'file.__proto__'])('safely renders unknown file type %s', path => {
  expect(sourceLanguage(path)).toBe('plaintext');
  expect(highlightedSourceLine('<script>&', sourceLanguage(path))).toBe('&lt;script&gt;&amp;');
});

it('falls back to escaped plaintext when a grammar is unavailable', () => {
  expect(highlightedSourceLine('<img src=x onerror=alert(1)>', 'not-loaded')).toBe('&lt;img src=x onerror=alert(1)&gt;');
});

it('lets React render the original text when the highlighter throws', () => {
  vi.spyOn(hljs, 'highlight').mockImplementation(() => { throw new Error('grammar failure'); });
  expect(highlightedSourceLine('<script>&', 'dockerfile')).toBeNull();
});
