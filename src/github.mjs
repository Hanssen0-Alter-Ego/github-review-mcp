const API = 'https://api.github.com';
export class Failure extends Error {
  constructor(code, message, options = {}) { super(message); this.code = code; Object.assign(this, options); }
}
export const fail = (code, message) => { throw new Failure(code, message); };
export function policy(env) {
  const pattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/;
  const repos = new Set((env.ALLOWED_REPOS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const actor = Number(env.GITHUB_ACTOR_ID);
  if (!repos.size || [...repos].some(x => !pattern.test(x)) || !Number.isSafeInteger(actor) || actor < 1 || !env.GITHUB_TOKEN)
    fail('configuration', 'Configure an explicit repository allowlist, GitHub actor ID and token.');
  return { repos, actor };
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const who = x => x ? pick(x, ['id', 'login']) : null;
export const item = x => ({...pick(x, ['id','node_id','html_url','body','created_at','updated_at','submitted_at','state','commit_id','path','line','side','start_line','start_side','in_reply_to_id','pull_request_review_id']),user:who(x.user)});
const q = (page, limit=20) => '?per_page='+limit+'&page='+page;
export function github(env, fetcher = fetch) {
  const p = policy(env);
  async function api(path, method = 'GET', body, mutation = false) {
    let r;
    try {
      r = await fetcher(API+path, {
        method, redirect:'error', signal:AbortSignal.timeout(12000),
        headers:{ Authorization:'Bearer '+env.GITHUB_TOKEN, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'github-review-mcp', ...(body ? {'Content-Type':'application/json'} : {}) },
        ...(body ? {body:JSON.stringify(body)} : {})
      });
    } catch { throw new Failure('github_transport', 'GitHub request failed or timed out.', {uncertain:mutation}); }
    const request_id = r.headers.get('x-github-request-id');
    if (!r.ok) throw new Failure('github_http', 'GitHub returned HTTP '+r.status+'.', {
      github_status:r.status, github_request_id:request_id, retry_after:r.headers.get('retry-after'),
      uncertain:mutation && (r.status>=500 || r.status===408)
    });
    try { return await r.json(); }
    catch { throw new Failure('github_response', 'GitHub returned an unreadable response.', {uncertain:mutation,github_request_id:request_id}); }
  }
  async function graph(query, variables, mutation=false) {
    const t=await api('/graphql','POST',{query,variables},mutation);
    if (t.errors?.length || !t.data)
      throw new Failure('github_graphql','GitHub GraphQL rejected the operation or returned partial data.',{uncertain:mutation});
    return t.data;
  }
  async function identity() {
    const actor=await api('/user');
    if (actor.id!==p.actor) fail('wrong_actor','Configured GitHub token belongs to a different account.');
    return who(actor);
  }
  const prView = x => ({...pick(x,['id','node_id','number','html_url','title','body','state','draft','merged','mergeable','mergeable_state','created_at','updated_at']),user:who(x.user),head_sha:x.head?.sha,base_sha:x.base?.sha,base_ref:x.base?.ref});
  async function target({repo,pr}) {
    if (!p.repos.has(repo)) fail('repo_denied','Repository is not in the allowlist.');
    const root='/repos/'+repo, pull=root+'/pulls/'+pr, issue=root+'/issues/'+pr, current=await api(pull);
    if (current.number!==pr || current.base?.repo?.full_name?.toLowerCase()!==repo)
      fail('wrong_target','GitHub returned a different repository or pull request.');
    return {root,pull,issue,current,repo,pr};
  }
  function guard(t, head) {
    if(t.current.state!=='open'||t.current.merged) fail('pr_closed','Pull request is not open.');
    if(t.current.head?.sha!==head) fail('head_changed','PR head changed. Read it again before writing.');
  }
  const defs={
    timeline:['/issues/comments','issue_url','issue'],
    inline:['/pulls/comments','pull_request_url','pull'],
    review:['/pulls','pull_request_url','pull']
  };
  async function comment(t, kind, id) {
    const [path,key,scope]=defs[kind];
    const url=kind==='review'?t.pull+'/reviews/'+id:t.root+path+'/'+id;
    const v=await api(url);
    if(v.id!==id || v[key]?.toLowerCase()!==(API+t[scope]).toLowerCase())
      fail('wrong_target','Comment or review is not part of the specified PR.');
    return {v,url};
  }
  function own(x){ if(x.user?.id!==p.actor) fail('not_owned','Only content created by the configured GitHub account can be edited or resolved.'); }
  const THREAD_FIELDS='id isResolved isOutdated path line startLine viewerCanResolve viewerCanUnresolve';
  const THREAD_COMMENT='id fullDatabaseId url body author { login } createdAt updatedAt replyTo { id }';
  async function thread(t,id,cursor) {
    const d=await graph(`query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{${THREAD_FIELDS}
      root:comments(first:1){nodes{${THREAD_COMMENT} pullRequest { id }}}
      comments(first:20,after:$cursor){nodes{${THREAD_COMMENT}} pageInfo{hasNextPage endCursor}}
    }}}`,{id,cursor:cursor??null});
    const r=d.node;
    if(r?.id!==id || r.root?.nodes?.[0]?.pullRequest?.id!==t.current.node_id)
      fail('wrong_target','Review thread is not part of the specified PR.');
    return r;
  }
  return { identity, async read(name,a) {
    if(name==='github_status') {
      const actor=await identity();
      let receipts_ready=false;
      try { if(env.RECEIPTS){await env.RECEIPTS.prepare('SELECT request_id FROM write_receipts LIMIT 1').first();receipts_ready=true;} } catch {}
      return {actor,allowed_repos:[...p.repos],receipts_ready,write_enabled:receipts_ready};
    }
    await identity();
    const t=await target(a);
    if(name==='github_get_pr') return prView(t.current);
    if(name==='github_list_pr_files') {
      const x=await api(t.pull+'/files'+q(a.page,10));
      return {head_sha:t.current.head.sha,items:x.map(f=>({...pick(f,['filename','previous_filename','status','additions','deletions','sha']),...(a.include_patch?{patch:f.patch?.slice(0,12000)??null,patch_truncated:(f.patch?.length??0)>12000}:{})})),next_page:x.length===10&&a.page<300?a.page+1:null,gitHub_file_limit:3000};
    }
    if(name==='github_list_pr_discussion'){
      const url={timeline:t.issue+'/comments',inline:t.pull+'/comments',review:t.pull+'/reviews'}[a.kind];
      const x=await api(url+q(a.page));return {kind:a.kind,items:x.map(item),next_page:x.length===20?a.page+1:null};
    }
    if(name==='github_get_review_thread') { const x=await thread(t,a.thread_id,a.cursor);return {...x,root:x.root.nodes[0]}; }
    if(name==='github_list_review_threads'){
      const [owner,repo]=a.repo.split('/');
      const d=await graph(`query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){id reviewThreads(first:20,after:$cursor){nodes{${THREAD_FIELDS} comments(first:1){nodes{${THREAD_COMMENT}}}} pageInfo{hasNextPage endCursor}}}}}`,{owner,repo,pr:a.pr,cursor:a.cursor??null});
      const x=d.repository?.pullRequest;if(x?.id!==t.current.node_id)fail('wrong_target','Review thread query returned a different PR.');
      return x.reviewThreads;
    }
    if(name==='github_get_pr_checks'){
      const x=await api(t.root+'/commits/'+t.current.head.sha+'/check-runs'+q(a.page,30));
      const s=await api(t.root+'/commits/'+t.current.head.sha+'/status'+q(a.page,30));
      return {head_sha:t.current.head.sha,check_runs:x.check_runs.map(v=>pick(v,['name','status','conclusion','details_url','completed_at'])),commit_status:s.state,statuses:s.statuses.map(v=>pick(v,['context','state','target_url','description'])),next_page:x.check_runs.length===30||s.statuses.length===30?a.page+1:null};
    }
    fail('tool_unknown','Unknown read operation.');
  }, async prepare(name,a) {
    await identity();
    const t=await target(a);
    guard(t,a.head_sha);
    let action;
    const write=(url,method,body)=>async()=>item(await api(url,method,body,true));
    if(name==='github_edit_pr'){
      own(t.current);
      const patch=pick(a,['title','body']);
      if(!Object.keys(patch).length||('title' in patch&&!patch.title.trim()))fail('invalid_args','Provide a nonblank title and/or a description.');
      if(a.expected_updated_at!==undefined&&t.current.updated_at!==a.expected_updated_at)fail('body_changed','PR metadata changed since it was read.');
      action=async()=>{
        const x=await api(t.pull,'PATCH',patch,true);
        if(x.id!==t.current.id||Object.keys(patch).some(k=>(x[k]??'')!==patch[k]))
          throw new Failure('github_response','GitHub returned an unexpected PR edit receipt.',{uncertain:true});
        return prView(x);
      };
    }
    if(name==='github_create_pr_comment') action=write(t.issue+'/comments','POST',{body:a.body});
    if(name==='github_submit_review') action=write(t.pull+'/reviews','POST',{commit_id:a.head_sha,event:'COMMENT',body:a.body,comments:a.inline_comments});
    if(name==='github_edit_comment'){
      const {v,url}=await comment(t,a.kind,a.comment_id);own(v);
      if(a.expected_body!==undefined && v.body!==a.expected_body)fail('body_changed','Target content changed since it was read.');
      action=v.body===a.body?async()=>item(v):write(url,a.kind==='review'?'PUT':'PATCH',{body:a.body});
    }
    if(name==='github_reply_review_comment'){
      const {v}=await comment(t,'inline',a.comment_id);
      const root=v.in_reply_to_id??v.id;
      if(root!==v.id) await comment(t,'inline',root);
      action=write(t.pull+'/comments/'+root+'/replies','POST',{body:a.body});
    }
    if(name==='github_add_reaction'){
      const {v}=await comment(t,a.kind,a.comment_id);
      if(!v.node_id)fail('wrong_target','Missing reaction subject ID.');
      action=async()=>{
        const d=await graph('mutation($id:ID!,$reaction:ReactionContent!){addReaction(input:{subjectId:$id,content:$reaction}){reaction{content} subject{id}}}',{id:v.node_id,reaction:a.reaction},true);
        const r=d.addReaction;
        if(r?.subject?.id!==v.node_id||r.reaction?.content!==a.reaction)throw new Failure('github_response','Reaction receipt could not be verified.',{uncertain:true});
        return {subject_id:v.node_id,content:r.reaction.content,url:v.html_url};
      };
    }
    if(name==='github_set_review_thread_resolution'){
      const x=await thread(t,a.thread_id);
      const root=x.root.nodes[0], id=Number(root.fullDatabaseId);
      if(!Number.isSafeInteger(id)||id<1)fail('wrong_target','Missing root review-comment ID.');
      const {v}=await comment(t,'inline',id);own(v);
      if(x.isResolved===a.resolved)action=async()=>({thread_id:x.id,resolved:x.isResolved});
      else {
        if(!(a.resolved?x.viewerCanResolve:x.viewerCanUnresolve)) fail('permission_denied','GitHub does not grant this account permission to change the thread.');
        const m=a.resolved?'resolveReviewThread':'unresolveReviewThread';
        action=async()=>{
          const d=await graph(`mutation($id:ID!){${m}(input:{threadId:$id}){thread{id isResolved}}}`,{id:x.id},true);
          const r=d[m]?.thread;
          if(r?.id!==x.id||r.isResolved!==a.resolved)throw new Failure('github_response','Thread receipt could not be verified.',{uncertain:true});
          return {thread_id:r.id,resolved:r.isResolved};
        };
      }
    }
    if(!action)fail('tool_unknown','Unknown write operation.');
    return async()=>{
      const fresh=await target(a);guard(fresh,a.head_sha);
      if(fresh.current.id!==t.current.id)fail('wrong_target','PR identity changed before the write.');
      const x=await action();
      if (name!=='github_add_reaction' && name!=='github_set_review_thread_resolution' && !x.id)
        throw new Failure('github_response','GitHub did not return a mutation ID.',{uncertain:true});
      if(name==='github_submit_review'&&(x.commit_id!==a.head_sha||x.state!=='COMMENTED'||x.user?.id!==p.actor))
        throw new Failure('github_response','GitHub review receipt did not match the expected commit, state or actor.',{uncertain:true});
      return x;
    };
  }};
}
