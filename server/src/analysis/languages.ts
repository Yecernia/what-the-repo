export interface LanguageSpec {
  id: string;
  displayName: string;
  extensions: string[];
  grammarPackage: string;
  grammarFile: string;
  declarationTypes: Set<string>;
  importTypes: Set<string>;
  callTypes: Set<string>;
  lspCommands: string[][];
}

const commonCalls = new Set(["call", "call_expression", "method_invocation", "function_call_expression", "method_call_expression", "new_expression", "invocation_expression"]);
const commonImports = new Set(["import_statement", "import_declaration", "import_clause", "import_specification", "preproc_include", "use_declaration"]);

export const LANGUAGE_SPECS: LanguageSpec[] = [
  { id: "typescript", displayName: "TypeScript", extensions: [".ts", ".tsx"], grammarPackage: "tree-sitter-typescript", grammarFile: "tree-sitter-typescript.wasm", declarationTypes: new Set(["class_declaration", "interface_declaration", "enum_declaration", "function_declaration", "method_definition", "type_alias_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["typescript-language-server", "--stdio"]] },
  { id: "javascript", displayName: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"], grammarPackage: "tree-sitter-javascript", grammarFile: "tree-sitter-javascript.wasm", declarationTypes: new Set(["class_declaration", "function_declaration", "method_definition"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["typescript-language-server", "--stdio"]] },
  { id: "python", displayName: "Python", extensions: [".py", ".pyi"], grammarPackage: "tree-sitter-python", grammarFile: "tree-sitter-python.wasm", declarationTypes: new Set(["class_definition", "function_definition"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["pyright-langserver", "--stdio"]] },
  { id: "java", displayName: "Java", extensions: [".java"], grammarPackage: "tree-sitter-java", grammarFile: "tree-sitter-java.wasm", declarationTypes: new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "method_declaration", "constructor_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["jdtls"]] },
  { id: "go", displayName: "Go", extensions: [".go"], grammarPackage: "tree-sitter-go", grammarFile: "tree-sitter-go.wasm", declarationTypes: new Set(["type_declaration", "type_spec", "function_declaration", "method_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["gopls", "serve"]] },
  { id: "php", displayName: "PHP", extensions: [".php"], grammarPackage: "tree-sitter-php", grammarFile: "tree-sitter-php.wasm", declarationTypes: new Set(["class_declaration", "interface_declaration", "trait_declaration", "function_definition", "method_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["intelephense", "--stdio"]] },
  { id: "rust", displayName: "Rust", extensions: [".rs"], grammarPackage: "tree-sitter-rust", grammarFile: "tree-sitter-rust.wasm", declarationTypes: new Set(["struct_item", "enum_item", "trait_item", "function_item", "impl_item"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["rust-analyzer"]] },
  { id: "csharp", displayName: "C#", extensions: [".cs"], grammarPackage: "tree-sitter-c-sharp", grammarFile: "tree-sitter-c_sharp.wasm", declarationTypes: new Set(["class_declaration", "interface_declaration", "struct_declaration", "enum_declaration", "method_declaration", "constructor_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["csharp-ls"]] },
  { id: "cpp", displayName: "C/C++", extensions: [".c", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"], grammarPackage: "tree-sitter-cpp", grammarFile: "tree-sitter-cpp.wasm", declarationTypes: new Set(["class_specifier", "struct_specifier", "enum_specifier", "function_definition", "template_declaration"]), importTypes: commonImports, callTypes: commonCalls, lspCommands: [["clangd", "--background-index=false", "--clang-tidy=false"]] },
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
