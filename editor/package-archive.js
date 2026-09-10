import { zipSync, Unzip, UnzipInflate } from "fflate";
import {
  LIMITS,
  safePath,
  manifestPath,
  validateManifest,
  validateFile,
  utf8,
  canonicalJSON,
} from "./package-validation.js";
import { copyPackage } from "./workspace-copy.js";
import { docs, workspaces } from "./store.js";
export async function exportPackage(snapshot) {
  const files = Object.create(null);
  files[snapshot.manifest.entryPath] = utf8(snapshot.content);
  files[manifestPath(snapshot.manifest.workspaceId)] = utf8(
    canonicalJSON(snapshot.manifest),
  );
  for (const asset of snapshot.blobs)
    files[asset.path] = new Uint8Array(await asset.blob.arrayBuffer());
  const bytes = zipSync(files, { level: 0 });
  if (bytes.length > LIMITS.archive)
    throw new Error("Export exceeds the archive limit.");
  const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/zip" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = (snapshot.doc.title || "story") + ".storykit.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return bytes;
}
/** Validate the central directory before any decompression, including Unix file
 * modes. Stream output with hard bounds even if metadata lies about sizes. */
export async function decodePackage(blob) {
  if (!blob || blob.size > LIMITS.archive)
    throw new Error("ZIP archive must be at most 10 MiB.");
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    view = new DataView(bytes.buffer),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (view.getUint32(p, true) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error("Invalid or multi-disk ZIP.");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (!count || count > LIMITS.entries || start + size !== end)
    throw new Error("Invalid ZIP directory or entry limit exceeded.");
  const expected = new Map(),
    folded = new Set();
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50)
      throw new Error("Invalid ZIP entry.");
    const n = view.getUint16(p + 28, true),
      extra = view.getUint16(p + 30, true),
      comment = view.getUint16(p + 32, true),
      mode = (view.getUint32(p + 38, true) >>> 16) & 0xf000;
    if (mode && mode !== 0x8000)
      throw new Error("ZIP symlinks and special files are not supported.");
    if (view.getUint16(p + 8, true) & 1)
      throw new Error("Encrypted ZIP files are not supported.");
    const name = safePath(decoder.decode(bytes.subarray(p + 46, p + 46 + n)));
    if (folded.has(name.toLowerCase())) throw new Error("Duplicate ZIP path.");
    folded.add(name.toLowerCase());
    const expanded = view.getUint32(p + 24, true);
    total += expanded;
    if (total > LIMITS.expanded) throw new Error("Expanded ZIP exceeds 9 MiB.");
    expected.set(name, expanded);
    p += 46 + n + extra + comment;
  }
  if (p !== end) throw new Error("Invalid ZIP directory size.");
  const output = new Map();
  let failure = null,
    expanded = 0;
  const unzip = new Unzip((file) => {
    if (!expected.has(file.name) || output.has(file.name)) {
      failure = new Error("Unexpected or duplicate ZIP entry.");
      return;
    }
    const chunks = [];
    let size = 0;
    output.set(file.name, null);
    file.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      if (failure) return;
      size += data.length;
      expanded += data.length;
      if (size > expected.get(file.name) || expanded > LIMITS.expanded) {
        failure = new Error("ZIP expansion limit exceeded.");
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) {
        if (size !== expected.get(file.name)) {
          failure = new Error("Truncated ZIP entry.");
          return;
        }
        const result = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          result.set(c, at);
          at += c.length;
        }
        output.set(file.name, result);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 4096) {
    unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
    if (failure) throw failure;
  }
  if (output.size !== expected.size || [...output.values()].some((v) => !v))
    throw new Error("Incomplete ZIP archive.");
  const manifests = [...output.keys()].filter((p) =>
    /^_data\/storykit_workspaces\/[\w-]+\.json$/.test(p),
  );
  if (
    manifests.length !== 1 ||
    output.get(manifests[0]).length > LIMITS.manifest
  )
    throw new Error("Choose a StoryKit package with one workspace manifest.");
  const raw = JSON.parse(decoder.decode(output.get(manifests[0]))),
    source = output.get(raw.entryPath);
  if (!source || source.length > LIMITS.source)
    throw new Error("Missing or oversized Markdown entry.");
  const content = decoder.decode(source),
    manifest = validateManifest(raw, content);
  if (
    manifestPath(manifest.workspaceId) !== manifests[0] ||
    output.size !== manifest.files.length + 2
  )
    throw new Error("Archive contains unmanaged files.");
  const blobs = [];
  for (const f of manifest.files) {
    const bytes = output.get(f.path);
    if (!bytes) throw new Error(`Missing ${f.path}.`);
    const validated = await validateFile(new Blob([bytes]), f.path);
    if (
      ["mime", "size", "width", "height", "contentHash"].some(
        (k) => validated[k] !== f[k],
      )
    )
      throw new Error(`Integrity check failed for ${f.path}.`);
    blobs.push(validated);
  }
  return { content, manifest, blobs };
}
export async function importPackage(blob) {
  let snapshot = await decodePackage(blob);
  if (
    (await docs.list()).some(
      (d) =>
        d.workspaceId === snapshot.manifest.workspaceId ||
        d.path === snapshot.manifest.entryPath,
    )
  ) {
    if (
      !window.confirm(
        "This story already exists in this browser. Import a separate copy with new file destinations?",
      )
    )
      return null;
    snapshot = copyPackage(snapshot);
  }
  return workspaces.importDocument(snapshot);
}
