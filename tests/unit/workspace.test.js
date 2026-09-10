import { docs,revisions,workspaces } from '../../editor/store.js';
import { prepareFiles,addFiles,capturePackage,restorePackage } from '../../editor/workspace.js';
import { scanReferences, localPreviewSource, replaceDestinations } from '../../editor/file-references.js';
import { validateManifest,postDirectory,safePath } from '../../editor/package-validation.js';
import { decodePackage,exportPackage } from '../../editor/package-archive.js';
import { copyPackage } from '../../editor/workspace-copy.js';
import { zipSync,unzipSync } from 'fflate';
async function image(color='red') {const c=document.createElement('canvas');c.width=4;c.height=3;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,4,3);return new File([await new Promise(r=>c.toBlob(r))],'photo.png',{type:'image/png'});}
async function story(){return docs.create({path:'_posts/2026-09-07-river.md',content:'---\ntitle: River\n---\n\nText\n'});}
describe('local workspaces',()=>{
  it('tracks literal cover paths without rewriting comments, alt text or unrelated YAML',()=>{
    const manifest={files:[{path:'assets/posts/river/Macaws.jpg'}]};
    for(const image of ['image:\n  path: Macaws.jpg # retain comment\n  alt: Macaws.jpg', "image: {path: 'Macaws.jpg', alt: Birds}", 'image: "Macaws.jpg"']) {
      const source='---\nmedia_subpath: /assets/posts/river\n'+image+'\nother:\n  path: Macaws.jpg\n---\nMacaws.jpg in prose';
      const refs=scanReferences(source,manifest);
      assert.equal(refs.length,1);assert.equal(refs[0].kind,'cover');assert.equal(refs[0].state,'Managed');
      const preview=localPreviewSource(source,manifest,'cover');
      assert.equal(preview.assigned.length,1);assert.ok(preview.content.includes('"sk-local:file_0"'));
      assert.ok(preview.content.includes('other:\n  path: Macaws.jpg'));
      assert.ok(preview.content.endsWith('Macaws.jpg in prose'));
      if(image.includes('#'))assert.ok(preview.content.includes('# retain comment\n  alt: Macaws.jpg'));
      const copy=replaceDestinations(source,refs,()=>'/assets/posts/copy/Macaws.jpg');
      assert.ok(copy.includes('"/assets/posts/copy/Macaws.jpg"'));
    }
    const alias='---\nfile: &cover Macaws.jpg\nimage:\n  path: *cover\n---\n';
    assert.equal(scanReferences(alias,manifest)[0].state,'Not checked');
    const external='---\nimage:\n  path: https://example.com/Macaws.jpg\n---\n';
    assert.equal(scanReferences(external,manifest)[0].state,'External');
    assert.equal(scanReferences('---\nimage:\n  path:\n---\n',manifest).length,0);
  });

  it('imports immutable bytes, image-only replacement changes digest, and restore recovers bytes',async()=>{
    const doc=await story(),red=(await prepareFiles([await image()])).valid;
    const first=await addFiles(doc.id,red),before=await capturePackage(doc.id);
    assert.equal(first.doc.manifest.files[0].path,'assets/posts/river/photo.png');
    assert.ok(first.doc.content.includes('/assets/posts/river'));
    const blue=(await prepareFiles([await image('blue')])).valid;
    await addFiles(doc.id,blue,{replacePath:first.added[0].path});
    const after=await capturePackage(doc.id);assert.ok(before.digest!==after.digest);
    const prior=(await revisions.list(doc.id)).find(r=>r.manifest?.files[0]?.contentHash===red[0].contentHash);
    await restorePackage(doc.id,prior,after.content);
    const restored=await capturePackage(doc.id);assert.equal(restored.manifest.files[0].contentHash,red[0].contentHash);
    await docs.remove(doc.id);
  });
  it('rejects stale package mutations atomically and retains pending operation bytes during GC',async()=>{
    const doc=await story(),prepared=(await prepareFiles([await image()])).valid;
    const {doc:saved}=await addFiles(doc.id,prepared);
    await assert.rejects(workspaces.mutate(doc.id,{expectedVersion:0,content:'wrong',manifest:saved.manifest}),/changed/);
    assert.equal((await docs.get(doc.id)).content,saved.content);
    const op={id:crypto.randomUUID(),docId:doc.id,manifest:saved.manifest,state:'uncertain'};await workspaces.operation(op);
    await docs.remove(doc.id);await workspaces.collect();assert.ok(await workspaces.bytes(prepared[0].contentHash));
  });
  it('ZIP roundtrip preserves source and bytes and rejects traversal',async()=>{
    const doc=await story();await addFiles(doc.id,(await prepareFiles([await image()])).valid);
    const snapshot=await capturePackage(doc.id);const bytes=await exportPackage(snapshot);
    const restored=await decodePackage(new Blob([bytes]));assert.equal(restored.content,snapshot.content);assert.deepEqual(restored.manifest,snapshot.manifest);
    await assert.rejects(decodePackage(new Blob([zipSync({'../escape.png':new Uint8Array([1])})])),/Unsafe/);
    await docs.remove(doc.id);
  });
  it('indexes inline, reference Markdown and viewer literals, excluding code and dynamic references',()=>{
    const content='---\nmedia_subpath: /assets/posts/river\n---\n![Alt](photo.png)\n\n![Second][ref]\n\n[ref]: photo.png\n\n{% include embed/image.html src="photo.png" %}\n\n`![Code](ignore.png)`\n\n{% include embed/image.html src=page.image %}';
    const refs=scanReferences(content,{files:[{path:'assets/posts/river/photo.png'}]});
    assert.equal(refs.filter(r=>r.state==='Managed').length,3);assert.ok(!refs.some(r=>r.value==='ignore.png'));assert.equal(refs.at(-1).state,'Not checked');
  });
  it('rejects ZIP symlinks, excess entries and lying expansion sizes before adoption',async()=>{
    const link=zipSync({'link.png':new Uint8Array([1])});const view=new DataView(link.buffer);let central=0;while(view.getUint32(central,true)!==0x02014b50)central++;
    view.setUint32(central+38,(0xa1ff<<16)>>>0,true);
    await assert.rejects(decodePackage(new Blob([link])),/symlinks/);
    const many=Object.fromEntries(Array.from({length:65},(_,i)=>['file'+i,new Uint8Array()]));
    await assert.rejects(decodePackage(new Blob([zipSync(many)])),/entry limit/);
    const bomb=zipSync({'bomb.png':new Uint8Array(10*1024*1024)},{level:9}),bv=new DataView(bomb.buffer);let c=0;while(bv.getUint32(c,true)!==0x02014b50)c++;bv.setUint32(c+24,1,true);
    await assert.rejects(decodePackage(new Blob([bomb])),/expansion limit/);
  });
  it('rejects valid image bytes with the wrong package hash and unsupported manifests',async()=>{
    const doc=await story();await addFiles(doc.id,(await prepareFiles([await image()])).valid);const snap=await capturePackage(doc.id);
    const entries=unzipSync(await exportPackage(snap));entries[snap.manifest.files[0].path]=new Uint8Array(await (await image('blue')).arrayBuffer());
    await assert.rejects(decodePackage(new Blob([zipSync(entries)])),/Integrity/);
    const path=Object.keys(entries).find(p=>p.startsWith('_data/'));const m=JSON.parse(new TextDecoder().decode(entries[path]));m.schemaVersion=99;entries[path]=new TextEncoder().encode(JSON.stringify(m));
    await assert.rejects(decodePackage(new Blob([zipSync(entries)])),/Unsupported/);await docs.remove(doc.id);
  });
  it('copies workspace identity and owned destinations without rewriting prose or external links',async()=>{
    const doc=await story();const first=await addFiles(doc.id,(await prepareFiles([await image()])).valid);
    await docs.update(doc.id,{content:first.doc.content+'\n![Red](photo.png)\nPhoto filename in prose: photo.png'});
    const snapshot=await capturePackage(doc.id),copy=copyPackage(snapshot);
    assert.ok(copy.manifest.workspaceId!==snapshot.manifest.workspaceId);
    assert.ok(copy.manifest.entryPath!==snapshot.manifest.entryPath);
    assert.ok(copy.manifest.files[0].path!==snapshot.manifest.files[0].path);
    assert.ok(copy.content.includes('Photo filename in prose: photo.png'));
    const duplicate=await docs.duplicate(doc.id);assert.equal(duplicate.github,null);
    assert.equal(duplicate.manifest.files[0].contentHash,snapshot.manifest.files[0].contentHash);
    await docs.remove(doc.id);await docs.remove(duplicate.id);
  });
  it('unknown repository assets remain not verified, and captions are recognized',()=>{
    const source='---\nmedia_subpath: /assets/img\n---\n![Unknown](remote.png)\n{% include embed/image.html src="photo.png" caption="Description" %}';
    const refs=scanReferences(source,{files:[{path:'assets/img/photo.png'}]});assert.equal(refs[0].state,'Not verified');assert.equal(refs[1].alt,'Description');
  });
  it('text compare-and-swap refuses stale tab writes without touching the package',async()=>{
    const doc=await story();await docs.update(doc.id,{content:'Newer'});
    await assert.rejects(docs.update(doc.id,{content:'Stale'},{expectedContent:doc.content}),/another tab/);
    assert.equal((await docs.get(doc.id)).content,'Newer');await docs.remove(doc.id);
  });
  it('preserves filename conventions and rejects unsafe paths',()=>{assert.equal(postDirectory('_posts/2026-01-10-monument-valley.md'),'/assets/posts/monument-valley');for(const p of ['../a','assets/%2e%2e/a','/Users/a','assets/a\\b'])assert.throws(()=>safePath(p));});
});

describe('local data files',()=>{
  it('preserves every supported format through storage, archive, copy and replacement',async()=>{
    const samples={'lake.geojson':'{"type":"FeatureCollection","features":[]}', 'data.json':'{"answer":42}\n',
      'table.csv':'name,value\r\n"River, lake",2\r\n','table.tsv':'name\tvalue\nRiver\t2\n','notes.txt':'Notes — original\n','empty.txt':''};
    const prepared=await prepareFiles(Object.entries(samples).map(([name,bytes])=>new File([bytes],name)));
    assert.equal(prepared.invalid.length,0);assert.equal(prepared.valid.length,6);
    const doc=await story();await addFiles(doc.id,prepared.valid);
    let snapshot=await capturePackage(doc.id);
    assert.ok(snapshot.manifest.files.every(f=>!Object.hasOwn(f,'width')));
    const archived=await decodePackage(new Blob([await exportPackage(snapshot)]));
    assert.equal(archived.manifest.files.length,6);
    for (const f of archived.manifest.files) assert.equal(await archived.blobs.find(b=>b.contentHash===f.contentHash).blob.text(),samples[f.displayName]);
    const replacement=(await prepareFiles([new File(['changed'],'notes.txt')])).valid;
    await addFiles(doc.id,replacement,{replacePath:'assets/posts/river/notes.txt'});
    assert.ok((await capturePackage(doc.id)).digest!==snapshot.digest);
    await docs.remove(doc.id);
  });
  it('rejects invalid encodings, binary data, invalid JSON and invalid GeoJSON',async()=>{
    const invalid=[new File(['{'],'bad.json'),new File(['{"type":"constructor"}'],'bad.geojson'),new File([new Uint8Array([255])],'bad.txt'),new File(['a\0b'],'bad.csv'),
      new File(['{"type":"Point","coordinates":["x",2]}'],'bad.geojson'),new File(['<svg/>'],'bad.svg'),
      new File(['['.repeat(66)+'0'+']'.repeat(66)],'deep.json')];
    const result=await prepareFiles(invalid);assert.equal(result.valid.length,0);assert.equal(result.invalid.length,invalid.length);
    const okay=await prepareFiles([new File(['{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}'],'lake.geojson')]);
    assert.equal(okay.valid.length,1);
  });
  it('tracks individual map layers and links without changing labels, external layers or code',()=>{
    const content='---\nmedia_subpath: /assets/posts/river\n---\n'+
      '{% include embed/map.html geojson="lake.geojson~Lake | https://example.com/river.json~River | other.json~Other" %}\n'+
      '[Data](/assets/posts/river/table.csv)\n`{% include embed/map.html geojson="ignored.geojson" %}`';
    const files=[['lake.geojson','application/geo+json'],['other.json','application/json'],['table.csv','text/csv']].map(([name,mime])=>({path:'assets/posts/river/'+name,mime}));
    const refs=scanReferences(content,{files});assert.equal(refs.filter(r=>r.state==='Managed').length,3);
    const result=localPreviewSource(content,{files},'data');assert.equal(result.assigned.length,3);
    assert.ok(result.content.includes('~Lake | https://example.com/river.json~River | sk-local:'));
    assert.ok(result.content.includes('ignored.geojson'));assert.ok(result.content.includes('[Data](sk-local:'));
  });
});

describe('portable data link syntax',()=>{
  it('tracks and copies a literal relative_url link while leaving dynamic Liquid alone',()=>{
    const content='---\nmedia_subpath: /assets/posts/river\n---\n[Data](<{{ "/assets/posts/river/table.csv" | relative_url }}>)\n[Dynamic](<{{ page.file | relative_url }}>)';
    const manifest={files:[{path:'assets/posts/river/table.csv',mime:'text/csv'}]};
    const refs=scanReferences(content,manifest);assert.equal(refs.filter(r=>r.state==='Managed').length,1);
    const preview=localPreviewSource(content,manifest,'links');assert.ok(preview.content.includes('[Data](<sk-local:file_0>)'));
    const copy=replaceDestinations(content,refs,r=>r.file?'/assets/posts/copy/table.csv':undefined);
    assert.ok(copy.includes('{{ "/assets/posts/copy/table.csv" | relative_url }}'));
    assert.ok(copy.includes('{{ page.file | relative_url }}'));
  });
});
