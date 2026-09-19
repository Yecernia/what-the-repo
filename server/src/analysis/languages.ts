export interface LanguageSpec {
  id: string;
  displayName: string;
  extensions: string[];
  grammarPackage?: string;
  grammarFile?: string;
}


export const LANGUAGE_SPECS: LanguageSpec[] = [
  { id: "typescript", displayName: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { id: "javascript", displayName: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { id: "python", displayName: "Python", extensions: [".py", ".pyi"], grammarPackage: "tree-sitter-python", grammarFile: "tree-sitter-python.wasm" },
  { id: "java", displayName: "Java", extensions: [".java"], grammarPackage: "tree-sitter-java", grammarFile: "tree-sitter-java.wasm" },
  { id: "go", displayName: "Go", extensions: [".go"], grammarPackage: "tree-sitter-go", grammarFile: "tree-sitter-go.wasm" },
  { id: "php", displayName: "PHP", extensions: [".php"], grammarPackage: "tree-sitter-php", grammarFile: "tree-sitter-php.wasm" },
  { id: "rust", displayName: "Rust", extensions: [".rs"], grammarPackage: "tree-sitter-rust", grammarFile: "tree-sitter-rust.wasm" },
  { id: "csharp", displayName: "C#", extensions: [".cs"], grammarPackage: "tree-sitter-c-sharp", grammarFile: "tree-sitter-c_sharp.wasm" },
  { id: "cpp", displayName: "C/C++", extensions: [".c", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"], grammarPackage: "tree-sitter-cpp", grammarFile: "tree-sitter-cpp.wasm" },
];

const byExtension = new Map(LANGUAGE_SPECS.flatMap((spec) => spec.extensions.map((extension) => [extension, spec] as const)));
export function languageForPath(path: string): LanguageSpec | null {
  const extension = `.${path.split(".").pop()?.toLowerCase() ?? ""}`;
  return byExtension.get(extension) ?? null;
}

export function languageById(language: string): LanguageSpec | null {
  return LANGUAGE_SPECS.find((spec) => spec.id === language) ?? null;
}

export function isTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (/(^|\/)(node_modules|dist|build|coverage|\.git|\.venv|vendor|target)(\/|$)/.test(lower)) return false;
  if (/(^|\/)(agents|claude|cursor|copilot-instructions)\.md$/.test(lower)) return false;
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|7z|tar|gz|woff2?|ttf|otf|mp[34]|mov|avi|webm|glb|gltf|exe|dll|so|dylib|class|pyc|pdb)$/i.test(lower);
}
