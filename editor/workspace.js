import { docs, workspaces } from "./store.js";
import {
  validateFile,
  validateManifest,
  sourceFields,
  setSourceField,
  postDirectory,
  mediaDirectory,
  packageDigest,
} from "./package-validation.js";
export async function capturePackage(id, content, expectedVersion) {
  if (
    expectedVersion !== undefined &&
    ((await docs.get(id))?.workspaceVersion || 0) !== expectedVersion
  )
    throw new Error(
      "This story changed in another tab. Reopen it before exporting or saving a package.",
    );
  if (content !== undefined) {
    const doc = await docs.get(id);
    if (doc.content !== content)
      await docs.update(
        id,
        { content },
        {
          expectedContent: doc.content,
          expectedVersion: doc.workspaceVersion || 0,
        },
      );
  }
  const { doc, blobs } = await workspaces.capture(id);
  const manifest = validateManifest(doc.manifest, doc.content);
  return {
    doc,
    content: doc.content,
    manifest,
    blobs,
    digest: await packageDigest(doc.content, manifest),
    version: doc.workspaceVersion,
  };
}
export async function prepareFiles(files) {
  const valid = [],
    invalid = [];
  for (const file of files) {
    try {
      valid.push({
        ...(await validateFile(file)),
        displayName: file.name || "clipboard.png",
      });
    } catch (error) {
      invalid.push({
        name: file.name || "Clipboard image",
        message: error.message,
      });
    }
  }
  return { valid, invalid };
}
export async function addFiles(
  id,
  prepared,
  { content, replacePath, locatePath, onCollision, expectedVersion } = {},
) {
  let doc = await docs.get(id);
  if (!doc) throw new Error("Open a story first.");
  if (
    expectedVersion !== undefined &&
    (doc.workspaceVersion || 0) !== expectedVersion
  )
    throw new Error(
      "This story changed in another tab. Reopen it before changing files.",
    );
  if (content !== undefined && content !== doc.content)
    doc = await docs.update(
      id,
      { content },
      {
        expectedContent: doc.content,
        expectedVersion: doc.workspaceVersion || 0,
      },
    );
  if (!doc.path) {
    const slug =
      (doc.title || "story")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "story";
    const path = `_posts/${new Date().toISOString().slice(0, 10)}-${slug}.md`;
    if ((await docs.list()).some((d) => d.id !== id && d.path === path))
      throw new Error(
        "Another post uses this title. Rename this story before adding files.",
      );
    doc = await docs.update(id, { path });
  }
  let source = doc.content;
  const prefix = sourceFields(source).media_subpath || postDirectory(doc.path),
    directory = mediaDirectory(prefix);
  const workspaceId = doc.workspaceId || crypto.randomUUID();
  source = setSourceField(
    setSourceField(source, "media_subpath", prefix),
    "storykit_workspace",
    workspaceId,
  );
  const files = [...(doc.manifest?.files || [])],
    added = [];
  for (const file of prepared) {
    const extension = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "application/json": "json", "application/geo+json": "geojson",
      "text/csv": "csv", "text/tab-separated-values": "tsv", "text/plain": "txt",
    }[file.mime];
    const stem =
      file.displayName
        .replace(/\.[^.]*$/, "")
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "file";
    let path = replacePath || locatePath || `${directory}/${stem}.${extension}`;
    let existing = files.find(
      (f) => f.path.toLowerCase() === path.toLowerCase(),
    );
    let replace = !!replacePath;
    if (existing && !replace) {
      const choice = onCollision
        ? await onCollision(path)
        : existing.contentHash === file.contentHash
          ? "reuse"
          : "rename";
      if (choice === "reuse") {
        added.push(existing);
        continue;
      }
      if (choice === "replace") replace = true;
      else {
        let n = 2;
        while (files.some((f) => f.path.toLowerCase() === path.toLowerCase()))
          path = `${directory}/${stem}-${n++}.${extension}`;
      }
    }
    const entry = {
      assetId: existing && replace ? existing.assetId : crypto.randomUUID(),
      path,
      mime: file.mime,
      size: file.size,
      width: file.width,
      height: file.height,
      contentHash: file.contentHash,
      displayName: file.displayName,
    };
    if (existing && replace) files.splice(files.indexOf(existing), 1, entry);
    else files.push(entry);
    added.push(entry);
  }
  const manifest = validateManifest(
    { schemaVersion: 1, workspaceId, entryPath: doc.path, files },
    source,
  );
  const saved = await workspaces.mutate(id, {
    expectedVersion: doc.workspaceVersion || 0,
    content: source,
    manifest,
    blobs: prepared,
  });
  return { doc: saved, added };
}
export async function removeFile(id, path, content, expectedVersion) {
  let doc = await docs.get(id);
  if (
    expectedVersion !== undefined &&
    (doc.workspaceVersion || 0) !== expectedVersion
  )
    throw new Error(
      "This story changed in another tab. Reopen it before removing files.",
    );
  if (content !== doc.content)
    doc = await docs.update(
      id,
      { content },
      {
        expectedContent: doc.content,
        expectedVersion: doc.workspaceVersion || 0,
      },
    );
  const manifest = validateManifest(
    {
      ...doc.manifest,
      files: doc.manifest.files.filter((f) => f.path !== path),
    },
    doc.content,
  );
  return workspaces.mutate(id, {
    expectedVersion: doc.workspaceVersion || 0,
    content: doc.content,
    manifest,
  });
}
export async function restorePackage(id, revision, currentContent) {
  let doc = await docs.get(id);
  if (currentContent !== doc.content)
    doc = await docs.update(id, { content: currentContent });
  let content = revision.content;
  if (!Object.hasOwn(revision, "manifest") && doc.manifest) {
    const fields = sourceFields(doc.content);
    for (const key of ["media_subpath", "storykit_workspace"])
      content = setSourceField(content, key, fields[key]);
  }
  return workspaces.mutate(id, {
    expectedVersion: doc.workspaceVersion || 0,
    content,
    manifest: Object.hasOwn(revision, "manifest")
      ? revision.manifest
      : doc.manifest || null,
    reason: "pre-restore",
  });
}
