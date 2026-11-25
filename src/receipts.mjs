import { Failure, fail } from './github.mjs';
const get = (db,id) => db.prepare('SELECT * FROM write_receipts WHERE request_id = ?').bind(id).first();
const sha = async (str) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str))), v=>v.toString(16).padStart(2,'0')).join('');
function canonical(x) {
  if(Array.isArray(x)) return x.map(canonical);
  if(x && typeof x==='object') return Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,canonical(x[k])]));
  return x;
}
export async function receipt(db,id,actor) {
  if(!db)fail('configuration','D1 receipt DB is required.');
  const x=await get(db,id);
  return x&&x.actor_id===actor?render(x):{request_id:id,status:'not_found'};
}
function render(x) {
  const stuck=x.state==='pending'&&Date.now()-x.created_ms>180000;
  return {request_id:x.request_id,status:stuck?'unknown':x.state,operation:x.operation,repo:x.repo,pr:x.pr,head_sha:x.head_sha,created_at:new Date(x.created_ms).toISOString(),...(x.result_json?JSON.parse(x.result_json):{}),...(stuck?{message:'Check GitHub before any further write. This request will not be sent again.'}:{})};
}
export async function mutate(db,actor,name,a,prepare) {
  if(!db)fail('configuration','D1 receipt DB is required; no write was attempted.');
  const hash=await sha(JSON.stringify(canonical({actor,name,a})));
  const same=x=>{if(x.actor_id!==actor||x.fingerprint!==hash)fail('request_id_conflict','Request ID was already used with a different action or payload.');return render(x)};
  const initial=await get(db,a.request_id);
  if(initial)return same(initial);
  // Remote reads and authorization checks happen before taking the durable claim.
  const run=await prepare();
  const claim=await db.prepare('INSERT OR IGNORE INTO write_receipts (request_id, actor_id, fingerprint, state, operation, repo, pr, head_sha, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(a.request_id,actor,hash,'pending',name,a.repo,a.pr,a.head_sha,Date.now()).run();
  if(claim.meta.changes!==1) {
    const previous=await get(db,a.request_id);
    if(!previous)fail('receipt_unavailable','Claim not visible yet. Check the same receipt later.');
    return same(previous);
  }
  let state, data;
  try {
    const result=await run();
    const {body: _body, ...minimal}=result;
    state='succeeded'; data={result:minimal};
  } catch(e) {
    state=e instanceof Failure&&!e.uncertain?'rejected':'unknown';
    data={code:e instanceof Failure?e.code:'unexpected',message:e instanceof Failure?e.message:'Write result could not be verified.',github_status:e.github_status,github_request_id:e.github_request_id,retry_after:e.retry_after};
  }
  try {
    const done=await db.prepare("UPDATE write_receipts SET state = ?, result_json = ? WHERE request_id = ? AND state = 'pending'").bind(state, JSON.stringify(data), a.request_id).run();
    if(done.meta.changes!==1)throw new Error('receipt write failed');
  } catch {
    return {request_id:a.request_id,status:'unknown',message:'Could not persist the receipt. Check the same request ID and GitHub. Do not resend under a new ID.'};
  }
  return {request_id:a.request_id,status:state,...data};
}
