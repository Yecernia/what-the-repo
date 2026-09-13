import test from 'node:test';
import assert from 'node:assert/strict';
import { globalBudgetRuntime,consumeAdminEvolutionCommand } from '../src/platform-budget.js';
import type {Pool} from 'pg';
import type {ProductionEvolutionRuntime} from '../src/composition.js';

test('shared budget rejection happens before any model transport', async () => {
  let called = false;
  const runtime = globalBudgetRuntime(
    {
      streamSimple() {
        called = true;
      },
    },
    async () => {
      throw new Error('site_evolution_budget_exhausted');
    },
    () => 0.01,
  ) as { streamSimple(...args: unknown[]): AsyncIterable<unknown> };
  await assert.rejects(async () => {
    for await (const _event of runtime.streamSimple({}, {})) {
    }
  }, /site_evolution_budget_exhausted/);
  assert.equal(called, false);
});

test('admin review commands call the existing reviewer/rollback contract and reject changed candidates',async()=>{
  for(const action of ['approve','reject','rollback','stale']){
    const calls:unknown[]=[],writes:unknown[][]=[];let claimed=false;
    const pool={async query(sql:string,params:unknown[]=[]){if(!claimed){claimed=true;return {rows:[{id:'command',task_id:'isolated-task',actor:'github:123',action,candidate_version:'v2',reason:'test'}]};}writes.push([sql,params]);return {rows:[]};}} as unknown as Pool;
    const runtime={store:{async loadCandidate(){return {candidateVersion:action==='stale'?'v3':'v2',rollbackTarget:'v1'};}},feedbackWorker:{async review(input:unknown){calls.push(input);}},runner:{async rollback(...args:unknown[]){calls.push(args);}}} as unknown as ProductionEvolutionRuntime;
    await consumeAdminEvolutionCommand(pool,runtime);
    if(action==='stale'){assert.equal(calls.length,0);assert.ok(JSON.stringify(writes).includes('review_failed_check_existing_ledger'));}
    else if(action==='rollback')assert.deepEqual(calls,[['isolated-task','v1']]);
    else assert.deepEqual(calls,[{taskId:'isolated-task',decision:action,reviewerId:'github:123',...(action==='reject'?{reason:'test'}:{})}]);
    assert.ok(writes.some(row=>String(row[0]).includes('INSERT INTO admin_audit')));
  }
});
test('stream and result consumers settle once, missing usage is retained as unknown', async () => {
  for (const known of [false, true]) {
    const reports: unknown[] = [];
    const message = {
      usage: known
        ? {
            input: 2,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.005 },
          }
        : undefined,
      stopReason: 'stop',
    };
    const runtime = globalBudgetRuntime(
      {
        streamSimple() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done', message };
            },
            async result() {
              return message;
            },
          };
        },
      },
      async () => ({
        async release(report) {
          reports.push(report);
        },
      }),
      () => 0.01,
    ) as {
      streamSimple(
        ...args: unknown[]
      ): AsyncIterable<unknown> & { result(): Promise<unknown> };
    };
    const stream = runtime.streamSimple({}, {});
    for await (const _event of stream) {
    }
    await stream.result();
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as { usageKnown: boolean }).usageKnown, known);
  }
});
