/** Opaque-preview transport. Only an explicit, immutable resource assignment
 * can cross this boundary. A preview cannot request a repository path. */
import { FILE_TYPES } from "./package-validation.js";
export const RESOURCE_PROTOCOL = 1;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;

export function attachPreviewResources({ frame, generation, resources, host = window }) {
  if (!/^[\w-]{1,100}$/.test(generation)) throw new Error('Invalid preview generation.');
  const assigned = new Map(); let total = 0;
  for (const resource of resources) {
    if (!/^[\w-]{1,100}$/.test(resource.resourceId) || assigned.has(resource.resourceId) ||
        !(resource.blob instanceof Blob) || resource.blob.size > MAX_FILE ||
        !Object.hasOwn(FILE_TYPES, resource.mime) ||
        !/^[a-f0-9]{64}$/.test(resource.contentHash)) throw new Error('Invalid preview resource.');
    total += resource.blob.size;
    assigned.set(resource.resourceId, { ...resource });
  }
  if (assigned.size > 50 || total > MAX_TOTAL) throw new Error('Preview resource limit exceeded.');
  let disposed = false;
  const sent = new Set();
  async function receive(event) {
    const data = event.data;
    if (disposed || event.source !== frame.contentWindow || event.origin !== 'null' ||
        data?.kind !== 'sk-preview-resource-ready' || data.version !== RESOURCE_PROTOCOL ||
        data.generation !== generation || !assigned.has(data.resourceId) || sent.has(data.resourceId)) return;
    sent.add(data.resourceId);
    const resource = assigned.get(data.resourceId);
    const bytes = await resource.blob.arrayBuffer();
    if (disposed) return;
    frame.contentWindow.postMessage({ kind: 'sk-preview-resource', version: RESOURCE_PROTOCOL,
      generation, resourceId: resource.resourceId, contentHash: resource.contentHash,
      mime: resource.mime, bytes }, '*', [bytes]);
  }
  host.addEventListener('message', receive);
  return () => { disposed = true; assigned.clear(); sent.clear(); host.removeEventListener('message', receive); };
}

/** Serialized into the opaque story frame before consumers load. `assignments`
 * is renderer-produced metadata, never a URL-suffix ownership heuristic.
 * Images carry data-sk-resource; viewer frames carry sk_resource/sk_generation.
 * The viewer URL is exact (query parameters for zoom/caption may vary).
 */
export function previewResourceScript({ generation, assignments, viewerURL, mapURL }) {
  if (!/^[\w-]{1,100}$/.test(generation)) throw new Error('Invalid preview generation.');
  const config = JSON.stringify({ generation, assignments, viewerURL, mapURL }).replace(/</g, '\\u003c');
  return `<script>(${resourceBroker.toString()})(${config});<\/script>`;
}

function resourceBroker({ generation, assignments, viewerURL, mapURL }) {
  const expected = new Map(assignments.map(a => [a.resourceId, a]));
  const bytes = new Map(), urls = new Map(), viewers = new Map();
  const runtime = new URL(viewerURL);
  // Static hosting may redirect image.html to image. Expanded viewers use
  // their final location, so recognize that exact alias on the same origin.
  const mapRuntime = mapURL ? new URL(mapURL) : null;
  const runtimePaths = new Set([runtime.pathname, runtime.pathname.replace(/\.html$/, '')]);
  function register() {
    for (const [target, viewer] of viewers) {
      if (!viewer.frame.isConnected || viewer.frame.contentWindow !== target) { clearTimeout(viewer.timer); viewer.notice?.remove(); viewers.delete(target); }
    }
    for (const frame of document.querySelectorAll('iframe[data-sk-resource]')) {
      const resourceId = frame.dataset.skResource;
      if (!expected.has(resourceId)) continue;
      const url = new URL(frame.src, location.href);
      const isMap = mapRuntime && url.origin === mapRuntime.origin && [mapRuntime.pathname, mapRuntime.pathname.replace(/\.html$/, '')].includes(url.pathname);
      if ((!isMap && (url.origin !== runtime.origin || !runtimePaths.has(url.pathname))) ||
          url.searchParams.get('sk_resource') !== resourceId ||
          url.searchParams.get('sk_generation') !== generation) continue;
      if (viewers.has(frame.contentWindow)) continue;
      let resourceIds = [resourceId];
      if (isMap) {try {resourceIds = JSON.parse(url.searchParams.get('sk_resources'));} catch {continue;}}
      if (!Array.isArray(resourceIds) || resourceIds.length > 50 || !resourceIds.includes(resourceId) ||
          resourceIds.some(id => !expected.has(id) || (isMap && !['application/json','application/geo+json'].includes(expected.get(id).mime)))) continue;
      const viewer = { frame, resourceId, resourceIds, ready: false };
      viewer.timer = setTimeout(() => {
        if (viewer.ready || !frame.isConnected) return;
        const notice = document.createElement('p');
        notice.setAttribute('role', 'status');
        notice.textContent = 'This viewer needs a runtime update to preview local files. Your files are saved in this browser; package export remains available.';
        frame.after(notice); viewer.notice = notice;
      }, 10000);
      viewers.set(frame.contentWindow, viewer);
    }
  }
  function deliver(target, resourceId) {
    const value = bytes.get(resourceId);
    if (value) target.postMessage({ kind: 'sk-local-image', version: 1, generation, resourceId, ...value }, '*');
  }
  addEventListener('message', event => {
    const data = event.data;
    if (!data || data.version !== 1 || data.generation !== generation || !expected.has(data.resourceId)) return;
    if (event.source === parent && data.kind === 'sk-preview-resource') {
      const assignment = expected.get(data.resourceId);
      if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength !== assignment.size ||
          data.bytes.byteLength > 5 * 1024 * 1024 || data.mime !== assignment.mime ||
          data.contentHash !== assignment.contentHash || bytes.has(data.resourceId)) return;
      bytes.set(data.resourceId, { bytes: data.bytes, mime: data.mime, contentHash: data.contentHash });
      const url = URL.createObjectURL(new Blob([data.bytes], { type: data.mime }));
      urls.set(data.resourceId, url);
      for (const link of document.querySelectorAll('a[data-sk-resource]')) if (link.dataset.skResource === data.resourceId) link.href = url;
      for (const img of document.querySelectorAll('img[data-sk-resource]')) {
        if (img.dataset.skResource === data.resourceId) { img.src = url; const link = img.closest('a'); if (link?.getAttribute('href')?.startsWith('sk-local:')) link.href = url; }
      }
      for (const [target, viewer] of viewers) {
        if (viewer.frame.isConnected && viewer.resourceIds.includes(data.resourceId)) deliver(target, data.resourceId);
      }
    } else if (data.kind === 'sk-local-image-ready') {
      register();
      const viewer = viewers.get(event.source);
      if (!viewer || !viewer.frame.isConnected || !viewer.resourceIds.includes(data.resourceId) ||
          (event.origin !== 'null' && event.origin !== new URL(viewer.frame.src).origin)) return;
      viewer.ready = true; clearTimeout(viewer.timer); viewer.notice?.remove();
      deliver(event.source, data.resourceId);
    }
  });
  const observer = new MutationObserver(register);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('DOMContentLoaded', () => {
    register();
    for (const resourceId of expected.keys()) parent.postMessage({
      kind: 'sk-preview-resource-ready', version: 1, generation, resourceId,
    }, '*');
  }, { once: true });
  addEventListener('pagehide', () => {
    observer.disconnect();
    for (const viewer of viewers.values()) clearTimeout(viewer.timer);
    for (const url of urls.values()) URL.revokeObjectURL(url);
    bytes.clear(); urls.clear(); viewers.clear();
  }, { once: true });
}
