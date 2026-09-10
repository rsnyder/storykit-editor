import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness,FakeGitHub } from './support.mjs';
import { packageDigest,imageInfo,sha256 } from '../../../editor/package-validation.js';
import { boundedPNG } from '../src/png-validation.js';
import { decode,encode } from 'fast-png';
const bytes=Buffer.from(encode({width:1,height:1,data:new Uint8Array([255,0,0]),channels:3}));
const oid=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
class Packages extends FakeGitHub {
  constructor(){super();this.head='a'.repeat(40);this.snapshots=new Map([[this.head,new Map()]]);this.blobs=new Map();this.trees=new Map();this.history=[];this.commits=0;}
  treesFor(files){const root={};for(const [path,bytes] of files){const parts=path.split('/');let dir=root;for(const p of parts.slice(0,-1))dir=dir[p]??={};dir[parts.at(-1)]=bytes;}
    const make=dir=>{const tree=Object.entries(dir).map(([path,value])=>{if(Buffer.isBuffer(value)){const sha=oid(value);this.blobs.set(sha,value);return {path,sha,size:value.length,type:'blob',mode:'100644'};}return {path,sha:make(value),type:'tree',mode:'040000'};});const sha=createHash('sha1').update(JSON.stringify(tree)).digest('hex');this.trees.set(sha,tree);return sha;};return make(root);}
  async fetch(input,options={}){
    const url=new URL(input),json=Response.json;
    if(url.pathname==='/graphql'){
      const data=JSON.parse(options.body).variables.input;
      if(this.reject)return json({errors:[{type:'FORBIDDEN',path:['createCommitOnBranch']}]});
      if(data.expectedHeadOid!==this.head)return json({errors:[{type:'STALE_DATA',path:['createCommitOnBranch']}]});
      const files=new Map(this.snapshots.get(this.head));for(const f of data.fileChanges.additions)files.set(f.path,Buffer.from(f.contents,'base64'));
      this.head=createHash('sha1').update(String(++this.commits)).digest('hex');this.snapshots.set(this.head,files);this.history.unshift({sha:this.head,commit:{message:data.message.headline+'\n\n'+data.message.body}});
      if(this.lose){this.lose=false;throw new Error('Lost response');}
      return json({data:{createCommitOnBranch:{commit:{oid:this.head}}}});
    }
    if(url.pathname.endsWith('/branches/main'))return json({commit:{sha:this.head}});
    if(url.pathname.endsWith('/commits'))return json(this.history);
    if(url.pathname.includes('/git/trees/')){let sha=url.pathname.split('/').pop();if(this.snapshots.has(sha))sha=this.treesFor(this.snapshots.get(sha));return json({tree:this.trees.get(sha),truncated:false});}
    if(url.pathname.includes('/git/blobs/')){const data=this.blobs.get(url.pathname.split('/').pop());return json({encoding:'base64',size:data.length,content:data.toString('base64')});}
    return super.fetch(input,options);
  }
}
async function setup(){const upstream=new Packages();const h=harness(undefined,upstream.fetch.bind(upstream),{decode:async b=>{const info=imageInfo(b);decode(boundedPNG(b,info.width,info.height));return {...info,contentHash:await sha256(b)};}});const {session}=await h.login();
  const content='---\nmedia_subpath: /assets/posts/proof\nstorykit_workspace: proof\n---\n\n![Red](red.png)\n';
  const manifest={schemaVersion:1,workspaceId:'proof',entryPath:'_posts/proof.md',files:[{...imageInfo(bytes),assetId:'red',path:'assets/posts/proof/red.png',displayName:'red.png',contentHash:await sha256(bytes)}]};
  const input={owner:'demo-author',repo:'field-notes',branch:'main',content,manifest,digest:await packageDigest(content,manifest),operationId:crypto.randomUUID(),expectedHead:upstream.head,baseline:{},assets:[{path:manifest.files[0].path,contents:bytes.toString('base64')}]};
  const save=body=>h.request('/api/github/workspace/save',{method:'POST',headers:{'X-CSRF-Token':session.csrf},body});return {h,upstream,input,save};}
test('authenticated atomic package save, no change, pinned read, asset ownership',async()=>{const {h,upstream,input,save}=await setup();let r=await save(input);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const saved=await r.json();assert.equal(upstream.commits,1);assert.equal(upstream.snapshots.get(saved.commit).size,3);
  r=await save({...input,operationId:crypto.randomUUID(),expectedHead:saved.commit,baseline:saved.paths});assert.equal(r.status,200);assert.equal(upstream.commits,1);
  const query='owner=demo-author&repo=field-notes&branch=main&path=_posts/proof.md';r=await h.request('/api/github/workspace?'+query);assert.equal(r.status,200);assert.deepEqual((await r.json()).manifest,input.manifest);
  r=await h.request('/api/github/asset?'+query+'&entryPath=_posts/proof.md');assert.equal(r.status,403);
  r=await h.request('/api/github/asset?owner=demo-author&repo=field-notes&branch=main&entryPath=_posts/proof.md&path=assets/posts/proof/red.png');assert.equal(r.status,200);assert.equal((await r.json()).contents,bytes.toString('base64'));
});
test('lost package response reconciles and never duplicates commit',async()=>{const {h,upstream,input,save}=await setup();upstream.lose=true;assert.equal((await save(input)).status,502);const r=await h.request('/api/github/workspace/operations/'+input.operationId);assert.equal(r.status,200);assert.equal((await r.json()).commit,upstream.head);assert.equal((await save(input)).status,200);assert.equal(upstream.commits,1);});
test('protected branch rejection is durable and not uncertain',async()=>{const {h,upstream,input,save}=await setup();upstream.reject=true;assert.equal((await save(input)).status,403);const r=await h.request('/api/github/workspace/operations/'+input.operationId);assert.equal((await r.json()).error.code,'operation_rejected');assert.equal(upstream.commits,0);});
test('malformed paths, corrupt bytes, unauthenticated save and stale baseline cannot write',async()=>{const {h,upstream,input,save}=await setup();assert.equal((await h.request('/api/github/workspace/save',{method:'POST',body:input,cookies:false})).status,401);
  assert.equal((await save({...input,manifest:{...input.manifest,entryPath:'../escape.md'}})).status,400);
  assert.equal((await save({...input,assets:[{path:input.assets[0].path,contents:'AAAA'}]})).status,400);
  const first=await (await save(input)).json();assert.equal((await save({...input,operationId:crypto.randomUUID(),expectedHead:first.commit})).status,409);assert.equal(upstream.commits,1);
});
test('legacy Markdown save cannot detach a managed workspace',async()=>{const {h,upstream,input}=await setup();upstream.setFile('demo-author','field-notes','main','_posts/proof.md',input.content);const {session}=await h.login();const r=await h.request('/api/github/save',{method:'POST',headers:{'X-CSRF-Token':session.csrf},body:{...input,path:'_posts/proof.md',expectedSha:'a'.repeat(40),content:'overwritten'}});assert.equal((await r.json()).error.code,'workspace_required');});

test('capabilities are discoverable without a session',async()=>{const h=harness();assert.deepEqual(await (await h.request('/api/github/capabilities')).json(),{workspace:1,localImage:1,localData:1});});

test('data package save and pinned asset reads preserve exact bytes for every new format', async () => {
  const {h, upstream, input, save} = await setup();
  const samples = {'data.json':'{"name":"River"}\n', 'lake.geojson':'{"type":"FeatureCollection","features":[]}',
    'table.csv':'name,value\r\n"River, lake",2\r\n', 'table.tsv':'name\tvalue\nRiver\t2\n', 'notes.txt':'Notes — original bytes\n', 'empty.txt':''};
  const {dataInfo} = await import('../../../editor/package-validation.js');
  for (const [name,text] of Object.entries(samples)) {
    const bytes = Buffer.from(text), path = 'assets/posts/proof/' + name;
    input.manifest.files.push({...dataInfo(bytes,path),path,assetId:name.replace('.','-'),displayName:name,contentHash:await sha256(bytes)});
    input.assets.push({path, contents:bytes.toString('base64')});
  }
  input.manifest.files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  input.digest = await packageDigest(input.content,input.manifest);
  const response = await save(input);
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  assert.equal(upstream.commits,1);
  for (const [name,text] of Object.entries(samples)) {
    const response = await h.request('/api/github/asset?owner=demo-author&repo=field-notes&branch=main&entryPath=_posts/proof.md&path=assets/posts/proof/'+name);
    assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    assert.equal((await response.json()).contents,Buffer.from(text).toString('base64'));
  }
});

test('server rejects invalid data content before any remote mutation', async () => {
  for (const [name,body] of [['broken.json','{'],['lake.geojson','{"type":"Point","coordinates":["bad",1]}'],['notes.txt','binary\0data']]) {
    const {input,save,upstream} = await setup();
    const {fileMime} = await import('../../../editor/package-validation.js');
    const bytes = Buffer.from(body), path='assets/posts/proof/'+name;
    input.manifest.files=[{path,assetId:'data',displayName:name,mime:fileMime(name),size:bytes.length,contentHash:await sha256(bytes)}];
    input.assets=[{path,contents:bytes.toString('base64')}];
    input.digest=await packageDigest(input.content,input.manifest);
    assert.equal((await save(input)).status,400);assert.equal(upstream.commits,0);
  }
});
