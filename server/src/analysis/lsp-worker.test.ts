import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeLspRequest, type WorkerRequest } from "./lsp-worker.js";
const server = String.raw`
const fs=require('fs');const mode=process.argv[2];let buffer=Buffer.alloc(0),sequence=Promise.resolve(),workspaceReady=!['ready','java-ready'].includes(mode);
function send(value){const body=Buffer.from(JSON.stringify(value));const frame=Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]);sequence=sequence.then(()=>new Promise(done=>{process.stdout.write(frame.subarray(0,7));setImmediate(()=>{process.stdout.write(frame.subarray(7,23));setImmediate(()=>{process.stdout.write(frame.subarray(23));done();});});}));}
const range=(s,e)=>({start:{line:0,character:s},end:{line:0,character:e}});
const item=(uri,name,s,e,data)=>({uri,name,kind:12,range:range(s,e),selectionRange:range(s,s+name.length),data});
function handle(m){let result=null;
 if((m.method==='shutdown'||m.method==='exit')&&m.params!=null){send({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'expected no parameters'}});return;}
 if(m.method==='initialize')result={serverInfo:{name:'controlled-lsp',version:mode==='version'?'v'.repeat(500):'1'},capabilities:{positionEncoding:mode==='encoding'?'utf-8':'utf-16',documentSymbolProvider:mode!=='unsupported',callHierarchyProvider:mode!=='unsupported'}};
 else if(m.method==='initialized'&&mode==='ready'){
  send({jsonrpc:'2.0',method:'experimental/serverStatus',params:{quiescent:false,health:'ok'}});
  setTimeout(()=>{workspaceReady=true;send({jsonrpc:'2.0',method:'experimental/serverStatus',params:{quiescent:true,health:'ok'}})},80);
 }
 else if(m.method==='initialized'&&mode==='java-ready'){
  send({jsonrpc:'2.0',method:'language/status',params:{type:'Starting'}});
  setTimeout(()=>{workspaceReady=true;send({jsonrpc:'2.0',method:'language/status',params:{type:'ServiceReady'}})},80);
 }
 else if(m.method==='textDocument/documentSymbol'){
  if(!workspaceReady)throw Error('queried before workspace was ready');
  if(mode==='empty')result=[];
  else if(mode==='null')result=null;
  else if(mode==='flat')result=[{name:'run',kind:12,containerName:'display-only',location:{uri:m.params.textDocument.uri,range:range(4,20)}}];
  else if(mode==='crash'){process.exit(2);return;}
  else result=[{name:'unmodelled',kind:1,range:range(0,50),selectionRange:range(0,1),children:[{name:'run',kind:12,range:range(0,20),selectionRange:range(4,7)},{name:'target',kind:12,range:range(21,50),selectionRange:range(25,31)}]}];
 }
 else if(m.method==='textDocument/prepareCallHierarchy'){
  if(mode==='timeout')return;
  result=mode==='flat'?null:m.params.position.character===4?[item(m.params.textDocument.uri,'run',4,20,{index:1}),item(m.params.textDocument.uri,'run',4,20,{index:2})]:[];
 }
 else if(m.method==='callHierarchy/outgoingCalls'){
  if(!m.params.item.data)throw Error('opaque data lost');
  const base=m.params.item.data.index===1?8:14;
  result=[{to:item(m.params.item.uri,'target',25,50,null),fromRanges:[range(base,base+2),range(base+3,base+5)]}];
 }
 else if(m.method==='shutdown'&&mode==='shutdown-error')send({jsonrpc:'2.0',method:'window/logMessage',params:{type:1,message:'session is shut down'}});
 else if(m.method==='exit'){process.exit(0);return;}
 if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result});
}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const split=buffer.indexOf('\r\n\r\n');if(split<0)return;const length=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,split).toString())[1]);if(buffer.length<split+4+length)return;const body=JSON.parse(buffer.subarray(split+4,split+4+length).toString());buffer=buffer.subarray(split+4+length);handle(body);}});
`;
async function fixture(
  mode: string,
  run: (request: WorkerRequest) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "wtr-lsp-protocol-"));
  try {
    const entry = join(root, "server.cjs");
    await writeFile(entry, server);
    await writeFile(
      join(root, "main.py"),
      "def run(): target()\ndef target(): pass\n",
    );
    await run({
      language: "python",
      serverCommand: [await realpath(process.execPath), entry, mode],
      sourceRoot: root,
      files: ["main.py"],
      workspaceFiles: ["main.py"],
      requestTimeoutMs: 2000,
      maxSymbols: 100,
      maxRelations: 100,
      totalBudgetMs: 10000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("LSP fragmented transport keeps every prepared item, opaque data, call site and child under unknown parent", async () =>
  fixture("normal", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.equal(result.toolchainVerified, false);
    assert.ok(!result.reasonCodes.includes('lsp_shutdown_failed'));
    assert.deepEqual(
      result.symbols.map((s) => s.name),
      ["run", "target"],
    );
    assert.equal(result.symbols[0]?.startColumn, 0);
    assert.equal(result.symbols[0]?.endColumn, 20);
    assert.equal(result.symbols[0]?.selection?.startColumn, 4);
    assert.deepEqual(
      result.relations.map((r) => r.sourceColumn).sort((a, b) => a - b),
      [8, 11, 14, 17],
    );
    assert.ok(
      result.relations.every(
        (r) =>
          r.sourceSelection?.startColumn === 4 &&
          r.targetColumn === 25 &&
          r.kind === "calls",
      ),
    );
    assert.equal(result.coverage?.targetsCompleted, 2);
  }));
test('Rust waits for the explicit quiescent workspace notification before querying', async () =>
  fixture('ready', async request => {
    request.language = 'rust';
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.equal(result.relations.length, 4);
    assert.ok(!result.reasonCodes.includes('workspace_readiness_not_observable'));
  }));
test('LSP preserves long server build identity instead of truncating it as display text', async () =>
  fixture('version', async request => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.equal(result.serverVersion, 'v'.repeat(500));
  }));
test('Java waits for service readiness before querying project facts', async () =>
  fixture('java-ready', async request => {
    request.language = 'java';
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.equal(result.relations.length, 4);
    assert.ok(!result.reasonCodes.includes('workspace_readiness_not_observable'));
  }));
test('shutdown diagnostics report cleanup failure without invalidating completed queries', async () =>
  fixture('shutdown-error', async request => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.ok(result.reasonCodes.includes('lsp_shutdown_failed'));
    assert.deepEqual(result.workspaceDiagnostics, []);
  }));
test("LSP empty is complete; unsupported is distinct and sends no symbol request", async () => {
  await fixture("empty", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.deepEqual(result.symbols, []);
  });
  await fixture("null", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.deepEqual(result.symbols, []);
  });
  await fixture("flat", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, true);
    assert.equal(result.symbols[0]?.hierarchy, "flat");
    assert.equal(result.symbols[0]?.qualifiedName, "run");
    assert.equal(result.relations.length, 0);
  });
  await fixture("unsupported", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, false);
    assert.ok(result.reasonCodes.includes("document_symbols_unsupported"));
    assert.equal(result.coverage?.requests, 2);
  });
});
test("LSP timeout retains declarations, records unfinished targets and persists partial progress", async () =>
  fixture("timeout", async (request) => {
    const checkpoints: unknown[] = [];
    const result = await analyzeLspRequest(
      request,
      undefined,
      async (partial) => {
        checkpoints.push(structuredClone(partial));
      },
    );
    assert.equal(result.completed, false);
    assert.equal(result.symbols.length, 2);
    assert.equal(result.coverage?.targetsCompleted, 0);
    assert.equal(result.coverage?.failures.lsp_request_timeout, 2);
    assert.equal(checkpoints.length, 2);
  }));
test("LSP cancellation rejects, crashes and non-negotiated encodings are reported honestly", async () => {
  await fixture("timeout", async (request) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(analyzeLspRequest(request, controller.signal));
  });
  await fixture("crash", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.equal(result.completed, false);
    assert.deepEqual(result.coverage?.filesCompleted, []);
  });
  await fixture("encoding", async (request) => {
    const result = await analyzeLspRequest(request);
    assert.ok(result.reasonCodes.includes("lsp_position_encoding_unsupported"));
    assert.equal(result.symbols.length, 0);
  });
});
