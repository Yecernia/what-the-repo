import hljs from 'highlight.js/lib/common';
import { languageFromPath } from './language-glyph';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import julia from 'highlight.js/lib/languages/julia';
import erlang from 'highlight.js/lib/languages/erlang';
import elixir from 'highlight.js/lib/languages/elixir';
import haskell from 'highlight.js/lib/languages/haskell';
import vbscript from 'highlight.js/lib/languages/vbscript';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('julia', julia);
hljs.registerLanguage('erlang', erlang);
hljs.registerLanguage('elixir', elixir);
hljs.registerLanguage('haskell', haskell);
hljs.registerLanguage('vbscript', vbscript);

const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css',
  docker: 'dockerfile', dockerfile: 'dockerfile', go: 'go', h: 'c', hpp: 'cpp', html: 'xml',
  java: 'java', js: 'javascript', cjs: 'javascript', mjs: 'javascript', json: 'json', jsx: 'javascript',
  md: 'markdown', mdx: 'markdown', php: 'php', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', fish: 'bash', sql: 'sql',
  ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml', jl: 'julia', erl: 'erlang', hrl: 'erlang', ex: 'elixir', exs: 'elixir', hs: 'haskell', lhs: 'haskell', vb: 'vbnet', vbs: 'vbscript',
  conf: 'ini', ini: 'ini', toml: 'ini', env: 'ini', ps1: 'powershell',
};

export function sourceLanguage(path: string): string {
  const extension = languageFromPath(path);
  const language = Object.hasOwn(SOURCE_LANGUAGE_BY_EXTENSION, extension) ? SOURCE_LANGUAGE_BY_EXTENSION[extension] : 'plaintext';
  return hljs.getLanguage(language) ? language : 'plaintext';
}

export function highlightedSourceLine(value: string, language: string): string | null {
  try {
    return hljs.highlight(value || ' ', { language: hljs.getLanguage(language) ? language : 'plaintext', ignoreIllegals: true }).value;
  } catch {
    // Callers render the original text through React, preserving HTML escaping.
    return null;
  }
}
