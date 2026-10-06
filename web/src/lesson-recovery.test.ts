import {describe,it,expect} from 'vitest';
import {lessonRecovery,protectsLessonDescendants} from './lesson-recovery';
import type {Project,Message,LearningActionCard} from './types';
const row=(id:string,role:Message['role']):Message=>({message_id:id,role,content:id,created_at:'2026-10-04T00:00:00Z',evidence:[],model:null,usage:null,latency_ms:null,error:null,placeholder:false});
function fixture(){
 const action={action_id:'action',action:'start_learning_route',source_message_id:'user',snapshot_id:'snapshot',status:'executed',outcome:{route_revision:2,next_step_id:'step',next_step_title:'step',lesson_run_id:'first'}} as LearningActionCard;
 const card={...row('card','assistant'),learning_action:action};
 const source={...row('source','system'),trace_id:'first',lesson_request:{action_id:'action',snapshot_id:'snapshot',route_revision:2,step_id:'step'}};
 const answer={...row('answer','assistant'),trace_id:'first',teaching_question:{question_id:'q',snapshot_id:'snapshot',route_revision:2,step_id:'step'}};
 const project={project_id:'project',analysis:{snapshot_id:'snapshot'},study:{snapshot_id:'snapshot',phase:'explaining',route_revision:2,current_step:0,dynamic_learning_plan:[{step_id:'step'}]},messages:[row('user','user'),card]} as unknown as Project;
 return {project,action,source,answer};
}
describe('program lesson recovery',()=>{
 it('only starts a current executed server marker',()=>{const f=fixture();expect(lessonRecovery(f.project)?.state).toBe('start');delete f.action.outcome!.lesson_run_id;expect(lessonRecovery(f.project)).toBeNull();});
 it.each(['declined','failed','expired','pending','confirmed'] as const)('rejects %s authorization',status=>{const f=fixture();f.action.status=status;expect(lessonRecovery(f.project)).toBeNull();});
 it('rejects stop, no next step and stale scopes',()=>{const f=fixture();f.action.action='stop_guided_learning';expect(lessonRecovery(f.project)).toBeNull();f.action.action='advance_learning_step';f.action.outcome!.next_step_id=null;expect(lessonRecovery(f.project)).toBeNull();f.action.outcome!.next_step_id='step';f.action.outcome!.route_revision=1;expect(lessonRecovery(f.project)).toBeNull();f.action.outcome!.route_revision=2;f.action.snapshot_id='old';expect(lessonRecovery(f.project)).toBeNull();});
 it('resumes a saved source and only accepts its adjacent terminal',()=>{const f=fixture();f.project.messages.push(f.source);expect(lessonRecovery(f.project)?.state).toBe('resume');f.project.messages.push({...f.answer,trace_id:'another'});expect(lessonRecovery(f.project)?.state).toBe('resume');f.project.messages.pop();f.project.messages.push(f.answer);expect(lessonRecovery(f.project)?.state).toBe('completed');});
 it.each(['error','unavailable','ineligible'] as const)('never auto retries %s terminal',kind=>{const f=fixture();const answer={...f.answer,...kind==='error'?{error:'failed'}:kind==='unavailable'?{teaching_question:undefined}:{context_eligible:false}};f.project.messages.push(f.source,answer);expect(lessonRecovery(f.project)?.state).toBe('failed');});
 it('leaves legacy executed receipts editable when they have no lesson marker or source',()=>{const f=fixture();delete f.action.outcome!.lesson_run_id;f.project.messages[0]!.learning_action_result={action_id:'action',route_revision:2,step_id:'step'};expect(protectsLessonDescendants(f.project,'user')).toBe(false);});
 it('keeps last-message editing available before a program source is persisted',()=>{const f=fixture();expect(protectsLessonDescendants(f.project,'user')).toBe(false);});
 it('protects only the confirmed source from replay truncation',()=>{const f=fixture();f.project.messages.unshift(row('unrelated','user'));f.project.messages.push(f.source,f.answer);expect(protectsLessonDescendants(f.project,'user')).toBe(true);expect(protectsLessonDescendants(f.project,'unrelated')).toBe(false);});
});
