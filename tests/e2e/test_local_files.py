"""Integrated signed-out local workspace and preview proof."""
import struct
import zlib
import pytest
from playwright.sync_api import expect
from test_local_file_transport import RUNTIME, route_runtime
from test_preview_interactions import _route_raw


def png(color=(255, 0, 0)):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 80, 60, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + bytes(color)*80)*60)) + chunk(b'IEND', b'')


@pytest.mark.parametrize('engine', ['chromium','firefox','webkit'])
@pytest.mark.parametrize('host_enabled', [False, True])
def test_picker_persistence_insert_and_local_preview(playwright, base_url, engine, host_enabled):
    browser = getattr(playwright, engine).launch()
    page = browser.new_page()
    page.route(RUNTIME + '/**', route_runtime)
    page.route(RUNTIME + '/assets/js/storykit.js', lambda r: r.fulfill(status=200,content_type='text/javascript',body='throw new Error("Old publication runtime must not run for local files");'))
    page.route('https://raw.githubusercontent.com/**', _route_raw)
    try:
        page.goto(base_url + '/editor/index.html')
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        page.evaluate("""async () => {
          const app=await import('/editor/app.js');
          const doc=await app.modules.store.docs.create({title:'Local proof',path:'_posts/2026-09-07-local-proof.md',content:'---\\ntitle: Local proof\\nstorykit: false\\nimage:\\n  path: photo.png\\n  alt: Local cover\\n---\\n\\nA story.\\n'});
          window.localId=doc.id;await app.openDoc(doc.id);
        }""")
        if host_enabled:
            page.evaluate("async()=>{const a=await import('/editor/app.js'),s=a.modules.store,d=await s.docs.get(window.localId);await s.docs.update(d.id,{content:d.content.replace('storykit: false','storykit: true')});await a.openDoc(d.id);}")
        page.locator('#story-files-btn').click()
        page.locator('#story-files-panel input[type=file]').first.set_input_files({'name':'photo.png','mimeType':'image/png','buffer':png()})
        row=page.locator('.sk-file-row')
        try:
            expect(row).to_have_count(1, timeout=15000)
        except Exception:
            print(page.locator('body').inner_text()[-7000:])
            raise
        page.once('dialog',lambda d:d.accept('Red test image'))
        row.get_by_role('button',name='Insert',exact=True).click()
        page.locator('#story-files-panel').get_by_role('button',name='Close',exact=True).click()
        page.wait_for_function("document.querySelector('.cm-content').textContent.includes('src=\"photo.png\"')")
        page.wait_for_timeout(1800)
        page.reload()
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        page.evaluate("async()=>{const a=await import('/editor/app.js');a.setMode('preview');}")
        story=page.frame_locator('#preview-mount iframe.pv-frame')
        viewer=story.frame_locator('iframe.embed-image').first
        cover=story.get_by_role('img',name='Local cover',exact=True)
        expect(cover).to_be_visible()
        # Cover decoding changes the layout above a lazy viewer. Wait for that
        # shift before scrolling the viewer into WebKit's loading viewport.
        expect(cover).to_have_attribute('src', __import__('re').compile('^blob:'))
        assert cover.evaluate('async img=>{await img.decode();return img.naturalWidth===80;}')
        story.locator('iframe.embed-image').first.scroll_into_view_if_needed()
        viewer.locator('#wrap.is-visible').wait_for(timeout=15000)
        viewer.locator('#osd').click()
        expanded=story.frame_locator('#storykitDialog iframe')
        expanded.locator('#wrap.is-visible').wait_for(timeout=15000)
        assert story.locator('#storykitDialog iframe').get_attribute('data-sk-resource') is not None
        assert expanded.locator('canvas').count() > 0
        story.locator('#storykitDialog sl-button').click()
        expect(story.locator('#storykitDialog')).to_have_count(0)
        viewer.get_by_role('button',name='Open fullscreen').click()
        expanded.locator('#wrap.is-visible').wait_for(timeout=15000)
        story.locator('#storykitDialog sl-button').click()
        viewer.get_by_role('button',name='Open fullscreen').press('Enter')
        expanded.locator('#wrap.is-visible').wait_for(timeout=15000)
        assert 'sk_resource' in story.locator('iframe.embed-image').first.get_attribute('src')
        stored=page.evaluate("async()=>{const s=await import('/editor/store.js');return (await s.docs.list()).find(d=>d.title==='Local proof');}")
        assert len(stored['manifest']['files'])==1
        assert 'sk-local:' not in stored['content'] and 'blob:' not in stored['content']
    finally:
        browser.close()


def test_managed_save_keeps_newer_text_dirty(playwright, base_url):
    browser=playwright.chromium.launch()
    page=browser.new_page()
    saved=[]
    def api(route):
        path=route.request.url.split('/api/')[-1].split('?')[0]
        if path=='session': result={'configured':True,'user':{'id':1,'login':'fixture'},'csrf':'fixture'}
        elif path=='github/capabilities': result={'workspace':1,'localImage':1,'localData':1}
        elif path=='github/branch-head': result={'sha':'a'*40}
        elif path=='github/workspace/save':
            body=route.request.post_data_json
            saved.append(body)
            # The editor continues typing while the captured package is in flight.
            page.locator('.cm-content').press('ControlOrMeta+End')
            page.locator('.cm-content').press('Enter')
            page.locator('.cm-content').press_sequentially('Newer local edit')
            paths={body['manifest']['entryPath']:'b'*40}
            for f in body['manifest']['files']: paths[f['path']]='c'*40
            result={'commit':'d'*40,'digest':body['digest'],'paths':paths}
        else:
            route.fulfill(status=404,json={'error':{'code':'not_found','message':'Fixture does not have this path'}})
            return
        route.fulfill(json=result)
    page.route('**/api/**',api)
    page.route('https://raw.githubusercontent.com/**',_route_raw)
    page.route(RUNTIME+'/**',route_runtime)
    try:
        page.goto(base_url+'/editor/index.html')
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        page.evaluate("""async()=>{
          const app=await import('/editor/app.js'),s=app.modules.store;
          const d=await s.docs.create({title:'Race proof',path:'_posts/race.md',content:'---\\ntitle: Race proof\\n---\\nCaptured prose'});
          window.raceId=d.id;await app.openDoc(d.id);
        }""")
        page.locator('#story-files-btn').click()
        page.locator('#story-files-panel input[type=file]').first.set_input_files([{'name':'photo.png','mimeType':'image/png','buffer':png()}, {'name':'table.csv','mimeType':'text/csv','buffer':b'name,value\nLake,1\n'}, {'name':'data.json','mimeType':'application/json','buffer':b'{"name":"Lake"}'}])
        expect(page.locator('.sk-file-row')).to_have_count(3)
        page.locator('#story-files-panel').get_by_role('button',name='Close',exact=True).click()
        page.evaluate("async()=>{const s=await import('/editor/store.js');await s.docs.update(window.raceId,{github:{owner:'fixture',repo:'stories',branch:'main',sha:null}});await (await import('/editor/auth.js')).refresh();}")
        page.on('dialog',lambda d:d.accept())
        page.evaluate("""()=>{window.savePromise=import('/editor/sync.js').then(s=>s.commitDocument(window.raceId)).then(()=>{window.saveDone=true;}).catch(e=>{window.saveError=e.message;});}""")
        page.wait_for_function('window.saveDone || window.saveError',timeout=30000)
        assert page.evaluate('window.saveError || null') is None
        assert len(saved)==1 and 'Newer local edit' not in saved[0]['content']
        assert len(saved[0]['manifest']['files'])==3
        page.wait_for_timeout(1800)
        result=page.evaluate("async()=>{const s=await import('/editor/store.js'),d=await s.docs.get(window.raceId);return {doc:d,status:(await import('/editor/doclist.js')).deriveSyncStatus(d)};}")
        assert 'Newer local edit' in result['doc']['content']
        assert 'Newer local edit' not in result['doc']['github']['package']['content']
        assert result['status']!='synced'
    finally: browser.close()


def test_old_database_upgrade_waits_then_preserves_draft(playwright, base_url):
    browser=playwright.chromium.launch()
    context=browser.new_context()
    old=context.new_page()
    old.goto(base_url+'/tests/fixtures/local-files/empty.html')
    old.evaluate("""()=>new Promise(resolve=>{
      const r=indexedDB.open('storykit-editor',1);
      r.onupgradeneeded=()=>{
        const db=r.result;
        db.createObjectStore('documents',{keyPath:'id'});
        const revisions=db.createObjectStore('revisions',{keyPath:'id'});revisions.createIndex('byDoc','docId');
        db.createObjectStore('repoCache');db.createObjectStore('entityCache');
      };
      r.onsuccess=()=>{window.oldDB=r.result;const t=r.result.transaction('documents','readwrite');t.objectStore('documents').put({id:'old-draft',title:'Old draft',content:'Original prose',path:'_posts/old.md',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),github:{owner:'fixture',repo:'story',branch:'main',sha:'a'.repeat(40)}});t.oncomplete=resolve;};
    })""")
    page=context.new_page()
    page.route('https://raw.githubusercontent.com/**',_route_raw)
    try:
        page.goto(base_url+'/editor/index.html')
        expect(page.locator('#storage-upgrade-notice')).to_be_visible(timeout=15000)
        expect(page.locator('#new-doc')).to_be_disabled()
        old.close()
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        record=page.evaluate("async()=>await (await import('/editor/store.js')).docs.get('old-draft')")
        assert record['content']=='Original prose' and record['github']['repo']=='story'
    finally: browser.close()


@pytest.mark.parametrize('engine', ['chromium','firefox','webkit'])
def test_data_picker_map_layers_download_and_reload(playwright, base_url, engine, tmp_path):
    import json
    browser = getattr(playwright, engine).launch()
    page = browser.new_page()
    page.route(RUNTIME + '/**', route_runtime)
    page.route(RUNTIME + '/assets/js/storykit.js', lambda r: r.fulfill(status=200,content_type='text/javascript',body='throw new Error("Old publication runtime must not run for local files");'))
    page.route('https://raw.githubusercontent.com/**', _route_raw)
    # Basemap tiles aren't needed to prove local geometry; do not depend on tile servers.
    page.route('**/*tile.openstreetmap.org/**', lambda r: r.fulfill(status=200,content_type='image/png',body=png()))
    unexpected=[]
    page.on('request',lambda r: unexpected.append(r.url) if any(x in r.url for x in ['Lake_Superior.geojson','sk-local:','cloudinary','/api/github/asset']) else None)
    lake={'type':'FeatureCollection','features':[{'type':'Feature','properties':{'label':'Lake Superior'},'geometry':{'type':'Polygon','coordinates':[[[-92,46],[-84,46],[-84,49],[-92,49],[-92,46]]]}}]}
    files={'Lake_Superior.geojson':json.dumps(lake),'other.json':json.dumps(lake),'table.csv':'name,value\r\n"Lake, Superior",1\r\n','table.tsv':'name\tvalue\nLake\t1\n','notes.txt':'Original notes — UTF-8\n'}
    try:
        page.goto(base_url+'/editor/index.html')
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        page.evaluate(r"""async()=>{const a=await import('/editor/app.js');const d=await a.modules.store.docs.create({title:'Local data',path:'_posts/local-data.md',content:'---\ntitle: Local data\n---\n\nData story.\n'});window.dataId=d.id;await a.openDoc(d.id);}""")
        page.locator('#story-files-btn').click()
        page.locator('#story-files-panel input[type=file]').first.set_input_files([{'name':name,'mimeType':'','buffer':data.encode()} for name,data in files.items()])
        expect(page.locator('.sk-file-row')).to_have_count(5)
        page.locator('.sk-file-row').filter(has_text='Lake_Superior.geojson').get_by_role('button',name='Insert',exact=True).click()
        page.locator('.sk-file-row').filter(has_text='table.csv').get_by_role('button',name='Insert',exact=True).click()
        page.locator('#story-files-panel').get_by_role('button',name='Close',exact=True).click()
        page.wait_for_timeout(1800)
        page.evaluate("""async()=>{const a=await import('/editor/app.js'),s=a.modules.store,d=await s.docs.get(window.dataId);await s.docs.update(d.id,{content:d.content.replace('geojson="Lake_Superior.geojson"','geojson="Lake_Superior.geojson~Lake|other.json~Other"')});await a.openDoc(d.id);}""")
        page.reload()
        page.locator('#new-doc:not([disabled])').wait_for(timeout=30000)
        page.evaluate("async()=>{(await import('/editor/app.js')).setMode('preview');}")
        story=page.frame_locator('#preview-mount iframe.pv-frame')
        story.locator('iframe.embed-map').scroll_into_view_if_needed()
        viewer=story.frame_locator('iframe.embed-map')
        expect(viewer.locator('.leaflet-overlay-pane path')).to_have_count(2,timeout=30000)
        expect(viewer.locator('main')).to_be_visible()
        viewer.locator('.leaflet-overlay-pane path').first.click(force=True)
        expect(viewer.locator('.leaflet-popup')).to_contain_text('Lake Superior')
        viewer.get_by_role('button',name='Expand map',exact=True).click()
        expanded=story.frame_locator('#storykitDialog iframe')
        expect(expanded.locator('.leaflet-overlay-pane path')).to_have_count(2,timeout=30000)
        story.locator('#storykitDialog sl-button').click()
        link=story.get_by_role('link',name='table.csv',exact=True)
        expect(link).to_have_attribute('href',__import__('re').compile('^blob:'))
        with page.expect_download() as pending: link.click()
        download=pending.value
        target=tmp_path/'download.csv';download.save_as(target)
        assert target.read_bytes()==files['table.csv'].encode()
        assert not unexpected, unexpected
        stored=page.evaluate("async()=>{const s=await import('/editor/store.js');return (await s.docs.list()).find(d=>d.title==='Local data');}")
        assert len(stored['manifest']['files'])==5
        assert 'sk-local:' not in stored['content'] and 'blob:' not in stored['content']
    finally: browser.close()
