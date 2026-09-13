import { Client, type Pool } from 'pg';
export type RepositoryReadLease = (() => Promise<void>) & { signal: AbortSignal };
interface LeaseGroup { client:Client; ready:Promise<void>; users:number; closing:boolean; controller:AbortController }
const groups=new WeakMap<Pool,LeaseGroup>();
/** One dedicated lock connection per busy API process, independent of its query pool size. */
export async function acquireRepositoryReadLease(store: unknown): Promise<RepositoryReadLease | null> {
  const pool=(store as {pool?:Pool}).pool;
  if(!pool) return null;
  let group=groups.get(pool);
  if(!group) {
    const client=new Client(pool.options);
    group={client,ready:Promise.resolve(),users:0,closing:false,controller:new AbortController()};
    const current=group;
    const lost=()=>{if(!current.closing)current.controller.abort(new Error('repository_maintenance_connection_lost'));};
    client.on('error',lost);client.on('end',lost);
    current.ready=(async()=>{
      await client.connect();
      const r=await client.query("SELECT pg_try_advisory_lock_shared(hashtextextended('repository-payload-use',0)) AS acquired");
      if(!r.rows[0].acquired) throw Object.assign(new Error('仓库资料正在清理，请在清理结束后重新打开项目。'),{code:'repository_maintenance',statusCode:409});
    })();
    groups.set(pool,current);
  }
  const current=group;current.users++;
  let released=false;
  const release=async()=>{
    if(released)return;released=true;
    if(--current.users===0){
      current.closing=true;
      if(groups.get(pool)===current)groups.delete(pool);
      await current.client.end();
    }
  };
  try {await current.ready;current.controller.signal.throwIfAborted();}
  catch(error){await release();throw error;}
  return Object.assign(release,{signal:current.controller.signal});
}
