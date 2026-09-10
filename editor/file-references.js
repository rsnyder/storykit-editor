import { parser } from "@lezer/markdown";
import { parser as yamlParser } from "@lezer/yaml";
import { load as loadYaml } from "js-yaml";
import { safePath, sourceFields, fileMime } from "./package-validation.js";

/** Track only literal cover paths, with YAML syntax offsets so comments,
 * unrelated values and nested keys are never changed by path rewriting. */
function coverReferences(frontMatter) {
  if (!frontMatter) return [];
  const start = frontMatter.indexOf('\n') + 1;
  const yaml = frontMatter.slice(start).replace(/---(?:\r?\n)?$/, '');
  let parsed;
  try { parsed = loadYaml(yaml); } catch { return []; }
  const mapping = yamlParser.parse(yaml).topNode.getChild('Document')?.getChild('BlockMapping');
  const pairFor = (map, name) => map?.getChildren('Pair').find(pair => {
    const key = pair.getChild('Key');
    try { return key && loadYaml(yaml.slice(key.from, key.to)) === name; } catch { return false; }
  });
  const valueOf = pair => {
    if (!pair) return null;
    for (let node = pair.firstChild; node; node = node.nextSibling) {
      if (!['Key', ':', 'Comment'].includes(node.name)) return node;
    }
    return null;
  };
  let value = valueOf(pairFor(mapping, 'image'));
  if (!value) return [];
  if (['BlockMapping', 'FlowMapping'].includes(value.name)) value = valueOf(pairFor(value, 'path'));
  if (!value) return [];
  const literal = ['Literal', 'QuotedLiteral'].includes(value.name);
  let path;
  try { path = literal ? loadYaml(yaml.slice(value.from, value.to)) : yaml.slice(value.from, value.to); } catch { return []; }
  if (typeof path !== 'string' || !path.trim()) return [];
  return [{kind: literal ? 'cover' : 'unsupported', value: path,
    from: start + value.from, to: start + value.to, syntax: 'yaml',
    alt: typeof parsed?.image?.alt === 'string' ? parsed.image.alt : ''}];
}
/** Destinations are indexed from syntax nodes, never rewritten globally. */
export function scanReferences(content, manifest) {
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content),
    offset = fm?.[0].length || 0;
  const body = content.slice(offset),
    tree = parser.parse(body),
    blocked = [],
    definitions = new Map(),
    images = [],
    references = coverReferences(fm?.[0]);
  tree.iterate({
    enter(node) {
      if (
        [
          "FencedCode",
          "CodeBlock",
          "InlineCode",
          "HTMLBlock",
          "HTMLTag",
        ].includes(node.name)
      ) {
        blocked.push([node.from, node.to]);
        return false;
      }
      if (node.name === "LinkReference") {
        const label = node.node.getChild("LinkLabel"),
          url = node.node.getChild("URL");
        if (label && url)
          definitions.set(
            body
              .slice(label.from, label.to)
              .replace(/^\[|\]$/g, "")
              .toLowerCase(),
            url,
          );
      }
      if (["Image", "Link"].includes(node.name)) images.push(node.node);
    },
  });
  for (const node of images) {
    let url = node.getChild("URL");
    const text = body.slice(node.from, node.to),
      alt = /^!?\[([\s\S]*?)\]/.exec(text)?.[1] || "";
    if (!url) {
      const labels = node.getChildren("LinkLabel");
      const label = labels.at(-1);
      url =
        definitions.get(
          (label
            ? body.slice(label.from, label.to).replace(/^\[|\]$/g, "")
            : alt
          ).toLowerCase(),
        ) || definitions.get(alt.toLowerCase());
    }
    if (url)
      references.push({
        kind: node.name === "Link" ? "link" : "markdown",
        value: body.slice(url.from, url.to).replace(/^<|>$/g, ""),
        from: offset + url.from,
        to: offset + url.to,
        alt,
      });
  }
  // Liquid include syntax is tokenized only outside Markdown code/HTML nodes.
  const includes = /{%\s*include\s+embed\/([\w-]+)\.html\s+([\s\S]*?)%}/g;
  let match;
  while ((match = includes.exec(body))) {
    if (blocked.some(([a, b]) => match.index >= a && match.index < b)) continue;
    const params = /\b(src|geojson)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
    let p;
    while ((p = params.exec(match[2]))) {
      const value = p[2] ?? p[3] ?? p[4],
        start =
          match.index +
          match[0].indexOf(match[2]) +
          p.index +
          p[0].indexOf(value, p[0].indexOf("=") + 1);
      const map = match[1] === 'map' && p[1] === 'geojson';
      let partOffset = 0;
      for (const part of map ? value.split('|') : [value]) {
        const path = map ? part.split('~')[0].trim() : part;
        const from = offset + start + partOffset + (map ? part.indexOf(path) : 0);
        references.push({kind: map ? 'map' : match[1] === 'image' ? 'viewer' : 'unsupported',
          value: path, from, to: from + path.length,
          alt: /(?:caption|alt)\s*=\s*["']([^"']+)/.exec(match[2])?.[1] || ''});
        partOffset += part.length + 1;
      }
    }
  }
  const prefix = sourceFields(content).media_subpath;
  return references.map((r) => {
    if (r.kind === 'link') {
      const literal = /^{{\s*(["'])(\/assets\/[^"']+)\1\s*\|\s*relative_url\s*}}$/.exec(r.value);
      if (literal) r = {...r, value: literal[2], syntax: 'liquid-url'};
    }
    if (
      r.kind === "unsupported" ||
      /[{}]/.test(r.value) ||
      /^(page|site|include)\./.test(r.value)
    )
      return { ...r, state: "Not checked" };
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(r.value))
      return { ...r, state: "External" };
    try {
      const path = safePath(
        r.value.startsWith("/")
          ? r.value.slice(1)
          : `${prefix || ""}/${r.value}`.replace(/^\//, ""),
      );
      const file = manifest?.files.find((f) => f.path === path);
      return { ...r, path, file, state: file ? "Managed" : "Not verified" };
    } catch {
      return { ...r, state: "Not checked" };
    }
  });
}
export function replaceDestinations(content, references, replace) {
  const edits = new Map();
  for (const r of references) {
    const next = replace(r);
    if (next !== undefined)
      edits.set(r.from, {
        ...r,
        next: r.syntax === 'liquid-url' ? (next.startsWith('sk-local:') ? '<' + next + '>' : '<{{ ' + JSON.stringify(next) + ' | relative_url }}>') : r.syntax === 'yaml' ? JSON.stringify(next) : content.slice(r.from, r.to).startsWith("<")
          ? "<" + next + ">"
          : next,
      });
  }
  for (const r of [...edits.values()].sort((a, b) => b.from - a.from))
    content = content.slice(0, r.from) + r.next + content.slice(r.to);
  return content;
}
export function localPreviewSource(content, manifest, generation) {
  const references = scanReferences(content, manifest),
    ids = new Map(),
    assigned = [];
  for (const r of references)
    if (r.file && !ids.has(r.file.path) && previewable(r)) {
      const resourceId = "file_" + assigned.length;
      ids.set(r.file.path, resourceId);
      assigned.push({ ...r.file, resourceId });
    }
  return {
    content: replaceDestinations(content, references, (r) =>
      r.file && previewable(r) ? "sk-local:" + ids.get(r.file.path) : undefined,
    ),
    assigned,
    references,
    generation,
  };
}

function previewable(r) {
  return r.kind === 'link' || (r.kind === 'map' ? ['application/json', 'application/geo+json'].includes(r.file.mime) : (r.file.mime || fileMime(r.file.path) || '').startsWith('image/'));
}
