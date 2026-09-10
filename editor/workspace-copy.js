import {
  sourceFields,
  setSourceField,
  postDirectory,
  mediaDirectory,
  validateManifest,
} from "./package-validation.js";
import { scanReferences, replaceDestinations } from "./file-references.js";
/** A copy owns new destinations; immutable byte objects can still be shared. */
export function copyPackage({ content, manifest, blobs }) {
  const workspaceId = crypto.randomUUID(),
    suffix = workspaceId.slice(0, 8);
  const entryPath = manifest.entryPath.replace(
    /(\.(?:md|markdown))$/i,
    `-copy-${suffix}$1`,
  );
  const directory = mediaDirectory(postDirectory(entryPath));
  const oldDirectory = mediaDirectory(sourceFields(content).media_subpath);
  const paths = new Map(
    manifest.files.map((f) => [
      f.path,
      `${directory}/${f.path.slice(oldDirectory.length + 1)}`,
    ]),
  );
  content = replaceDestinations(
    content,
    scanReferences(content, manifest),
    (r) => (r.file ? "/" + paths.get(r.path) : undefined),
  );
  content = setSourceField(
    setSourceField(content, "media_subpath", "/" + directory),
    "storykit_workspace",
    workspaceId,
  );
  const next = validateManifest(
    {
      ...manifest,
      workspaceId,
      entryPath,
      files: manifest.files.map((f) => ({
        ...f,
        assetId: crypto.randomUUID(),
        path: paths.get(f.path),
      })),
    },
    content,
  );
  return { content, manifest: next, blobs };
}
