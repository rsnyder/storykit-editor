/** Live M0 proof. Only the explicitly designated disposable repository.
 * gh owns credential access; no token is read, printed or put in a file. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { encode } from 'fast-png';
import { commitPackage, reconcilePackage } from '../src/package-commit.js';
const repository = 'rsnyder/storykit-editor-local-files';
const branch = `codex/local-files-proof-${Date.now()}`;
const api = (path, method = 'GET', body) => {
  const result = spawnSync('gh', ['api', path, '--method', method, ...(body ? ['--input','-'] : [])], {
    input: body ? JSON.stringify(body) : undefined, encoding:'utf8', maxBuffer: 40*1024*1024,
  });
  if (result.status !== 0) throw new Error(`GitHub ${method} ${path} failed: ${result.stderr.slice(0,400)}`);
  return JSON.parse(result.stdout);
};
const graphql = async request => api('graphql','POST',request);
const prefix = `repos/${repository}`;
const initial = api(`${prefix}/git/ref/heads/main`).object.sha;
api(`${prefix}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:initial});
const png = Buffer.from(encode({width:1,height:1,data:new Uint8Array([255,0,0,255]),channels:4}));
const contentHash = createHash('sha256').update(png).digest('hex');
const workspaceId = randomUUID();
const source = `---\ntitle: Local files proof\nmedia_subpath: /assets/posts/local-proof\nstorykit_workspace: ${workspaceId}\n---\n\n![Test image](one.png)\n\n{% include embed/image.html src="two.png" id="proof" %}\n`;
const files = ['one.png','two.png'].map(name=>({assetId:randomUUID(),path:`assets/posts/local-proof/${name}`,mime:'image/png',size:png.length,contentHash,width:1,height:1,displayName:name}));
const manifest = JSON.stringify({schemaVersion:1,workspaceId,entryPath:'_posts/2026-09-07-local-proof.md',files});
const additions = [{path:'_posts/2026-09-07-local-proof.md',contents:Buffer.from(source).toString('base64')},
  {path:`_data/storykit_workspaces/${workspaceId}.json`,contents:Buffer.from(manifest).toString('base64')},
  ...files.map(f=>({path:f.path,contents:png.toString('base64')}))];
const digest = createHash('sha256').update(JSON.stringify(additions)).digest('hex');
const operationId = randomUUID();
const input = {graphql,repository,branch,expectedHead:initial,operationId,digest,additions};
const first = await commitPackage(input);
for(const a of additions){
  const blob=api(`${prefix}/contents/${a.path}?ref=${first.oid}`);
  assert.equal(blob.content.replace(/\s/g,''),a.contents);
}
const changed = api(`${prefix}/commits/${first.oid}`);
assert.equal(changed.parents[0].sha,initial);
assert.equal(changed.files.length,4);
const competitor = await commitPackage({...input,expectedHead:first.oid,operationId:randomUUID(),additions:[{path:files[0].path,contents:Buffer.from('competing fixture bytes').toString('base64')}]});
await assert.rejects(commitPackage({...input,expectedHead:first.oid,operationId:randomUUID()}));
let lost;
await assert.rejects(commitPackage({...input,expectedHead:competitor.oid,operationId:randomUUID(),graphql:async request=>{lost=await graphql(request);throw new Error('simulated lost response');}}));
const saved=lost.data.createCommitOnBranch.commit;
const later=await commitPackage({...input,expectedHead:saved.oid,operationId:randomUUID(),additions:[{path:'proof-unrelated.txt',contents:Buffer.from('Unrelated subsequent change').toString('base64')}]});
const history=api(`${prefix}/commits?sha=${encodeURIComponent(branch)}&per_page=20`).map(c=>({oid:c.sha,message:c.commit.message}));
const marker=history.find(c=>c.oid===saved.oid).message.match(/StoryKit-Operation: ([\w-]+)/)[1];
const outcome=await reconcilePackage({history,operationId:marker,digest,currentHead:later.oid,verify:async oid=>additions.every(a=>api(`${prefix}/contents/${a.path}?ref=${oid}`).content.replace(/\s/g,'')===a.contents)});
assert.deepEqual(outcome,{state:'succeeded',commitOid:saved.oid,remoteChanged:true});
// Maximum product bytes: valid PNGs with bounded, inert ancillary padding.
function paddedPNG(target){
  const pad=Buffer.alloc(target-png.length-12),kind=Buffer.from('skIT'),chunk=Buffer.alloc(pad.length+12);chunk.writeUInt32BE(pad.length);kind.copy(chunk,4);pad.copy(chunk,8);
  let crc=0xffffffff;for(const byte of chunk.subarray(4,-4)){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
}
const maxImage=paddedPNG(4*1024*1024),maximum=[{path:'assets/posts/max-proof/one.png',contents:maxImage.toString('base64')},{path:'assets/posts/max-proof/two.png',contents:maxImage.toString('base64')}];
const maximumCommit=await commitPackage({...input,expectedHead:later.oid,operationId:randomUUID(),additions:maximum});
const tree=api(`${prefix}/git/trees/${maximumCommit.oid}?recursive=1`).tree;
for(const addition of maximum){const entry=tree.find(e=>e.path===addition.path),blob=api(`${prefix}/git/blobs/${entry.sha}`);assert.equal(blob.content.replace(/\s/g,''),addition.contents);}
api(`${prefix}/branches/${encodeURIComponent(branch)}/protection`,'PUT',{required_status_checks:null,enforce_admins:true,required_pull_request_reviews:{required_approving_review_count:1},restrictions:null});
let protectedOutcome;
try{await commitPackage({...input,expectedHead:maximumCommit.oid,operationId:randomUUID()});protectedOutcome='unexpected success';}catch{protectedOutcome='rejected';}
assert.equal(protectedOutcome,'rejected');assert.equal(api(`${prefix}/git/ref/heads/${branch}`).object.sha,maximumCommit.oid);
// Retain protection on this disposable proof branch; no existing rule is changed.
console.log(JSON.stringify({repository,branch,firstCommit:first.url,verifiedPaths:additions.map(a=>a.path),sameImageRace:'rejected',lostResponse:outcome,head:maximumCommit.oid,maximumBytes:2*maxImage.length,maximumCommit:maximumCommit.url,protectedBranch:protectedOutcome,scope:'GitHub primitive through gh; OAuth Worker validation still required'},null,2));
