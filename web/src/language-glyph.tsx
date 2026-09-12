import type { ReactNode } from 'react';

const LANGUAGE_KEY_ALIASES: Record<string, string> = {
  'c++': 'cpp', 'c#': 'csharp', 'c/c++': 'cpp', 'objective-c': 'objectivec', cc: 'cpp', cxx: 'cpp',
  h: 'c', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', ino: 'cpp', html: 'html5', htm: 'html5', xhtml: 'html5', svg: 'xml', js: 'javascript', jsx: 'react', mjs: 'npm', cjs: 'nodejs', es6: 'javascript',
  md: 'markdown', mdx: 'markdown', mdown: 'markdown', mkd: 'markdown', mkdn: 'markdown', py: 'python', pyw: 'python', pyi: 'python', py3: 'python', pyde: 'python', rs: 'rust', sh: 'bash', ts: 'typescript', tsx: 'react', cts: 'typescript', mts: 'typescript',
  rb: 'ruby', ru: 'ruby', erb: 'ruby', yml: 'yaml', kt: 'kotlin', kts: 'kotlin', ktm: 'kotlin', ps1: 'powershell', vue: 'vuejs', svelte: 'svelte', gql: 'graphql',
  dockerfile: 'docker', containerfile: 'docker', dockerignore: 'docker', gitignore: 'git', gitattributes: 'git',
  scss: 'sass', styl: 'stylus', m: 'objectivec', mm: 'objectivec',
  pl: 'perl', pm: 'perl', p6: 'perl', raku: 'perl', t: 'perl', cgi: 'perl',
  fish: 'bash', ksh: 'bash', csh: 'bash', tcsh: 'bash', bashrc: 'bash', zshrc: 'zsh',
  rake: 'ruby', gemfile: 'ruby', gemspec: 'ruby', rbi: 'ruby', cmake: 'cmake',
  jl: 'julia', julia: 'julia', erl: 'erlang', hrl: 'erlang', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', hsc: 'haskell', lhs: 'haskell', rd: 'r', rprofile: 'r', vb: 'visualbasic', vbs: 'visualbasic', unity: 'unity', godot: 'godot',
  cs: 'csharp', csx: 'csharp', cake: 'csharp', jav: 'java', jsh: 'java', php3: 'php', php4: 'php', php5: 'php', phpt: 'php',
  sc: 'scala', sbt: 'scala', nse: 'lua', rockspec: 'lua', di: 'd', jsonl: 'json', topojson: 'json', webmanifest: 'json', json5: 'json', jsonc: 'json', 'code-workspace': 'vscode',
  coffee: 'coffeescript', cql: 'cassandra', xsd: 'xml', xaml: 'xml', csproj: 'csharp',
  gd: 'godot', gdnlib: 'godot', gdns: 'godot', tres: 'godot', tscn: 'godot', gdshader: 'godot', gdshaderinc: 'godot',
  anim: 'unity', asset: 'unity', mask: 'unity', mat: 'unity', meta: 'unity', prefab: 'unity', shader: 'unity',
  hlsl: 'opengl', glsl: 'opengl', vert: 'opengl', frag: 'opengl', geo: 'opengl', comp: 'opengl', fx: 'opengl', cginc: 'opengl',
};

const LANGUAGE_ICON_KEYS: Record<string, string> = {
  asm: 'gcc-plain', astro: 'astro-plain', awk: 'awk-plain', bash: 'bash-plain', bat: 'windows8-original',
  bazel: 'bazel-plain', c: 'c-original', cpp: 'cplusplus-plain', csharp: 'csharp-plain', css: 'css3-plain',
  dart: 'dart-plain', docker: 'docker-plain', elixir: 'elixir-plain', elm: 'elm-plain', erlang: 'erlang-plain', godot: 'godot-plain', coffeescript: 'coffeescript-plain', cassandra: 'cassandra-plain',
  fsharp: 'fsharp-plain', fortran: 'fortran-original', git: 'git-plain', go: 'go-plain', graphql: 'graphql-plain', groovy: 'groovy-plain',
  haskell: 'haskell-plain', html5: 'html5-plain', java: 'java-plain', javascript: 'javascript-plain',
  json: 'json-plain', julia: 'julia-plain', kotlin: 'kotlin-plain', latex: 'latex-original', less: 'less-plain-wordmark',
  lua: 'lua-plain', markdown: 'markdown-original', matlab: 'matlab-plain', nim: 'nim-plain', nodejs: 'nodejs-plain',
  mongodb: 'mongodb-plain', mysql: 'mysql-plain', npm: 'npm-original-wordmark', objectivec: 'objectivec-plain', opengl: 'opengl-plain',
  ocaml: 'ocaml-plain', perl: 'perl-plain', php: 'php-plain', postgresql: 'postgresql-plain',
  powershell: 'powershell-plain', prolog: 'prolog-plain', python: 'python-plain', r: 'r-plain', racket: 'racket-plain',
  react: 'react-original', ruby: 'ruby-plain', rust: 'rust-original', sass: 'sass-original', scala: 'scala-plain',
  redis: 'redis-plain', solidity: 'solidity-plain', sql: 'microsoftsqlserver-plain', sqlite: 'sqlite-plain', swift: 'swift-plain',
  stylus: 'stylus-original', svelte: 'svelte-plain', tailwindcss: 'tailwindcss-original', terraform: 'terraform-plain',
  tex: 'tex-plain', typescript: 'typescript-original', unity: 'unity-plain', vscode: 'vscode-plain', vala: 'vala-plain', visualbasic: 'visualbasic-plain', yarn: 'yarn-original',
  vuejs: 'vuejs-plain', wasm: 'wasm-plain', xml: 'xml-plain', yaml: 'yaml-plain', zig: 'zig-plain', zsh: 'zsh-plain',
  cmake: 'cmake-plain',
};

const ICONPARK_FILE_ICON_KEYS: Record<string, string> = {
  txt: 'txt', text: 'text', log: 'text',
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt',
  xls: 'excel', xlsx: 'excel', csv: 'excel', tsv: 'excel', ods: 'excel',
  pdf: 'pdf',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip', tgz: 'zip',
};

function languageKey(language: string) {
  const raw = language.trim().toLowerCase().replace(/^\./, '');
  const key = raw.replace(/[^a-z0-9+#-]+/g, '-');
  return LANGUAGE_KEY_ALIASES[raw] ?? LANGUAGE_KEY_ALIASES[key] ?? key;
}

function stripLineSuffix(path: string): string {
  return path.trim().replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?:-\d+|:\d+)?)$/i, '');
}

export function languageFromPath(path: string): string {
  const fileName = stripLineSuffix(path).split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!fileName) return 'file';
  if (fileName.endsWith('.h.in')) return 'c';
  if (fileName.endsWith('.rs.in')) return 'rust';
  if (fileName === '.rprofile') return 'r';
  if (fileName === '.bashrc') return 'bash';
  if (fileName === '.zshrc') return 'zsh';
  if (fileName === 'go.mod' || fileName === 'go.sum') return 'go';
  if (fileName === 'package.json' || fileName === 'package-lock.json' || fileName === 'pnpm-lock.yaml') {
    return fileName.endsWith('.yaml') ? 'yaml' : 'json';
  }
  if (fileName === 'yarn.lock') return 'yarn';
  if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) return 'docker';
  if (fileName === '.gitignore' || fileName === '.dockerignore') return 'gitignore';
  if (fileName.startsWith('.')) return fileName.slice(1).split('.').pop() || 'file';
  return fileName.includes('.') ? fileName.split('.').pop() || 'file' : fileName;
}

export function hasLanguageGlyph(language: string): boolean {
  const key = languageKey(language);
  return Boolean(LANGUAGE_ICON_KEYS[key] || ICONPARK_FILE_ICON_KEYS[key]);
}

export function LanguageGlyph({ language, className = '', children }: { language: string; className?: string; children?: ReactNode }) {
  const key = languageKey(language);
  const iconKey = LANGUAGE_ICON_KEYS[key];
  const fileIconKey = ICONPARK_FILE_ICON_KEYS[key];
  return <span className={`language-glyph language-glyph-${key} ${className}`} aria-label={language} role="img">
    {iconKey ? <i className={`devicon-${iconKey}`} aria-hidden="true" />
      : fileIconKey ? <span className={`iconpark-file-icon iconpark-file-${fileIconKey}`} aria-hidden="true" />
        : <span className="iconpark-code-file-one" aria-hidden="true" />}
    {children}
  </span>;
}
