import type { Pool, PoolClient } from 'pg';
import type { PermitRow } from './permits.js';
import { serviceError } from '../services/errors.js';
import { defaultRuntimeMetrics as metrics } from '../observability/metrics.js';

const MAX_BATCH = 32;
const MAX_OUTSTANDING = 1024; // Queued and in-flight callers, not Pool.waitingCount.
const RETRY_MS = 25;
const ROLLBACK_CLEANUP_MS = 2000; // Existing statement timeout, also bounds a silent socket.

type Phase = { acquiring: boolean };
type State = 'queued' | 'active' | 'settled';
interface Request {
  namespace: string;
  run: (rows: PermitRow[], now: number) => unknown;
  signal: AbortSignal;
  phase: Phase;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
  state: State;
  attempt?: Attempt;
}
interface Attempt {
  namespace: string;
  jobs: Request[];
  stage: 'acquiring' | 'precommit' | 'commit' | 'finished';
  invalid: boolean;
  controller: AbortController;
  release?: (destroy?: boolean) => void;
}

const batchers = new WeakMap<Pool, PostgresPermitBatcher>();
let processOutstanding = 0;
function recordOutstanding(delta: number) {
  processOutstanding+=delta;
  metrics.setGauge('what_the_repo_control_outstanding',processOutstanding);
}
export function changePostgresPermit<T>(pool: Pool, namespace: string,
  fn: (rows: PermitRow[], now: number) => T, signal: AbortSignal, phase: Phase): Promise<T> {
  let batcher = batchers.get(pool);
  if (!batcher) { batcher = new PostgresPermitBatcher(pool); batchers.set(pool, batcher); }
  return batcher.change(namespace, fn, signal, phase);
}

/** One bounded, round-robin queue per actual control Pool. */
class PostgresPermitBatcher {
  private readonly queues = new Map<string, Request[]>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly delayed = new Set<string>();
  private outstanding = 0;
  private scheduled = false;
  private running = false;

  constructor(private readonly pool: Pool) {}

  change<T>(namespace: string, fn: (rows: PermitRow[], now: number) => T,
    signal: AbortSignal, phase: Phase): Promise<T> {
    signal.throwIfAborted();
    if (this.outstanding >= MAX_OUTSTANDING)
      return Promise.reject(serviceError('database_control_busy','database_control_busy',503));
    return new Promise<T>((resolve, reject) => {
      const job: Request = {namespace,run:fn,signal,phase,
        resolve:value=>resolve(value as T),reject,onAbort:()=>this.cancel(job),state:'queued'};
      this.outstanding++;
      recordOutstanding(1);
      signal.addEventListener('abort',job.onAbort,{once:true});
      this.enqueue(job);
    });
  }

  private markReady(namespace: string) {
    if (this.delayed.has(namespace) || this.readySet.has(namespace)) return;
    if (!(this.queues.get(namespace)?.length)) return;
    this.ready.push(namespace);
    this.readySet.add(namespace);
    this.schedule();
  }

  private unready(namespace: string) {
    if (!this.readySet.delete(namespace)) return;
    const index=this.ready.indexOf(namespace);
    if (index>=0) this.ready.splice(index,1);
  }

  private enqueue(job: Request) {
    const queue=this.queues.get(job.namespace) ?? [];
    queue.push(job);
    this.queues.set(job.namespace,queue);
    this.markReady(job.namespace);
  }

  private removeQueued(job: Request) {
    const queue=this.queues.get(job.namespace);
    if (!queue) return;
    const index=queue.indexOf(job);
    if (index>=0) queue.splice(index,1);
    if (!queue.length) {this.queues.delete(job.namespace);this.unready(job.namespace);}
  }

  private settle(job: Request, ok: boolean, value: unknown) {
    if (job.state==='settled') return;
    job.state='settled';
    job.signal.removeEventListener('abort',job.onAbort);
    this.outstanding--;
    recordOutstanding(-1);
    if (ok) job.resolve(value); else job.reject(value);
  }

  private cancel(job: Request) {
    if (job.state==='settled') return;
    const attempt=job.attempt;
    if (job.state==='queued') this.removeQueued(job);
    this.settle(job,false,job.signal.reason);
    if (!attempt) return;
    if (attempt.stage==='acquiring') {
      if (!attempt.jobs.some(item=>item.state==='active')) attempt.controller.abort(job.signal.reason);
    } else if (attempt.stage==='precommit') {
      // No result from this transaction is usable now. Destroy an in-flight
      // query, then retry its surviving callers in a fresh transaction.
      attempt.invalid=true;
      attempt.controller.abort(job.signal.reason);
      attempt.release?.(true);
    } else if (attempt.stage==='commit' && !attempt.jobs.some(item=>item.state==='active')) {
      // No caller can use this outcome. Break a hung COMMIT, without replaying
      // an outcome that the client can no longer determine.
      attempt.controller.abort(job.signal.reason);
      attempt.release?.(true);
    }
    // Once COMMIT has been sent its outcome cannot be inferred from a local
    // abort. The cancelled caller fails; others wait for the actual COMMIT.
  }

  private schedule() {
    if (this.running || this.scheduled) return;
    this.scheduled=true;
    queueMicrotask(()=>{this.scheduled=false;void this.drain();});
  }

  private next(): Attempt | undefined {
    while(this.ready.length) {
      const namespace=this.ready.shift()!;
      this.readySet.delete(namespace);
      const queue=this.queues.get(namespace);
      if (!queue?.length) continue;
      const jobs=queue.splice(0,MAX_BATCH);
      if (queue.length) this.markReady(namespace);
      else this.queues.delete(namespace);
      const attempt:Attempt={namespace,jobs,stage:'acquiring',invalid:false,controller:new AbortController()};
      for(const job of jobs){job.state='active';job.attempt=attempt;job.phase.acquiring=true;}
      return attempt;
    }
    return undefined;
  }

  private absorb(attempt: Attempt) {
    const queue=this.queues.get(attempt.namespace);
    while(queue?.length && attempt.jobs.length<MAX_BATCH) {
      const job=queue.shift()!;
      if (job.state!=='queued') continue;
      job.state='active';job.attempt=attempt;
      attempt.jobs.push(job);
    }
    if (queue && !queue.length) {this.queues.delete(attempt.namespace);this.unready(attempt.namespace);}
  }

  private requeue(attempt: Attempt, retryMs: number) {
    const survivors=attempt.jobs.filter(job=>job.state==='active' && !job.signal.aborted);
    if (!survivors.length) return;
    for(const job of survivors){job.state='queued';job.attempt=undefined;job.phase.acquiring=true;}
    const queue=this.queues.get(attempt.namespace) ?? [];
    this.queues.set(attempt.namespace,[...survivors,...queue]);
    if (!retryMs) {this.markReady(attempt.namespace);return;}
    this.delayed.add(attempt.namespace);
    this.unready(attempt.namespace);
    const timer=setTimeout(()=>{
      this.delayed.delete(attempt.namespace);
      this.markReady(attempt.namespace);
    },retryMs);
    timer.unref();
  }

  private async drain() {
    if (this.running) return;
    this.running=true;
    try {
      for(let attempt=this.next();attempt;attempt=this.next()) await this.execute(attempt);
    } finally {
      this.running=false;
      if (this.ready.length) this.schedule();
    }
  }

  private async execute(attempt: Attempt) {
    let client:PoolClient|undefined;
    let released=false,transaction=false,committed=false;
    let retryMs:number|null=null;
    const results=new Map<Request,unknown>();
    const release=(destroy=false)=>{
      if (!client || released) return;
      released=true;
      client.release(destroy);
    };
    attempt.release=release;
    try {
      client=await connectBatch(this.pool,attempt.controller.signal);
      if (!attempt.jobs.some(job=>job.state==='active')) return;
      this.absorb(attempt);
      attempt.stage='precommit';
      for(const job of attempt.jobs) if(job.state==='active')job.phase.acquiring=false;
      await queryAttempt(attempt,()=>client!.query('BEGIN'));transaction=true;
      await queryAttempt(attempt,()=>client!.query("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='100ms'"));
      const lock=await queryAttempt(attempt,()=>client!.query<{acquired:boolean}>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`admission:${attempt.namespace}`]));
      if (!lock.rows[0]?.acquired) {retryMs=RETRY_MS;return;}
      if (attempt.invalid) {retryMs=0;return;}
      const loaded=await queryAttempt(attempt,()=>client!.query<{payload:PermitRow|null;now:string}>(
        `WITH now_value AS MATERIALIZED (SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now)
         SELECT p.payload,n.now FROM now_value n LEFT JOIN runtime_permits p ON p.namespace=$1`,[attempt.namespace]));
      const now=Number(loaded.rows[0]!.now);
      const initial=loaded.rows.flatMap(row=>row.payload?[row.payload]:[]);
      const before=new Map(initial.map(row=>[row.id,JSON.stringify(row)]));
      let rows=initial;
      for(const job of attempt.jobs) {
        if (attempt.invalid) break;
        if (job.state!=='active') continue;
        if (job.signal.aborted) {this.cancel(job);break;}
        const draft=structuredClone(rows);
        try {
          const result=job.run(draft,now);
          if (result && typeof (result as {then?:unknown}).then==='function')
            throw new TypeError('permit_change_callback_must_be_synchronous');
          if (attempt.invalid || job.state!=='active') break;
          rows=draft;
          results.set(job,result);
        } catch(error) {this.settle(job,false,error);}
      }
      if (attempt.invalid) {retryMs=0;return;}
      if (!results.size) return;
      const remaining=new Set(rows.map(row=>row.id));
      const removed=[...before.keys()].filter(id=>!remaining.has(id));
      const changedById=new Map<string,{permit_id:string;payload:PermitRow}>();
      for(const row of rows) {
        const payload=JSON.stringify(row);
        // The previous per-row UPSERT applied the last changed duplicate ID.
        if (before.get(row.id)!==payload) changedById.set(row.id,{permit_id:row.id,payload:row});
      }
      if (removed.length) await queryAttempt(attempt,()=>client!.query(
        'DELETE FROM runtime_permits WHERE namespace=$1 AND permit_id=ANY($2::text[])',[attempt.namespace,removed]));
      if (changedById.size) await queryAttempt(attempt,()=>client!.query(
        `INSERT INTO runtime_permits(namespace,permit_id,payload)
         SELECT $1,r.permit_id,r.payload FROM jsonb_to_recordset($2::jsonb) AS r(permit_id text,payload jsonb)
         ON CONFLICT(namespace,permit_id) DO UPDATE SET payload=EXCLUDED.payload`,
        [attempt.namespace,JSON.stringify([...changedById.values()])]));
      if (attempt.invalid) {retryMs=0;return;}
      attempt.stage='commit';
      await queryAttempt(attempt,()=>client!.query('COMMIT'));transaction=false;committed=true;
      metrics.increment('what_the_repo_control_batches_total',1,{outcome:'committed'});
      metrics.observe('what_the_repo_control_batch_size',attempt.jobs.length);
      for(const [job,result] of results) if(job.state==='active') this.settle(job,true,result);
    } catch(error) {
      if (attempt.invalid && attempt.stage!=='commit') retryMs=0;
      else if (attempt.stage!=='commit' && (error as {code?:string})?.code==='55P03') {
        retryMs=RETRY_MS;
        metrics.increment('what_the_repo_control_lock_retries_total',1);
      } else {
        metrics.increment('what_the_repo_control_batches_total',1,{outcome:'error'});
        for(const job of attempt.jobs) if(job.state==='active') this.settle(job,false,error);
      }
    } finally {
      const rolledBack=!transaction || released || await rollbackBounded(client!);
      release(attempt.invalid || !rolledBack || (attempt.stage==='commit' && !committed));
      attempt.stage='finished';
      if (retryMs!==null) {
        metrics.increment('what_the_repo_control_batches_total',1,{outcome:'retry'});
        this.requeue(attempt,retryMs);
      }
    }
  }
}

/** Release/abort must unblock a hung client query even if its Promise never settles. */
async function queryAttempt<T>(attempt: Attempt, query: () => Promise<T>): Promise<T> {
  return queryWithSignal(attempt.controller.signal,query);
}

async function rollbackBounded(client: PoolClient): Promise<boolean> {
  const cleanup=new AbortController();
  const timer=setTimeout(()=>cleanup.abort(new Error('permit_rollback_timeout')),ROLLBACK_CLEANUP_MS);
  try {await queryWithSignal(cleanup.signal,()=>client.query('ROLLBACK'));return true;}
  catch {return false;}
  finally {clearTimeout(timer);}
}

async function queryWithSignal<T>(signal: AbortSignal, query: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled=new Promise<never>((_resolve,reject)=>{
    abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
  });
  try {return await Promise.race([query(),cancelled]);}
  finally {signal.removeEventListener('abort',abort);}
}

/** A cancelled connection wait releases a client that arrives after all callers leave. */
function connectBatch(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    void pool.connect().then(client=>{
      signal.removeEventListener('abort',abort);
      if (signal.aborted) {client.release();abort();} else resolve(client);
    },error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
