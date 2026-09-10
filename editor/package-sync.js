import * as auth from "./auth.js";
import * as github from "./github.js";
import { docs, workspaces } from "./store.js";
import { capturePackage } from "./workspace.js";
import {
  validateManifest,
  validateFile,
  fromBase64,
  base64,
  sourceFields,
  packageDigest,
} from "./package-validation.js";
import { copyPackage } from "./workspace-copy.js";
import { scanReferences } from "./file-references.js";
const query = (data) => new URLSearchParams(data).toString();
export async function readRemotePackage(binding) {
  const remote = await auth.request("/api/github/workspace?" + query(binding));
  if (!remote.source)
    throw new Error("The bound Markdown file no longer exists.");
  if (!remote.manifest)
    throw new Error(
      "This remote story has no managed-file manifest. Its Markdown remains available through Open from GitHub.",
    );
  const manifest = validateManifest(remote.manifest, remote.source.content),
    blobs = [];
  for (const f of manifest.files) {
    const result = await auth.request(
      "/api/github/asset?" +
        query({
          ...binding,
          entryPath: manifest.entryPath,
          path: f.path,
          commit: remote.commit,
        }),
    );
    const bytes = fromBase64(result.contents),
      image = await validateFile(new Blob([bytes]), f.path);
    if (
      ["contentHash", "mime", "size", "width", "height"].some(
        (k) => image[k] !== f[k],
      )
    )
      throw new Error(`Integrity check failed for ${f.path}.`);
    blobs.push(image);
  }
  return {
    ...remote,
    content: remote.source.content,
    manifest,
    blobs,
    digest: await packageDigest(remote.source.content, manifest),
  };
}
export function savedBinding(binding, snapshot, result) {
  return {
    ...binding,
    sha: result.paths[snapshot.manifest.entryPath],
    syncedAt: new Date().toISOString(),
    remoteChanged: !!result.remoteChanged,
    package: {
      content: snapshot.content,
      manifest: snapshot.manifest,
      digest: result.digest,
      commit: result.commit,
      paths: result.paths,
    },
  };
}
export async function pullPackage(id, bridge) {
  const doc = await docs.get(id),
    binding = {
      owner: doc.github.owner,
      repo: doc.github.repo,
      branch: doc.github.branch,
      path: doc.path,
    };
  const remote = await readRemotePackage(binding);
  const local = bridge?.getLocalContent(id);
  if (local !== null && local !== undefined)
    await docs.update(id, { content: local });
  const current = await docs.get(id);
  const saved = await workspaces.mutate(id, {
    expectedVersion: current.workspaceVersion || 0,
    content: remote.content,
    manifest: remote.manifest,
    blobs: remote.blobs,
    reason: "pre-pull",
    github: savedBinding(binding, remote, remote),
  });
  bridge?.replaceBuffer(id, saved.content);
  return saved;
}
async function finish(id, snapshot, result, binding, operation) {
  if (operation)
    await workspaces.operation({
      ...operation,
      state: "succeeded",
      commit: result.commit,
    });
  const current = await docs.get(id);
  if (
    current.github?.owner !== binding.owner ||
    current.github?.repo !== binding.repo ||
    current.github?.branch !== binding.branch ||
    current.path !== snapshot.manifest.entryPath
  )
    return current;
  return docs.update(id, { github: savedBinding(binding, snapshot, result) });
}
export async function savePackage(id, bridge) {
  const snapshot = await capturePackage(
      id,
      bridge?.getLocalContent(id) ?? undefined,
      bridge?.getWorkspaceVersion?.(id),
    ),
    binding = snapshot.doc.github;
  const caps = await auth.request("/api/github/capabilities");
  if (caps.workspace !== 1)
    throw new Error(
      "This server does not support story packages yet. Export a package to back up your files.",
    );
  if (snapshot.manifest.files.some(f => !f.mime.startsWith('image/')) && caps.localData !== 1)
    throw new Error('This server needs an update to save data files. Export a story package to keep a backup.');
  const account = auth.getSession()?.user?.id;
  const pending = (await workspaces.operations(id)).find(
    (o) => o.state === "uncertain" && o.account === account,
  );
  if (pending) {
    try {
      const result = await auth.request(
        "/api/github/workspace/operations/" + pending.id,
      );
      return finish(id, pending.snapshot, result, pending.binding, pending);
    } catch (error) {
      if (!["operation", "operation_rejected"].includes(error.code))
        throw error;
      await workspaces.operation({ ...pending, state: "rejected" });
    }
  }
  const refs = scanReferences(snapshot.content, snapshot.manifest);
  if (refs.some((r) => r.state === "Missing"))
    throw new Error(
      "Locate or remove the missing supported file references before saving the package.",
    );
  if (
    !window.confirm(
      `Save to GitHub?\n${binding.owner}/${binding.repo} · ${binding.branch}\n${snapshot.manifest.entryPath}\n${snapshot.manifest.files.map((f) => f.path).join("\n")}\n\nThis can trigger the repository’s deployment. External resources are not bundled.`,
    )
  )
    return snapshot.doc;
  let expectedHead =
    binding.package?.commit || (await github.getBranchHead(binding)).sha;
  let baseline = {
    ...(binding.package?.paths || {
      [snapshot.manifest.entryPath]: binding.sha || null,
    }),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const operation = {
      id: crypto.randomUUID(),
      docId: id,
      account,
      binding,
      state: "uncertain",
      snapshot: {
        content: snapshot.content,
        manifest: snapshot.manifest,
        digest: snapshot.digest,
      },
      expectedHead,
      baseline,
    };
    const assets = [];
    for (const f of snapshot.blobs)
      assets.push({
        path: f.path,
        contents: base64(new Uint8Array(await f.blob.arrayBuffer())),
      });
    await workspaces.operation(operation, snapshot.blobs);
    try {
      const result = await auth.request("/api/github/workspace/save", {
        owner: binding.owner,
        repo: binding.repo,
        branch: binding.branch,
        operationId: operation.id,
        expectedHead,
        baseline,
        content: snapshot.content,
        manifest: snapshot.manifest,
        digest: snapshot.digest,
        assets,
      });
      return finish(id, snapshot, result, binding, operation);
    } catch (error) {
      if (error.code === "head_changed") {
        await workspaces.operation({ ...operation, state: "rejected" });
        if (attempt === 0) {
          expectedHead = (await github.getBranchHead(binding)).sha;
          continue;
        }
      }
      if (error.code !== "package_conflict") {
        if (
          error.status >= 400 &&
          error.status < 500 &&
          error.code !== "uncertain"
        )
          await workspaces.operation({ ...operation, state: "rejected" });
        throw error;
      }
      await workspaces.operation({ ...operation, state: "rejected" });
      const choice = await conflictChoice(
        error.details?.conflicts || [],
        binding,
        error.details?.commit,
      );
      if (choice === "both") {
        await workspaces.importDocument(copyPackage(snapshot));
        return pullPackage(id, bridge);
      }
      if (choice === "remote") return pullPackage(id, bridge);
      if (choice !== "local") return docs.get(id);
      if (attempt)
        throw new Error("The remote changed again. Compare before retrying.");
      // A specific author decision acknowledges only the conflicting paths.
      for (const f of error.details.conflicts) baseline[f.path] = f.sha;
      expectedHead = error.details.commit;
    }
  }
}
function conflictChoice(paths, binding, commit) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "sk-dialog";
    const heading = document.createElement("h2");
    heading.textContent = "Story package conflict";
    dialog.append(heading);
    const p = document.createElement("p");
    p.textContent =
      "These paths changed on GitHub: " +
      paths.map((f) => f.path).join(", ") +
      ". Local files remain in browser history.";
    dialog.append(p);
    if (/^[a-f0-9]{40}$/.test(commit))
      for (const file of paths) {
        const link = document.createElement("a");
        link.textContent = "Compare remote " + file.path;
        link.href = `https://github.com/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}/blob/${commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const row = document.createElement("p");
        row.append(link);
        dialog.append(row);
      }
    for (const [label, value] of [
      ["Keep local", "local"],
      ["Use remote", "remote"],
      ["Keep both", "both"],
      ["Cancel", "cancel"],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => {
        dialog.close();
        resolve(value);
      };
      dialog.append(b);
    }
    dialog.addEventListener("cancel", () => resolve("cancel"));
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });
}
