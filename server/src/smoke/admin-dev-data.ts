/** Synthetic data for the loopback admin development entry point only. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PostgresStore } from '../persistence/postgres-store.js';
import { createMessage, createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { adminDocuments } from '../admin/runtime-config.js';

export const DEVELOPMENT_DATABASE = 'wtr_admin_preview_dev';
export const SCENARIOS = ['normal', 'low', 'gap', 'empty', 'stale'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export async function developmentStore(root: string, dataDir: string, secret: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('Development only');
  // Read only local database settings; never inherit model, COS or OAuth secrets.
  const env: Record<string, string> = {};
  for (const line of (await readFile(join(root, '.secrets/local.env'), 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  const source = env.DATABASE_URL ?? env.WHAT_THE_REPO_DATABASE_URL ??
    (env.POSTGRES_PASSWORD ? `postgresql://${encodeURIComponent(env.POSTGRES_USER ?? 'repo_onboarding')}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:15432/${encodeURIComponent(env.POSTGRES_DB ?? 'repo_onboarding')}` : null);
  if (!source) throw new Error('Local database unavailable');
  const url = new URL(source);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '15432')
    throw new Error('Only loopback PostgreSQL on 15432 is allowed');
  url.hostname = '127.0.0.1';
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [DEVELOPMENT_DATABASE])).rowCount)
      await admin.query(`CREATE DATABASE ${DEVELOPMENT_DATABASE}`);
  } finally { await admin.end(); }
  url.pathname = '/' + DEVELOPMENT_DATABASE;
  url.search = ''; // Do not carry connection options into the isolated database.
  const store = new PostgresStore({ databaseUrl: url.toString(), root: dataDir,
    migrationsRoot: join(root, 'server/migrations'), encryptionSecret: secret, applicationRole: 'admin-dev' });
  await store.init();
  return store;
}

export async function seedDevelopmentRecords(store: PostgresStore) {
  const docs = adminDocuments(store);
  if (await docs.read('development-seeded-v1', false)) return;
  for (const [i, name] of ['react', 'fastify', 'typescript', 'redis'].entries()) {
    const ownerId = i % 2 ? 'guest:dev-1' : 'github:900000001';
    await store.saveUser(ownerId, { owner_id: ownerId, login: i % 2 ? 'guest' : 'sample-maintainer',
      display_name: i % 2 ? '示例访客' : '示例维护者', kind: i % 2 ? 'guest' : 'github', avatar_url: null });
    const project = createProject(ownerId, `https://github.com/example/${name}`, `示例 · ${name}`, null);
    project.analysis.stage = i === 3 ? 'failed' : 'done';
    project.messages.push(createMessage('assistant', '本机模拟回答，用于管理台展示验收。', {
      feedback: { vote: i === 0 ? 'up' : i === 1 ? 'down' : null,
        updated_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
        signal: { sentiment: i === 0 ? 'positive' : 'negative', source: i < 2 ? 'button' : 'language',
          confidence: i === 3 ? 0.5 : 0.85, skill_hypotheses: i === 3 ? [] : ['component-explanation'],
          issues: i === 0 ? [] : ['示例：解释缺少具体代码位置。'], strengths: ['示例：内容结构清晰。'],
          observed_at: new Date().toISOString() } },
    }));
    const job = newAnalysisJob(project.project_id, 'admin-dev:' + name);
    job.status = i === 3 ? 'failed' : 'succeeded';
    job.created_at = new Date(Date.now() - (i + 1) * 600_000).toISOString();
    job.completed_at = new Date(Date.parse(job.created_at) + 43_000 + i * 7100).toISOString();
    job.error_code = i === 3 ? 'site_analysis_budget_exhausted' : null;
    await store.createProjectWithJob(project, job);
    if (i === 3) continue;
    const taskId = 'dev-evolution-' + i;
    await store.saveEvolutionFeedbackRequest({ request_id: 'dev-feedback-' + i, dedupe_key: 'dev-' + i,
      trigger: 'human_feedback', skill_ids: ['component-explanation'], reasons: ['示例：补充证据引用'], strengths: [],
      source_trace_ids: [], source_message_ids: [project.messages[0]!.message_id], sample_count: 2 + i,
      owner_ids: [ownerId], status: 'task_created', task_ids: [taskId],
      created_at: job.created_at, updated_at: job.completed_at });
    const status = ['awaiting_review', 'completed', 'failed'][i]!;
    const candidate = { status: i === 1 ? 'approved' : 'candidate', candidateVersion: 'dev-candidate-' + i,
      baseVersion: 'dev-base', changeSummary: '模拟候选：解释组件时增加文件与行号依据。',
      diff: '--- before/SKILL.md\n+++ after/SKILL.md\n@@ -1 +1 @@\n- Explain each component.\n+ Explain each component with file and line references.',
      checks: [{ checkId: 'evidence-contract', passed: i !== 2, elapsedMs: 38 }] };
    await store.pool.query(`INSERT INTO evolution_tasks(task_id,skill_id,trigger,status,task_payload,ledger_payload,candidate_payload,created_at,updated_at)
      VALUES($1,'component-explanation','human_feedback',$2,$3,$4,$5,$6,$6)`,
    [taskId, status, { source: '本机模拟反馈', note: '没有运行模型或发布 Skill。' },
      { usage: { inputTokens: 2400, outputTokens: 620, costUsd: 0.012 }, note: '模拟用量' }, candidate, job.created_at]);
    if (i === 1) await store.pool.query(`INSERT INTO admin_evolution_commands(id,task_id,actor,action,reason,candidate_version,status,result)
      VALUES('dev-command',$1,'fixture','approve','模拟历史','dev-candidate-1','completed','模拟发布记录；未执行真实发布')`, [taskId]);
  }
  await docs.change('development-seeded-v1', { done: false }, v => { v.done = true; });
}

/** Persistent synthetic repository batches and shared snapshots for the local acceptance UI. */
export async function seedDevelopmentRepositories(store:PostgresStore) {
  if((await store.pool.query('SELECT current_database() AS name')).rows[0]?.name!==DEVELOPMENT_DATABASE) throw new Error('Development database required');
  const docs=adminDocuments(store);
  if(await docs.read('development-repositories-v1',false)) return;
  const owners=['github:900000001','github:900010001','github:900010002','github:900010003','github:900010004','guest:repository-demo'];
  for(const [i,id] of owners.entries()) if(i>0) await store.saveUser(id,{owner_id:id,login:i===5?'guest':'sample-developer-'+i,display_name:i===5?'示例访客':'示例开发者 '+i,kind:i===5?'guest':'github'});
  for(let i=0;i<29;i++) {
    const name=['react','fastify','typescript','redis'][i] ?? 'sample-repository-'+(i+1);
    const repository='example/'+name, key=createHash('sha256').update('admin-repository-preview:'+repository).digest('hex');
    const started=new Date(Date.now()-(i+1)*3_600_000).toISOString();
    const finished=new Date(Date.parse(started)+58_000).toISOString();
    const status=i===1?'running':i===2?'failed':i===3?'queued':'completed';
    const prefix='public-repository-snapshots/'+key;
    // Create the referenced snapshot before saveProject creates its binding.
    if(status==='completed') {
    await store.pool.query(`INSERT INTO canonical_public_repository_snapshots(public_snapshot_key,repository_identity,commit_sha,analyzer_bundle_version,analysis_config_digest,analysis_snapshot_id,view_payload,analysis_payload,source_storage_key,created_at)
      VALUES($1,$2,$3,'development','development',$4,$5,$6,$7,$8) ON CONFLICT(public_snapshot_key) DO NOTHING`,[key,repository,'d'.repeat(40),'dev-snapshot-'+i,{development:true,repository},{development:true,repository},prefix+'/source.ts',finished]);
    }
    const ids:string[]=[];
    const count=i%3===0?6:i%3===1?3:1;
    for(let u=0;u<count;u++) {
      const p=createProject(owners[u]!,`https://github.com/${repository}`,'本机共享仓库示例',null);
      p.project_id='devrepo-'+i+'-'+u;
      p.analysis.stage=status==='completed'?'done':status==='failed'?'failed':status==='queued'?'idle':'interpreting';
      p.analysis.started_at=started;p.analysis.completed_at=status==='completed'?finished:null;
      p.analysis.snapshot_id='dev-snapshot-'+i;p.analysis.canonical_snapshot_key=status==='completed'?key:null;
      p.messages.push(createMessage('user','这段代码的职责是什么？（本机模拟对话）',{
        analysis_snapshot_id:'dev-snapshot-'+i,created_at:new Date(Date.now()-i*600_000).toISOString(),
      }));
      await store.saveProject(p);ids.push(p.project_id);
    }
    const batch='dev-repository-batch-'+i;
    await store.pool.query(`INSERT INTO repository_analysis_updates(update_id,repository_identity,analyzer_bundle_version,analysis_config_digest,status,leader_project_id,created_at,updated_at,completed_at)
      VALUES($1,$2,'development','development',$3,$4,$5,$6,$7) ON CONFLICT(update_id) DO NOTHING`,[batch,repository,status,ids[0],started,finished,['completed','failed'].includes(status)?finished:null]);
    // The last owner of a six-user repository joins after completion: storage includes them, analysis excludes them.
    for(const [u,id] of ids.entries()) if(!(count===6&&u===5)) await store.pool.query(`INSERT INTO repository_analysis_update_projects(update_id,project_id,created_at) VALUES($1,$2,$3) ON CONFLICT(update_id,project_id) DO NOTHING`,[batch,id,started]);
    if(status!=='completed') continue;
    await mkdir(join(store.root,prefix),{recursive:true});
    await writeFile(join(store.root,prefix,'analysis.json'),JSON.stringify({development:true,repository,note:'模拟分析载荷，仅供本机验收',padding:'x'.repeat(32_000+i*900)}));
    await writeFile(join(store.root,prefix,'view.json'),JSON.stringify({development:true,repository}));
    await writeFile(join(store.root,prefix,'source.ts'),'// 本机模拟安全源码\nexport const example = true;\n');

    for(const id of ids) await store.pool.query(`INSERT INTO project_public_snapshot_bindings(project_id,public_snapshot_key,bound_at) VALUES($1,$2,$3) ON CONFLICT(project_id) DO NOTHING`,[id,key,finished]);
    await store.pool.query(`INSERT INTO snapshot_query_directories(public_snapshot_key,snapshot_id,schema_version,directory_digest,node_count,edge_count,evidence_count,layer_count,value_point_count)
      VALUES($1,$2,1,$1,0,0,0,0,0) ON CONFLICT(public_snapshot_key) DO NOTHING`,[key,'dev-snapshot-'+i]);
  }
  await docs.change('development-repositories-v1',{done:false},v=>{v.done=true;});
}

export async function setDevelopmentAudience(store: PostgresStore, scenario: Scenario, now = Date.now()) {
  // This destructive replacement is confined to the named synthetic database.
  if ((await store.pool.query('SELECT current_database() AS name')).rows[0]?.name !== DEVELOPMENT_DATABASE)
    throw new Error('Refusing to replace data outside the development database');
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM admin_audience_samples');
    await client.query('DELETE FROM online_presence');
    const github = scenario === 'low' ? 2 : 128, guest = scenario === 'low' ? 3 : 276;
    // Keep the fixture project owners; replace only generated audience identities.
    await client.query("DELETE FROM app_users WHERE owner_id LIKE 'github:dev-audience-%' OR owner_id LIKE 'guest:dev-audience-%'");
    for (const [kind, count] of [['github', github - 1], ['guest', guest - 1]] as const) {
      await client.query(`INSERT INTO app_users(owner_id,login,display_name,payload)
        SELECT $1 || ':dev-audience-' || n,'sample-' || n,'模拟身份 ' || n,jsonb_build_object('kind',$1::text)
        FROM generate_series(1,$2::int) n`, [kind, count]);
    }
    const minute = Math.floor(now / 60_000) * 60_000;
    const samples = [];
    for (let ago = 1439; ago >= 0 && scenario !== 'empty'; ago--) {
      if (scenario === 'stale' && ago < 15) continue;
      const at = minute - ago * 60_000;
      const gapStart = Math.floor(now / 3_600_000) * 3_600_000 - 4 * 3_600_000;
      if (scenario === 'gap' && ((at >= gapStart && at < gapStart + 3_600_000) || (ago >= 42 && ago < 47))) continue;
      const hour = new Date(at + 8 * 3_600_000).getUTCHours();
      const day = 0.12 + Math.max(0, Math.sin((hour - 7) / 16 * Math.PI));
      // Deterministic minute variation: synthetic traffic, never smoothing real data.
      const noise = (salt: number) => {
        const value = Math.sin(Math.floor(at / 60_000) * 12.9898 + salt * 78.233) * 43758.5453;
        return value - Math.floor(value) - 0.5;
      };
      const wave = noise(1) * 16;
      const burst = ago > 350 && ago < 370 ? 55 : 0;
      const onlineGithub = scenario === 'low' ? (ago % 95 < 10 ? 1 : 0) : Math.max(0, Math.round(day * 27 + wave));
      const onlineGuest = scenario === 'low' ? (ago % 130 < 8 ? 1 : 0) : Math.max(0, Math.round(day * 63 + noise(2) * 34 + burst));
      samples.push({ observed_at: new Date(at).toISOString(), github, guest, online_github: onlineGithub, online_guest: onlineGuest });
    }
    await client.query(`INSERT INTO admin_audience_samples(minute,observed_at,github,guest,online_github,online_guest)
      SELECT observed_at,observed_at,github,guest,online_github,online_guest FROM jsonb_to_recordset($1::jsonb)
      AS s(observed_at timestamptz,github int,guest int,online_github int,online_guest int)`, [JSON.stringify(samples)]);
    const latest = samples.at(-1);
    if (latest && scenario !== 'stale') {
      for (const [kind, count] of [['github', latest.online_github], ['guest', latest.online_guest]] as const)
        await client.query(`INSERT INTO online_presence(owner_id,kind,seen_at)
          SELECT owner_id,$1,clock_timestamp() FROM app_users WHERE owner_id LIKE $1 || ':%' AND deleted_at IS NULL ORDER BY owner_id LIMIT $2`, [kind, count]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
