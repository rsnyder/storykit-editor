"""M0: production image viewer at a distinct origin, inside an opaque story.
No substitute image component and no change to the authenticated sandbox.
"""
from pathlib import Path
import sys
import re
import pytest
from playwright.sync_api import expect

sys.path.insert(0, str(Path(__file__).parent))
from conftest import REPO
from urllib.parse import urlparse, unquote


RUNTIME = "https://rsnyder.github.io/storykit-starter"
EDITOR_CSP = re.search(r"if \(editor\) headers.set\('Content-Security-Policy', \"([^\"]+)\"",
    (REPO / 'prototypes/github-auth/src/worker.js').read_text()).group(1)


def route_runtime(route):
    relative = unquote(urlparse(route.request.url).path).removeprefix('/storykit-starter/')
    path = REPO / relative
    if '..' in Path(relative).parts or not path.is_file():
        route.fulfill(status=404, body='Not found')
        return
    route.fulfill(path=path, headers={"Access-Control-Allow-Origin": "*"})


@pytest.mark.parametrize("engine", ["chromium", "firefox", "webkit"])
@pytest.mark.parametrize("flat", [False, True])
def test_real_nested_local_viewer(playwright, base_url, engine, flat):
    browser = getattr(playwright, engine).launch()
    context = browser.new_context()
    page = context.new_page()
    page.route(RUNTIME + '/**', route_runtime)
    page.route('**/tests/fixtures/local-files/preview.html?*', lambda route: route.fulfill(
        path=REPO / 'tests/fixtures/local-files/preview.html',
        headers={'Content-Security-Policy': EDITOR_CSP}))
    unexpected = []
    page.on("request", lambda r: unexpected.append(r.url) if any(
        marker in r.url for marker in ["cloudinary", "photo.png", "image/fetch", "api/github", "api/auth"]
    ) else None)
    try:
        page.goto(f"{base_url}/tests/fixtures/local-files/preview.html?runtime={RUNTIME}")
        page.wait_for_function("!!window.proof")
        if flat:
            page.evaluate("renderProof({flat:true})")
        story = page.frame_locator("#story")
        ordinary = story.locator("#ordinary")
        ordinary.wait_for()
        # Both consumers create URLs in their own execution contexts.
        expect(ordinary).to_have_attribute("src", re.compile("^blob:"), timeout=30000)
        assert ordinary.evaluate("async img => { await img.decode(); return img.naturalWidth; }") == 80
        viewer = story.frame_locator("#photo-viewer")
        viewer.locator("#wrap.is-visible").wait_for(timeout=45000)
        assert viewer.locator("canvas").count() >= 1
        assert page.locator("#story").get_attribute("sandbox") == "allow-scripts allow-popups allow-forms allow-modals"
        assert story.locator("body").evaluate("() => { try { return !!parent.document.body; } catch { return false; } }") is False
        expect(story.locator("#zoom")).to_have_attribute("data-href", re.compile("zoomto"))
        # A sibling with a valid resource ID is still not a registered viewer.
        generation = page.evaluate("proof.generation")
        story.locator("body").evaluate(r"""(body, generation) => {
          const f = document.createElement('iframe'); f.id = 'foreign';
          f.srcdoc = `<script>window.leaked=false;addEventListener('message',e=>{if(e.data?.kind==='sk-local-image')window.leaked=true;});parent.postMessage({kind:'sk-local-image-ready',version:1,resourceId:'photo',generation:${JSON.stringify(generation)}},'*');<\/script>`;
          body.append(f);
        }""", generation)
        foreign = story.frame_locator("#foreign")
        foreign.locator("body").wait_for(state="attached")
        assert foreign.locator("body").evaluate("async () => { await new Promise(r=>setTimeout(r,50)); return window.leaked; }") is False
        story.locator("#zoom").click()
        viewer.locator("#osd").click(position={"x": 150, "y": 100})
        expanded = story.frame_locator("#storykitDialog iframe")
        expanded.locator("#wrap.is-visible").wait_for(timeout=30000)
        assert story.locator("#storykitDialog iframe").get_attribute("data-sk-resource") == "photo"
        page.locator("#switch").click()
        story.locator("body").get_by_text("Another document has no resources").wait_for()
        assert story.locator("img").count() == 0
        assert unexpected == []
    finally:
        context.close()
        browser.close()


@pytest.mark.parametrize("engine", ["chromium", "firefox", "webkit"])
def test_resource_assignment_rejects_spoofing(playwright, base_url, engine):
    browser = getattr(playwright, engine).launch()
    page = browser.new_page()
    try:
        page.goto(base_url + "/tests/fixtures/local-files/empty.html")
        result = page.evaluate("""async () => {
          const { attachPreviewResources } = await import('/editor/preview-resources.js');
          const host = new EventTarget(), sent = [];
          const target = { postMessage: data => sent.push(data) };
          const frame = { contentWindow: target };
          const resource = { resourceId:'known', mime:'image/png', contentHash:'a'.repeat(64), blob:new Blob(['image']) };
          const release = attachPreviewResources({frame, host, generation:'current', resources:[resource]});
          function request({source=target,origin='null',generation='current',resourceId='known',version=1}={}) {
            const e = new Event('message');
            Object.assign(e,{source,origin,data:{kind:'sk-preview-resource-ready',version,generation,resourceId}});
            host.dispatchEvent(e);
          }
          request({source:{}}); request({origin:'https://evil.example'});
          request({generation:'previous-document'}); request({resourceId:'another-workspace'}); request({version:2});
          await new Promise(r => setTimeout(r,20));
          const denied = sent.length === 0;
          request(); request();
          await new Promise(r => setTimeout(r,20));
          const once = sent.length === 1 && new TextDecoder().decode(sent[0].bytes) === 'image';
          release(); request();
          let oversize = false;
          try { attachPreviewResources({frame,host,generation:'current',resources:[{...resource,blob:new Blob([new Uint8Array(5*1024*1024+1)])}]}); }
          catch { oversize = true; }
          return {denied,once,oversize,disposed:sent.length===1};
        }""")
        assert result == dict(denied=True, once=True, oversize=True, disposed=True)
    finally:
        browser.close()


@pytest.mark.parametrize("engine", ["chromium", "firefox", "webkit"])
def test_consumer_rejects_bad_messages_then_verifies_bytes(playwright, base_url, engine):
    browser = getattr(playwright, engine).launch()
    page = browser.new_page()
    page.route('**/assets/js/storykit-local-image.js', lambda r: r.fulfill(
        path=REPO / 'assets/js/storykit-local-image.js', headers={'Access-Control-Allow-Origin': '*'}))
    try:
        page.goto(base_url + '/tests/fixtures/local-files/empty.html')
        result = page.evaluate(r"""async () => {
          const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
          const outcome = new Promise(resolve => addEventListener('message', e => {
            if(e.source===frame.contentWindow && e.data?.testResult) resolve(e.data.testResult);
          }));
          frame.srcdoc = `<script type="module">
            import {receiveLocalImage} from '${location.origin}/assets/js/storykit-local-image.js';
            try {
              const resource = await receiveLocalImage({resourceId:'photo',generation:'current',timeoutMs:3000});
              const bytes = await (await fetch(resource.url)).text(); resource.revoke();
              parent.postMessage({testResult:{ok:true,bytes}},'*');
            } catch(error) { parent.postMessage({testResult:{ok:false,error:error.message}},'*'); }
          <\/script>`;
          const ready = new Promise(resolve => addEventListener('message', e => {
            if(e.source===frame.contentWindow && e.data?.kind==='sk-local-image-ready') resolve();
          }));
          document.body.append(frame); await ready;
          const bytes = new TextEncoder().encode('assigned bytes').buffer;
          const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
          const data = {kind:'sk-local-image',version:1,resourceId:'photo',generation:'current',mime:'image/png',bytes,contentHash};
          for(const patch of [{version:2},{resourceId:'other'},{generation:'stale'},
            {mime:'image/svg+xml'},{bytes:'not binary'},{bytes:new ArrayBuffer(5*1024*1024+1)}]) {
            frame.contentWindow.postMessage({...data,...patch},'*');
          }
          frame.contentWindow.postMessage(data,'*');
          return outcome;
        }""")
        assert result == {'ok': True, 'bytes': 'assigned bytes'}
    finally:
        browser.close()
