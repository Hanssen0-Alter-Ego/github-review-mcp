import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handler } from '../src/index.mjs';

const H='a'.repeat(40), ACCESS='a'.repeat(43), PATH='z'.repeat(43), URL_BASE='https://worker.example';
const origin='https://api.github.com', root='/repos/team/project', paths={pull:root+'/pulls/9',issue:root+'/issues/9'};
const write={repo:'Team/Project',pr:9,head_sha:H,request_id:'xyz-test-1'};
function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_write_receipts.sql',import.meta.url),'utf8'));
  const env={GITHUB_TOKEN:'not-a-real-token',GITHUB_ACTOR_ID:'1',ALLOWED_REPOS:'Team/Project',MCP_ACCESS_TOKEN:ACCESS,MCP_PATH_TOKEN:PATH,MCP_PUBLIC_ORIGIN:URL_BASE,RECEIPTS:{
    prepare(sql){const s=db.prepare(sql);return {first:async()=>s.get(),bind(...a){return {first:async()=>s.get(...a),run:async()=>({meta:s.run(...a)})}}}}
  }};
  const mock={head:H,state:'open',actor:1,owner:1,commentOwner:1,commentUrl:origin+paths.issue,timeout:false,failStatus:0,pr_reads:0,calls:[]};
  const pr=()=>({id:199,node_id:'PR_test',number:9,state:mock.state,head:{sha:mock.head},base:{sha:'b'.repeat(40),ref:'main',repo:{full_name:'team/project'}},title:'test',body:'previous',user:{id:mock.owner},updated_at:'2026-11-25T12:01:02Z'});
  const c=(data={})=>({id:123,node_id:'IC_test',html_url:'https://github.com/team/project/pull/9#issuecomment-123',body:'previous',user:{login:'bot',id:mock.commentOwner},...data});
  const worker=handler(async (u,init)=>{
    assert.equal(new URL(u).origin,origin);
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer not-a-real-token');
    const p=u.slice(origin.length), m=init.method, b=init.body===undefined?undefined:JSON.parse(init.body);
    mock.calls.push({p,m,b});
    if(p==='/user')return Response.json({id:mock.actor,login:'bot'});
    if(p===paths.pull&&m==='GET'){mock.pr_reads++;if(mock.advanceAt===mock.pr_reads)mock.head='c'.repeat(40);return Response.json(pr())}
    if(p===root+'/issues/comments/123'&&m==='GET')return Response.json(c({issue_url:mock.commentUrl}));
    if(p===root+'/pulls/comments/123'&&m==='GET')return Response.json(c({pull_request_url:origin+paths.pull}));
    if(p===root+'/pulls/comments/124'&&m==='GET')return Response.json(c({id:124,in_reply_to_id:123,pull_request_url:origin+paths.pull}));
    if(p===paths.pull+'/reviews/123'&&m==='GET')return Response.json(c({pull_request_url:origin+paths.pull}));
    if(p==='/graphql'){
      if(b.query.includes('query($id'))return Response.json({data:{node:{id:b.variables.id,isResolved:false,viewerCanResolve:true,root:{nodes:[{fullDatabaseId:'123',pullRequest:{id:'PR_test'}}]},comments:{nodes:[]}}}});
      if(b.query.includes('addReaction'))return Response.json({data:{addReaction:{subject:{id:b.variables.id},reaction:{content:b.variables.reaction}}}});
      if(b.query.includes('resolveReviewThread'))return Response.json({data:{resolveReviewThread:{thread:{id:b.variables.id,isResolved:true}}}});
    }
    if(m==='GET')throw new Error('Unrecognized GET '+p);
    if(mock.timeout)throw new TypeError('timeout');
    if(mock.failStatus)return new Response('redacted',{status:mock.failStatus,headers:{'x-github-request-id':'req-mock'}});
    if(p===paths.pull&&m==='PATCH')return Response.json({...pr(),...b});
    if(p===paths.pull+'/reviews')return Response.json(c({commit_id:b.commit_id,state:'COMMENTED',body:b.body}));
    return Response.json(c({body:b.body}));
  });
  const http=(p,opts)=>worker(new Request(URL_BASE+p,opts),env);
  const rpc=async (name,args)=>{
    const r=await http('/mcp',{method:'POST',headers:{Authorization:'Bearer '+ACCESS,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name,arguments:args}})});
    assert.equal(r.status,200);const x=await r.json();return x.result?.structuredContent??x;
  };
  return {env,mock,http,rpc,worker,mutations:()=>mock.calls.filter(x=>x.m!=='GET'&&(x.p!=='/graphql'||x.b.query.startsWith('mutation')))};
}
test('real MCP SDK client initializes and lists tools over HTTP',async()=>{
  const f=fixture(), c=new Client({name:'test',version:'1.0.0'});
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_BASE+'/mcp'),{
    requestInit:{headers:{Authorization:'Bearer '+ACCESS}},
    fetch:(url,init)=>f.worker(new Request(url,init),f.env),
  }));
  const ts=(await c.listTools()).tools;
  assert.equal(ts.length,15);
  const got=await c.callTool({name:'github_status',arguments:{}});
  assert.equal(got.structuredContent.actor.id,1);
  assert.equal(got.structuredContent.receipts_ready,true);
  await c.close();
});
test('disallows unauthenticated, query, wrong origin and spoofed platform identity',async()=>{
  const f=fixture();
  assert.equal((await f.http('/mcp',{headers:{'oai-authenticated-user-id':'1'}})).status,401);
  assert.equal((await f.http('/mcp?token='+ACCESS)).status,404);
  assert.equal((await f.http('/mcp',{headers:{Origin:'https://untrusted.example',Authorization:'Bearer '+ACCESS}})).status,403);
  assert.equal((await f.http('/mcp',{headers:{Authorization:'Bearer '+ACCESS}})).status,405);
  assert.equal(f.mock.calls.length,0);
});
test('private path auth is separate, optional, scoped to exact configured HTTPS origin',async()=>{
  const f=fixture();
  const opts={method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})};
  assert.equal((await f.http('/mcp/'+PATH,opts)).status,200);
  assert.equal((await f.http('/mcp/'+ACCESS,opts)).status,401);
  assert.equal((await f.worker(new Request('https://wrong.example/mcp/'+PATH,opts),f.env)).status,404);
  delete f.env.MCP_PATH_TOKEN;
  assert.equal((await f.http('/mcp/'+PATH,opts)).status,404);
});
test('receipt prevents duplicate writes even for concurrent requests',async()=>{
  const f=fixture(), a={...write,body:'Review started'};
  const r=await Promise.all([f.rpc('github_create_pr_comment',a),f.rpc('github_create_pr_comment',a)]);
  assert.ok(r.some(x=>x.status==='succeeded'));
  assert.equal((await f.rpc('github_write_receipt',{request_id:a.request_id})).status,'succeeded');
  assert.equal((await f.rpc('github_create_pr_comment',a)).status,'succeeded');
  assert.equal((await f.rpc('github_create_pr_comment',{...a,body:'different'})).code,'request_id_conflict');
  assert.equal(f.mutations().length,1);
});
test('ambiguous timeout or upstream failure stays unknown; not retried',async()=>{
  for(const why of [{timeout:true},{failStatus:502}]){
    const f=fixture();Object.assign(f.mock,why);
    const a={...write,body:'test'};
    assert.equal((await f.rpc('github_create_pr_comment',a)).status,'unknown');
    assert.equal((await f.rpc('github_create_pr_comment',a)).status,'unknown');
    assert.equal(f.mutations().length,1);
  }
});
test('GitHub permission refusal is surfaced without fallback',async()=>{
  const f=fixture();f.mock.failStatus=403;
  const x=await f.rpc('github_create_pr_comment',{...write,body:'test'});
  assert.equal(x.status,'rejected');assert.equal(x.github_status,403);assert.equal(f.mutations().length,1);
});
test('rejects closed or stale heads, disallowed repository, mismatched actor and cross-PR target',async()=>{
  for(const [patch,args,code] of [
    [{state:'closed'}, {},'pr_closed'], [{head:'b'.repeat(40)}, {}, 'head_changed'],
    [{}, {repo:'team/elsewhere'}, 'repo_denied'], [{actor:999},{},'wrong_actor'],
    [{commentUrl:origin+root+'/issues/10'},{},'wrong_target'],[{commentOwner:2},{},'not_owned'],
  ]){
    const f=fixture();Object.assign(f.mock,patch);
    assert.equal((await f.rpc('github_edit_comment',{...write,kind:'timeline',comment_id:123,body:'new',...args})).code,code);
    assert.equal(f.mutations().length,0);
  }
});
test('rechecks PR head immediately before write',async()=>{
  const f=fixture();f.mock.advanceAt=2;
  const r=await f.rpc('github_create_pr_comment',{...write,body:'test'});
  assert.equal(r.status,'rejected');assert.equal(r.code,'head_changed');assert.equal(f.mutations().length,0);
});
test('review is COMMENT only and uses exact commit plus inline side/line',async()=>{
  const f=fixture(), inline={path:'src/main.ts',line:23,side:'RIGHT',body:'note'};
  const a={...write,body:'Overview',inline_comments:[inline]};
  const invalid=await f.rpc('github_submit_review',{...a,event:'APPROVE'});
  assert.notEqual(invalid.status,'succeeded');assert.equal(f.mutations().length,0);
  assert.equal((await f.rpc('github_submit_review',a)).status,'succeeded');
  assert.deepEqual(f.mutations()[0].b,{commit_id:H,event:'COMMENT',body:'Overview',comments:[inline]});
});
test('owned PR metadata and review summary can be edited, no state change exposed',async()=>{
  const f=fixture();
  const r=await f.rpc('github_edit_pr',{...write,title:'updated'});
  assert.equal(r.status,'succeeded');
  assert.deepEqual(f.mutations()[0].b,{title:'updated'});
  const a=await f.rpc('github_edit_comment',{...write,request_id:'xyz-edit-review',kind:'review',comment_id:123,body:'updated'});
  assert.equal(a.status,'succeeded');assert.equal(f.mutations()[1].m,'PUT');
});
test('reply stays on root comment; emoji uses scoped node; resolve verifies thread and root ownership',async()=>{
  const f=fixture();
  assert.equal((await f.rpc('github_reply_review_comment',{...write,comment_id:124,body:'verified'})).status,'succeeded');
  assert.equal(f.mutations()[0].p,paths.pull+'/comments/123/replies');
  assert.equal((await f.rpc('github_add_reaction',{...write,request_id:'xyz-reaction',kind:'review',comment_id:123,reaction:'HEART'})).status,'succeeded');
  f.mock.commentOwner=2;
  assert.equal((await f.rpc('github_set_review_thread_resolution',{...write,request_id:'xyz-resolve',thread_id:'PRRT_test',resolved:true})).code,'not_owned');
  f.mock.commentOwner=1;
  assert.equal((await f.rpc('github_set_review_thread_resolution',{...write,request_id:'xyz-resolve',thread_id:'PRRT_test',resolved:true})).status,'succeeded');
});
test('missing receipt DB fails closed before any write',async()=>{
  const f=fixture();delete f.env.RECEIPTS;
  assert.equal((await f.rpc('github_create_pr_comment',{...write,body:'test'})).code,'configuration');
  assert.equal(f.mock.calls.length,0);
});
