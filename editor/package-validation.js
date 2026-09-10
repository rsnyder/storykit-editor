/** Shared browser/Worker contracts. No storage or network authority. */
export const LIMITS = Object.freeze({
  source: 200000,
  file: 5 * 1024 * 1024,
  total: 8 * 1024 * 1024,
  count: 50,
  pixels: 4000000,
  request: 12 * 1024 * 1024,
  archive: 10 * 1024 * 1024,
  expanded: 9 * 1024 * 1024,
  entries: 64,
  manifest: 256 * 1024,
});
export const FILE_TYPES = Object.freeze({
  "image/png": /\.png$/i, "image/jpeg": /\.jpe?g$/i, "image/webp": /\.webp$/i,
  "application/json": /\.json$/i, "application/geo+json": /\.geojson$/i,
  "text/csv": /\.csv$/i, "text/tab-separated-values": /\.tsv$/i,
  "text/plain": /\.txt$/i,
});
export const isImage = mime => mime?.startsWith('image/');
export const fileMime = path => Object.entries(FILE_TYPES).find(([, pattern]) => pattern.test(path))?.[0];

/** Data files remain inert UTF-8 bytes; they are never interpreted as HTML or code. */
export function dataInfo(bytes, path) {
  const mime = fileMime(path);
  if (!mime || isImage(mime)) throw new Error('Unsupported data file extension.');
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.file)
    throw new Error('Files must be at most 5 MiB.');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new Error('Data and text files must use UTF-8 encoding.'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new Error('Data and text files cannot contain binary control characters.');
  if (mime === 'application/json' || mime === 'application/geo+json') {
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('Invalid JSON.'); }
    // Bound traversal depth and work before any viewer consumes nested data.
    const stack = [[value, 0]]; let nodes = 0;
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (++nodes > 500000 || depth > 64) throw new Error('JSON is too deeply nested or complex.');
      if (typeof node === 'number' && !Number.isFinite(node)) throw new Error('JSON numbers must be finite.');
      if (node && typeof node === 'object') {
        if (Array.isArray(node) && node.length + nodes + stack.length > 500000) throw new Error('JSON is too complex.');
        const children = Object.values(node);
        if (children.length + nodes + stack.length > 500000) throw new Error('JSON is too complex.');
        for (const child of children) stack.push([child, depth + 1]);
      }
    }
    if (mime === 'application/geo+json') validateGeoJSON(value);
  }
  return {mime, size: bytes.length};
}
export function validateGeoJSON(value) {
  const invalid = () => { throw new Error('Invalid GeoJSON geometry, feature, or feature collection.'); };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const position = p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite);
  const line = p => Array.isArray(p) && p.length >= 2 && p.every(position);
  const ring = p => line(p) && p.length >= 4 && p[0].length === p.at(-1).length && p[0].every((v,i) => v === p.at(-1)[i]);
  const polygon = p => Array.isArray(p) && p.length > 0 && p.every(ring);
  function geometry(g, depth = 0) {
    if (!object(g) || depth > 64) invalid();
    const c = g.coordinates;
    const checks = {
      Point: () => position(c), MultiPoint: () => Array.isArray(c) && c.every(position),
      LineString: () => line(c), MultiLineString: () => Array.isArray(c) && c.every(line),
      Polygon: () => polygon(c), MultiPolygon: () => Array.isArray(c) && c.every(polygon),
      GeometryCollection: () => Array.isArray(g.geometries) && g.geometries.every(x => {geometry(x, depth + 1); return true;}),
    };
    if (!Object.hasOwn(checks, g.type) || !checks[g.type]()) invalid();
  }
  function feature(f) {
    if (!object(f) || f.type !== 'Feature' || !(f.properties === null || object(f.properties))) invalid();
    if (f.geometry !== null) geometry(f.geometry);
  }
  if (!object(value)) invalid();
  if (value.type === 'FeatureCollection') {
    if (!Array.isArray(value.features)) invalid();
    value.features.forEach(feature);
  } else if (value.type === 'Feature') feature(value);
  else geometry(value);
}
export async function validateFile(blob, path = blob.name || 'clipboard.png') {
  if (blob.size > LIMITS.file) throw new Error('Files must be at most 5 MiB.');
  const mime = fileMime(path);
  if (!mime) throw new Error('Supported files: JPEG, PNG, static WebP, JSON, GeoJSON, CSV, TSV, and TXT.');
  if (isImage(mime)) {
    const result = await validateImage(blob);
    if (result.mime !== mime) throw new Error('Image content does not match its filename extension.');
    return result;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer()), info = dataInfo(bytes, path);
  return {...info, contentHash: await sha256(bytes), blob: new Blob([bytes], {type: info.mime})};
}
export const utf8 = (value) => new TextEncoder().encode(value);
export const sha256 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const canonicalJSON = (value) => JSON.stringify(sort(value));
function sort(v) {
  return Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sort(v[k])]),
        )
      : v;
}
export function safePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 500 ||
    path !== path.normalize("NFC") ||
    /[\\%:#?\x00-\x1f\x7f]/.test(path) ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.endsWith(".") ||
          p.endsWith(" ") ||
          p.startsWith("."),
      )
  )
    throw new Error(
      "Unsafe file path. Use a repository-relative path without traversal or encoded characters.",
    );
  return path;
}
export function mediaDirectory(prefix) {
  if (typeof prefix !== "string" || !prefix.startsWith("/assets/"))
    throw new Error(
      "Local files need a local media_subpath under /assets/. External media prefixes must be changed explicitly in source first.",
    );
  return safePath(prefix.replace(/\/$/, "").slice(1));
}
export function postDirectory(path) {
  const name = String(path || "")
    .split("/")
    .pop()
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/\.(md|markdown)$/i, "");
  if (!name) throw new Error("Name this post before adding files.");
  return "/assets/posts/" + safePath(name);
}
export function manifestPath(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new Error("Invalid workspace ID.");
  return `_data/storykit_workspaces/${id}.json`;
}
export function sourceFields(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^(media_subpath|storykit_workspace):\s*(.*?)\s*$/.exec(line);
    if (m) {
      if (Object.hasOwn(fields, m[1]))
        throw new Error("Duplicate workspace front matter field.");
      const value = m[2].replace(/\s+#.*$/, "");
      if (value.startsWith('"')) {
        try {
          fields[m[1]] = JSON.parse(value);
        } catch {
          throw new Error("Invalid quoted workspace field.");
        }
      } else if (value.startsWith("'")) {
        if (!value.endsWith("'"))
          throw new Error("Invalid quoted workspace field.");
        fields[m[1]] = value.slice(1, -1).replace(/''/g, "'");
      } else {
        if (/^[&*!>|[{]/.test(value))
          throw new Error("Workspace fields must be literal strings.");
        fields[m[1]] = value;
      }
      if (typeof fields[m[1]] !== "string")
        throw new Error("Workspace fields must be strings.");
    }
  }
  return fields;
}
export function setSourceField(content, key, value) {
  if (!["media_subpath", "storykit_workspace"].includes(key))
    throw new Error("Unsupported front matter edit.");
  const line = `${key}: ${JSON.stringify(value)}`;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return `---\n${line}\n---\n\n${content}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  const front = re.test(match[1])
    ? match[1].replace(re, line)
    : match[1] + "\n" + line;
  return "---\n" + front + "\n---\n" + content.slice(match[0].length);
}
export function validateManifest(raw, content) {
  if (typeof content !== "string")
    throw new Error("Markdown source must be text.");
  if (!raw || raw.schemaVersion !== 1)
    throw new Error(
      "Unsupported workspace manifest version. Markdown remains available.",
    );
  if (utf8(JSON.stringify(raw)).length > LIMITS.manifest)
    throw new Error("Workspace manifest is too large.");
  manifestPath(raw.workspaceId);
  safePath(raw.entryPath);
  if (
    !/\.(md|markdown)$/i.test(raw.entryPath) ||
    !Array.isArray(raw.files) ||
    raw.files.length > LIMITS.count
  )
    throw new Error("Invalid workspace manifest.");
  const directory = mediaDirectory(sourceFields(content).media_subpath);
  if (sourceFields(content).storykit_workspace !== raw.workspaceId)
    throw new Error("Source and workspace identity disagree.");
  let total = 0;
  const paths = new Set(),
    ids = new Set();
  const files = raw.files.map((f) => {
    const path = safePath(f.path),
      fold = path.toLowerCase();
    if (
      !path.startsWith(directory + "/") ||
      paths.has(fold) ||
      ids.has(f.assetId) ||
      typeof f.assetId !== "string" ||
      !/^[\w-]{1,100}$/.test(f.assetId)
    )
      throw new Error("Duplicate or out-of-scope managed file.");
    if (
      !FILE_TYPES[f.mime]?.test(path) ||
      !Number.isInteger(f.size) ||
      f.size < (isImage(f.mime) ? 1 : 0) ||
      f.size > LIMITS.file ||
      (isImage(f.mime) && (!Number.isInteger(f.width) ||
      !Number.isInteger(f.height) ||
      f.width < 1 ||
      f.height < 1 ||
      f.width * f.height > LIMITS.pixels)) ||
      (!isImage(f.mime) && (f.width !== undefined || f.height !== undefined)) ||
      !/^[a-f0-9]{64}$/.test(f.contentHash)
    )
      throw new Error("Invalid managed file metadata.");
    paths.add(fold);
    ids.add(f.assetId);
    total += f.size;
    const displayName =
      typeof f.displayName === "string" ? f.displayName : path.split("/").pop();
    if (displayName.length > 255) throw new Error("Filename is too long.");
    const metadata = {};
    for (const key of ["alt", "caption", "attribution"])
      if (f[key] !== undefined) {
        if (typeof f[key] !== "string" || f[key].length > 4000)
          throw new Error("Invalid file description.");
        metadata[key] = f[key];
      }
    return {
      assetId: f.assetId,
      path,
      mime: f.mime,
      size: f.size,
      ...(isImage(f.mime) ? {width: f.width, height: f.height} : {}),
      contentHash: f.contentHash,
      displayName,
      ...metadata,
    };
  });
  if (total > LIMITS.total || utf8(content).length > LIMITS.source)
    throw new Error("Story exceeds the 8 MiB file or 200 KB Markdown limit.");
  return {
    schemaVersion: 1,
    workspaceId: raw.workspaceId,
    entryPath: raw.entryPath,
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}
export async function packageDigest(content, manifest) {
  return sha256(utf8(canonicalJSON({ schemaVersion: 1, content, manifest })));
}
export function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(text) {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil(LIMITS.file / 3) * 4 ||
    text.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(text) ||
    !/^[^=]*={0,2}$/.test(text)
  )
    throw new Error("Invalid file encoding.");
  try {
    const binary = atob(text),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error("Invalid file encoding.");
  }
}
/** Structural preflight bounds allocation before a real decoder runs. */
export function imageInfo(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > LIMITS.file
  )
    throw new Error("Images must be at most 5 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  let mime, width, height;
  if (bytes.length >= 33 && str(0, 8) === "\x89PNG\r\n\x1a\n") {
    mime = "image/png";
    if (str(12, 4) !== "IHDR" || view.getUint32(8) !== 13)
      throw new Error("Invalid PNG header.");
    width = view.getUint32(16);
    height = view.getUint32(20);
    let end = false;
    for (let p = 8; p + 12 <= bytes.length; ) {
      const n = view.getUint32(p),
        type = str(p + 4, 4);
      if (n > bytes.length - p - 12) throw new Error("Truncated PNG.");
      if (["acTL", "fcTL", "fdAT"].includes(type))
        throw new Error("Animated images are not supported.");
      p += n + 12;
      if (type === "IEND") {
        end = p === bytes.length;
        break;
      }
    }
    if (!end) throw new Error("Truncated PNG.");
  } else if (
    bytes.length >= 12 &&
    str(0, 4) === "RIFF" &&
    str(8, 4) === "WEBP"
  ) {
    mime = "image/webp";
    if (view.getUint32(4, true) + 8 !== bytes.length)
      throw new Error("Truncated WebP.");
    for (let p = 12; p + 8 <= bytes.length; ) {
      const type = str(p, 4),
        n = view.getUint32(p + 4, true),
        d = p + 8;
      if (n > bytes.length - d) throw new Error("Truncated WebP.");
      if (
        type === "ANIM" ||
        type === "ANMF" ||
        (type === "VP8X" && bytes[d] & 2)
      )
        throw new Error("Animated images are not supported.");
      if (type === "VP8X" && n >= 10) {
        width = 1 + bytes[d + 4] + (bytes[d + 5] << 8) + (bytes[d + 6] << 16);
        height = 1 + bytes[d + 7] + (bytes[d + 8] << 8) + (bytes[d + 9] << 16);
      }
      if (type === "VP8 " && n >= 10 && !width) {
        width = view.getUint16(d + 6, true) & 16383;
        height = view.getUint16(d + 8, true) & 16383;
      }
      if (type === "VP8L" && n >= 5 && !width) {
        const bits = view.getUint32(d + 1, true);
        width = 1 + (bits & 16383);
        height = 1 + ((bits >>> 14) & 16383);
      }
      p = d + n + (n % 2);
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    let p = 2;
    while (p + 4 < bytes.length) {
      if (bytes[p++] !== 255) throw new Error("Invalid JPEG.");
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 217 || marker === 218) break;
      const n = view.getUint16(p);
      if (n < 2 || p + n > bytes.length) throw new Error("Truncated JPEG.");
      if ([192, 193, 194].includes(marker)) {
        height = view.getUint16(p + 3);
        width = view.getUint16(p + 5);
        break;
      }
      p += n;
    }
  } else
    throw new Error("Only JPEG, PNG and static WebP images are supported.");
  if (!width || !height || width * height > LIMITS.pixels)
    throw new Error("Image dimensions are invalid or exceed 4 megapixels.");
  return { mime, width, height, size: bytes.length };
}
export async function validateImage(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    info = imageInfo(bytes);
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: info.mime }),
    { imageOrientation: "none" },
  );
  try {
    const orientedJPEG =
      info.mime === "image/jpeg" &&
      bitmap.width === info.height &&
      bitmap.height === info.width;
    if (
      !orientedJPEG &&
      (bitmap.width !== info.width || bitmap.height !== info.height)
    )
      throw new Error("Decoded image dimensions disagree.");
  } finally {
    bitmap.close();
  }
  return {
    ...info,
    contentHash: await sha256(bytes),
    blob: new Blob([bytes], { type: info.mime }),
  };
}
