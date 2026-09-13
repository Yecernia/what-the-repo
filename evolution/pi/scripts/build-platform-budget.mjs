import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import ts from 'typescript';

// The standalone worker uses the exact same admission/settlement code as the API.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const target=join(root,'server/dist/agent');
await mkdir(target,{recursive:true});
for(const name of ['provider-budget','mutex']) {
  const source=await readFile(join(root,'server/src/agent',name+'.ts'),'utf8');
  const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
  await writeFile(join(target,name+'.js'),result.outputText);
}
