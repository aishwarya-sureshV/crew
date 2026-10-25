import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrew } from './crew.js';
import { crewExecutor } from './crew-agent.js';
import { git } from './snapshots.js';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'crew-independent-')); t.after(() => rm(root, {recursive:true,force:true}));
 const repo = join(root,'repo'); await mkdir(repo);
 for (const args of [['init'],['config','user.email','qa@example.invalid'],['config','user.name','QA']]) assert.equal((await git(repo,args)).ok,true);
 await writeFile(join(repo,'base.txt'),'base\n'); await git(repo,['add','.']); await git(repo,['commit','-m','base']);
 return {repo,home:join(root,'home')};
}
const task = (id, kind='execute', dependencies=[]) => ({id,kind,backend:'codex',outcome:`write ${id}`,dependencies,scope:['.'],checks:['test -f base.txt']});
const config = (repo, tasks, mode='sequential') => ({request:'Complete assigned outcomes',cwd:repo,mode,concurrency:2,tasks,reviewer:{backend:'codex'}});
async function until(crew,id,predicate) { for(let n=0;n<4000;n++){const r=crew.read(id);if(predicate(r))return r;await delay(10);}assert.fail(JSON.stringify(crew.read(id))); }
const settled = (crew,id) => until(crew,id,r=>['done','blocked','awaiting_approval'].includes(r.status));
async function worker(a) {if(!a.readOnly) await writeFile(join(a.cwd,/write (\w+)/.exec(a.prompt)[1]+'.txt'),'done\n');return 'CREW_VERDICT: PASS';}
for(const mode of ['sequential','parallel']) test(`${mode}: saved Build→Review route finishes without empty-cherry-pick conflict`,async t=>{
 const {repo,home}=await fixture(t);const crew=createCrew({home,execute:worker}); const r=crew.create('owner',config(repo,[task('build'),task('review','review',['build'])],mode),'review-'+mode);
 await crew.action('owner',r.id,'start'); const result=await settled(crew,r.id); assert.equal(result.status,'done',JSON.stringify({status:result.status,tasks:result.tasks.map(t=>({id:t.id,status:t.status,error:t.error}))}));
});
test('no-op implementation can pass checks and review',async t=>{
 const {repo,home}=await fixture(t);const crew=createCrew({home,execute:async()=> 'Already satisfied. CREW_VERDICT: PASS'});const r=crew.create('owner',config(repo,[task('noop')]),'noop-validation');await crew.action('owner',r.id,'start');const result=await settled(crew,r.id);assert.equal(result.status,'done',result.tasks[0].error);
});
test('parallel dependent sees accepted predecessor files, not just its report',async t=>{
 const {repo,home}=await fixture(t);let saw=false; const crew=createCrew({home,execute:async a=>{if(!a.readOnly&&a.prompt.startsWith('Crew assignment: write second')){assert.equal(await readFile(join(a.cwd,'first.txt'),'utf8'),'done\n');saw=true;}return worker(a);}});
 const r=crew.create('owner',config(repo,[task('first'),task('second','execute',['first'])],'parallel'),'dependency-files');await crew.action('owner',r.id,'start');assert.equal((await settled(crew,r.id)).status,'done');assert.equal(saw,true);
});
test('stop cancels running acceptance command before its later side effect',async t=>{
 const {repo,home}=await fixture(t);const a=task('build');a.checks=['touch gate-started; sleep 1; touch gate-after-stop'];const crew=createCrew({home,execute:worker}); const r=crew.create('owner',config(repo,[a]),'stop-acceptance');await crew.action('owner',r.id,'start');
 const running=await until(crew,r.id,r=>r.tasks[0].status==='reviewing');const cwd=running.tasks[0].worktree.path;
 for(let n=0;n<100;n++){try{await readFile(join(cwd,'gate-started'));break;}catch{await delay(10);}}
 const started=Date.now();await crew.action('owner',r.id,'stop');const elapsed=Date.now()-started;
 let after=false;try{await readFile(join(cwd,'gate-after-stop'));after=true;}catch{}
 assert.equal(after,false,`Acceptance command continued after Stop (${elapsed} ms)`);
});
test('native startup observes configured timeout and abort',async()=>{
 let release;const starting=new Promise(r=>release=r);let stopped=false;const controller=new AbortController();
 const execute=crewExecutor({timeoutMs:30,getAgent:()=>({start:()=>starting}),stopAgent:()=>{stopped=true;}});
 const pending=execute({backend:'codex',sessionKey:'startup-test',cwd:'/tmp',prompt:'test',signal:controller.signal,onEvent(){},onSession(){}}).catch(e=>e);
 controller.abort();await delay(80);const failedToStop=!stopped;release({ok:true});await pending;assert.equal(failedToStop,false,'Abort and lifetime timeout do not cover agent.start');
});
test('rename cannot delete a file outside the approved scope',async t=>{
 const {repo,home}=await fixture(t);const build=task('rename');build.scope=['allowed.txt'];build.checks=['test -f allowed.txt'];
 const crew=createCrew({home,execute:async a=>{if(!a.readOnly){const fs=await import('node:fs/promises');await fs.rename(join(a.cwd,'base.txt'),join(a.cwd,'allowed.txt'));}return 'CREW_VERDICT: PASS';}});
 const r=crew.create('owner',config(repo,[build]),'rename-scope-test');await crew.action('owner',r.id,'start');const result=await settled(crew,r.id);assert.equal(result.status,'blocked','Out-of-scope source deletion passed scope validation');assert.match(result.tasks[0].error,/scope/);
});
test('final review cannot change HEAD while preserving working-tree content',async t=>{
 const {repo,home}=await fixture(t);const crew=createCrew({home,execute:async a=>{if(a.prompt.startsWith('Independently validate')){const baseline=/Baseline: (\w+)/.exec(a.prompt)[1];assert.equal((await git(a.cwd,['reset','--soft',baseline])).ok,true);}return worker(a);}});
 const r=crew.create('owner',config(repo,[task('build')]),'final-head-test');await crew.action('owner',r.id,'start');const result=await settled(crew,r.id);assert.equal(result.status,'blocked',`Final review rewound accepted commits, yet run ${result.status} with diff ${JSON.stringify(result.diff)}`);
});
test('retry receives failed server check output as repair evidence',async t=>{
 const {repo,home}=await fixture(t);let builds=0;let retryPrompt='';const build=task('build');build.checks=['sh gate.sh'];
 await writeFile(join(repo,'gate.sh'),'test -f repair.txt || { echo NATIVE_SERVER_FAILURE_DETAIL; exit 1; }\n');await git(repo,['add','gate.sh']);await git(repo,['commit','-m','gate']);
 const crew=createCrew({home,execute:async a=>{if(!a.readOnly){builds++;if(builds===2){retryPrompt=a.prompt;await writeFile(join(a.cwd,'repair.txt'),'fixed');}}return worker(a);}});
 const r=crew.create('owner',config(repo,[build]),'retry-evidence-test');await crew.action('owner',r.id,'start');const first=await settled(crew,r.id);assert.equal(first.status,'blocked');
 assert.match(first.tasks[0].gate.results[0].output,/NATIVE_SERVER_FAILURE_DETAIL/);
 await crew.action('owner',r.id,'retry',{taskId:'build'});await settled(crew,r.id);assert.match(retryPrompt,/NATIVE_SERVER_FAILURE_DETAIL/,'Repair agent did not receive persisted server failure evidence');
});
test('parallel Stop waits for every in-flight worker before permitting restart',async t=>{
 const {repo,home}=await fixture(t);let reviewStarted=false;
 const crew=createCrew({home,execute:async a=>{
  if(a.prompt.startsWith('Crew assignment: write slow')) {await new Promise(resolve=>a.signal.addEventListener('abort',()=>setTimeout(resolve,150),{once:true}));throw new Error('slow stopped');}
  if(a.readOnly){reviewStarted=true;await new Promise(resolve=>a.signal.addEventListener('abort',resolve,{once:true}));throw new Error('review stopped');}
  return worker(a);
 }});
 const r=crew.create('owner',config(repo,[task('fast'),task('slow')],'parallel'),'parallel-stop-all');await crew.action('owner',r.id,'start');for(let n=0;n<1000&&!reviewStarted;n++)await delay(10);assert.equal(reviewStarted,true);
 const stopped=await crew.action('owner',r.id,'stop');const statuses=stopped.tasks.map(t=>t.status);await delay(200);assert.equal(statuses.some(s=>['running','reviewing'].includes(s)),false,`Stop resolved with active tasks: ${statuses}`);
});
for(const mode of ['sequential','parallel']) test(`${mode}: combined-review repair consumes findings and revalidates integration`,async t=>{
 const {repo,home}=await fixture(t);let reviews=0;let repairPrompt='';
 const crew=createCrew({home,execute:async a=>{
  if(a.prompt.startsWith('Independently validate')){reviews++;return reviews===1?'Missing original requirement: add repair.txt. CREW_VERDICT: FAIL':'CREW_VERDICT: PASS';}
  if(!a.readOnly&&a.prompt.startsWith('Crew assignment: Repair')){repairPrompt=a.prompt;assert.equal(await readFile(join(a.cwd,'build.txt'),'utf8'),'done\n');await writeFile(join(a.cwd,'repair.txt'),'fixed\n');return 'Repaired final finding';}
  return worker(a);
 }});
 const r=crew.create('owner',config(repo,[task('build')],mode),'combined-repair-'+mode);await crew.action('owner',r.id,'start');const blocked=await settled(crew,r.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.phase,'combined_validation');
 await crew.action('owner',r.id,'repair');const result=await settled(crew,r.id);assert.equal(result.status,'done',JSON.stringify(result));assert.equal(result.repairs,1);assert.equal(reviews,2);assert.match(repairPrompt,/Missing original requirement/);assert.match(result.diff,/repair.txt/);
});
test('combined-review repairs remain bounded at three rounds',async t=>{
 const {repo,home}=await fixture(t);const crew=createCrew({home,execute:async a=>{
  if(a.prompt.startsWith('Independently validate'))return 'Missing requirement. CREW_VERDICT: FAIL';
  if(!a.readOnly&&a.prompt.startsWith('Crew assignment: Repair'))return 'No further changes';return worker(a);
 }});
 const r=crew.create('owner',config(repo,[task('build')]),'repair-bound-test');await crew.action('owner',r.id,'start');await settled(crew,r.id);
 for(let n=0;n<3;n++){await crew.action('owner',r.id,'repair');assert.equal((await settled(crew,r.id)).status,'blocked');}
 await assert.rejects(crew.action('owner',r.id,'repair'),/limit reached/);assert.equal(crew.read(r.id).tasks.length,4);
});
