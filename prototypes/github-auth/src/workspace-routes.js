import {
  LIMITS,
  dataInfo, fileMime, isImage, sha256,
  validateManifest,
  manifestPath,
  sourceFields,
  canonicalJSON,
  packageDigest,
  utf8,
  base64,
  fromBase64,
  safePath,
} from "../../../editor/package-validation.js";
import { commitPackage, reconcilePackage } from "./package-commit.js";
const READ_CACHE = Symbol("workspace request reads");
const OID = /^[a-f0-9]{40}$/;
const gitOid = async (bytes) => {
  const header = utf8(`blob ${bytes.length}\0`),
    input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", input))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
export function createWorkspaceRoutes({
  github,
  checkGitHub,
  repository,
  repoParts,
  branchName,
  bodyOf,
  json,
  fail,
  decode,
}) {
  function validate(fn) {
    try {
      return fn();
    } catch (error) {
      fail(400, "validation", error.message);
    }
  }
  async function decoded(bytes, path) {
    try {
      return isImage(fileMime(path)) ? await decode(bytes) : {...dataInfo(bytes, path), contentHash: await sha256(bytes)};
    } catch (error) {
      fail(400, "image", error.message);
    }
  }
  async function get(session, env, path) {
    const cache = session[READ_CACHE];
    if (!cache.has(path))
      cache.set(
        path,
        (async () => {
          const r = await github(session, env, path);
          checkGitHub(r);
          return r.json();
        })(),
      );
    return cache.get(path);
  }
  async function head(session, env, prefix, branch) {
    return (
      await get(
        session,
        env,
        `${prefix}/branches/${encodeURIComponent(branch)}`,
      )
    ).commit.sha;
  }
  async function read(session, env, prefix, commit, path, max = LIMITS.file) {
    safePath(path);
    let oid = commit;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const tree = await get(session, env, `${prefix}/git/trees/${oid}`);
      if (tree.truncated)
        fail(
          422,
          "tree_limit",
          "This directory is too large to verify safely.",
        );
      const entry = tree.tree.find((e) => e.path === parts[i]);
      if (!entry) {
        if (
          tree.tree.some((e) => e.path.toLowerCase() === parts[i].toLowerCase())
        )
          fail(
            409,
            "case_collision",
            "A case-colliding destination exists. Choose another path.",
          );
        return null;
      }
      if (i < parts.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000")
          fail(400, "path", "Managed paths cannot traverse symlinks.");
        oid = entry.sha;
      } else {
        if (entry.type !== "blob" || entry.mode !== "100644")
          fail(400, "mode", "Only regular non-executable files are supported.");
        if (max && entry.size > max)
          fail(413, "size", "Remote file exceeds the supported limit.");
        if (max === 0) return { sha: entry.sha };
        const blob = await get(
          session,
          env,
          `${prefix}/git/blobs/${entry.sha}`,
        );
        if (blob.size > max || blob.encoding !== "base64")
          fail(413, "size", "Remote file exceeds the supported limit.");
        const bytes = fromBase64(blob.content.replace(/\s/g, ""));
        if (bytes.length > max)
          fail(413, "size", "Remote file exceeds the supported limit.");
        return { sha: entry.sha, bytes };
      }
    }
  }
  async function assertOwnership(session, env, prefix, commit, manifest) {
    let oid = commit;
    for (const name of ["_data", "storykit_workspaces"]) {
      const tree = await get(session, env, `${prefix}/git/trees/${oid}`);
      if (tree.truncated)
        fail(
          422,
          "tree_limit",
          "Cannot verify workspace ownership in a truncated tree.",
        );
      const entry = tree.tree.find((e) => e.path === name);
      if (!entry) return;
      if (entry.mode !== "040000")
        fail(
          409,
          "ownership",
          "Workspace metadata directory is not a regular directory.",
        );
      oid = entry.sha;
    }
    const tree = await get(session, env, `${prefix}/git/trees/${oid}`);
    if (tree.truncated || tree.tree.length > 200)
      fail(
        422,
        "tree_limit",
        "Workspace ownership index exceeds the supported limit.",
      );
    const owned = new Set(manifest.files.map((f) => f.path.toLowerCase()));
    for (const entry of tree.tree) {
      if (
        entry.path === manifest.workspaceId + ".json" ||
        !entry.path.endsWith(".json")
      )
        continue;
      if (entry.mode !== "100644" || entry.size > LIMITS.manifest)
        fail(409, "ownership", "Cannot verify another workspace manifest.");
      const file = await read(
        session,
        env,
        prefix,
        commit,
        `_data/storykit_workspaces/${entry.path}`,
        LIMITS.manifest,
      );
      let other;
      try {
        other = JSON.parse(new TextDecoder().decode(file.bytes));
      } catch {
        fail(409, "ownership", "Cannot verify another workspace manifest.");
      }
      if (!Array.isArray(other.files))
        fail(409, "ownership", "Cannot verify another workspace manifest.");
      if (
        other.entryPath === manifest.entryPath ||
        other.files.some(
          (f) => typeof f.path === "string" && owned.has(f.path.toLowerCase()),
        )
      )
        fail(
          409,
          "ownership",
          "Another story owns one of these destinations. Save a copy with new paths.",
        );
    }
  }
  async function load(session, env, data, includePaths = true) {
    const prefix = repoParts(data);
    branchName(data.branch);
    safePath(data.path);
    if (!/\.(md|markdown)$/i.test(data.path))
      fail(400, "path", "Choose a Markdown entry point.");
    const commit =
      data.commit || (await head(session, env, prefix, data.branch));
    if (!OID.test(commit)) fail(400, "commit", "A pinned commit is required.");
    const source = await read(
      session,
      env,
      prefix,
      commit,
      data.path,
      LIMITS.source,
    );
    if (!source)
      return {
        commit,
        source: null,
        manifest: null,
        paths: { [data.path]: null },
      };
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
        source.bytes,
      ),
      id = sourceFields(content).storykit_workspace;
    if (!id)
      return {
        commit,
        source: { content, sha: source.sha },
        manifest: null,
        paths: { [data.path]: source.sha },
      };
    const path = manifestPath(id),
      raw = await read(session, env, prefix, commit, path, LIMITS.manifest);
    if (!raw)
      fail(
        422,
        "manifest_missing",
        "Workspace manifest is missing; Markdown can still be opened separately.",
      );
    const manifest = validateManifest(
      JSON.parse(new TextDecoder().decode(raw.bytes)),
      content,
    );
    if (manifest.entryPath !== data.path)
      fail(409, "ownership", "This manifest belongs to another story.");
    const paths = { [data.path]: source.sha, [path]: raw.sha };
    if (includePaths)
      for (const f of manifest.files) {
        const file = await read(session, env, prefix, commit, f.path, 0);
        if (!file)
          fail(422, "missing_asset", `Missing managed file: ${f.path}`);
        paths[f.path] = file.sha;
      }
    return { commit, source: { content, sha: source.sha }, manifest, paths };
  }
  async function reconcile(session, env, op) {
    const prefix = "/repos/" + op.repository,
      current = await head(session, env, prefix, op.branch);
    if (op.state === "rejected")
      fail(
        409,
        "operation_rejected",
        "This operation did not create a commit. Capture and review a new save.",
      );
    if (op.state === "succeeded") {
      const result = JSON.parse(op.result);
      return { ...result, remoteChanged: current !== result.commit };
    }
    const entries = await get(
      session,
      env,
      `${prefix}/commits?sha=${encodeURIComponent(op.branch)}&per_page=100`,
    );
    const paths = JSON.parse(op.path_oids);
    const result = await reconcilePackage({
      history: entries.map((c) => ({ oid: c.sha, message: c.commit.message })),
      operationId: op.id,
      digest: op.digest,
      currentHead: current,
      verify: async (commit) => {
        for (const [path, oid] of Object.entries(paths)) {
          if ((await read(session, env, prefix, commit, path, 0))?.sha !== oid)
            return false;
        }
        return true;
      },
    });
    if (result.state !== "succeeded")
      fail(
        409,
        "uncertain",
        "The save outcome is uncertain. Keep this operation and compare GitHub before retrying.",
      );
    const saved = {
      commit: result.commitOid,
      paths,
      digest: op.digest,
      remoteChanged: result.remoteChanged,
    };
    await env.DB.prepare(
      "UPDATE workspace_operations SET state = 'succeeded', result = ? WHERE id = ?",
    )
      .bind(JSON.stringify(saved), op.id)
      .run();
    return saved;
  }
  return async function route(request, session, env, url) {
    session = { ...session, [READ_CACHE]: new Map() };
    const data = Object.fromEntries(url.searchParams);
    if (request.method === "GET" && url.pathname === "/api/github/workspace")
      return json(await load(session, env, data));
    if (request.method === "GET" && url.pathname === "/api/github/asset") {
      const workspace = await load(
        session,
        env,
        { ...data, path: data.entryPath },
        false,
      );
      const file = workspace.manifest?.files.find((f) => f.path === data.path);
      if (!file)
        fail(403, "asset", "This file is not owned by the pinned workspace.");
      const found = await read(
        session,
        env,
        repoParts(data),
        workspace.commit,
        file.path,
      );
      if (!found) fail(422, "missing_asset", "Managed file is missing.");
      const actual = await decoded(found.bytes, file.path);
      if (
        ["contentHash", "mime", "size", "width", "height"].some(
          (k) => actual[k] !== file[k],
        )
      )
        fail(422, "integrity", "Remote asset does not match its manifest.");
      return json({
        contents: base64(found.bytes),
        sha: found.sha,
        mime: file.mime,
      });
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/github/workspace/operations/")
    ) {
      const id = url.pathname.split("/").pop(),
        op = await env.DB.prepare(
          "SELECT * FROM workspace_operations WHERE id = ? AND user_id = ?",
        )
          .bind(id, session.user_id)
          .first();
      if (!op)
        fail(404, "operation", "Save operation not found for this account.");
      const [owner, repo] = op.repository.split("/");
      await repository(session, env, { owner, repo });
      return json(await reconcile(session, env, op));
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/api/github/workspace/save"
    )
      return null;
    const input = await bodyOf(request, LIMITS.request);
    branchName(input.branch);
    if (
      typeof input.operationId !== "string" ||
      !/^[\w-]{1,100}$/.test(input.operationId) ||
      !OID.test(input.expectedHead)
    )
      fail(400, "operation", "Invalid save operation or commit.");
    const { prefix } = await repository(session, env, input),
      repo = `${input.owner}/${input.repo}`;
    const manifest = validate(() =>
        validateManifest(input.manifest, input.content),
      ),
      mpath = manifestPath(manifest.workspaceId);
    const digest = await packageDigest(input.content, manifest);
    if (digest !== input.digest)
      fail(400, "digest", "Package digest does not match.");
    const previous = await env.DB.prepare(
      "SELECT * FROM workspace_operations WHERE id = ?",
    )
      .bind(input.operationId)
      .first();
    if (previous) {
      if (
        previous.user_id !== session.user_id ||
        previous.repository !== repo ||
        previous.branch !== input.branch ||
        previous.digest !== digest ||
        previous.expected_head !== input.expectedHead
      )
        fail(
          409,
          "operation",
          "Operation identity cannot be reused for another account, destination or package.",
        );
      return json(await reconcile(session, env, previous));
    }
    if (
      !Array.isArray(input.assets) ||
      input.assets.length !== manifest.files.length
    )
      fail(400, "assets", "Capture every required file before saving.");
    const contents = new Map([
      [manifest.entryPath, utf8(input.content)],
      [mpath, utf8(canonicalJSON(manifest))],
    ]);
    let total = 0;
    for (const f of manifest.files) {
      const assets = input.assets.filter((a) => a.path === f.path);
      if (assets.length !== 1)
        fail(400, "assets", "Missing or duplicate file.");
      const bytes = validate(() => fromBase64(assets[0].contents));
      total += bytes.length;
      if (total > LIMITS.total)
        fail(413, "size", "File package exceeds 8 MiB.");
      const actual = await decoded(bytes, f.path);
      if (
        ["contentHash", "size", "mime", "width", "height"].some(
          (k) => actual[k] !== f[k],
        )
      )
        fail(400, "integrity", `File integrity mismatch: ${f.path}`);
      contents.set(f.path, bytes);
    }
    const lockKey = `workspace:${repo.toLowerCase()}:${input.branch}`,
      nonce = crypto.randomUUID(),
      now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM write_locks WHERE expires_at <= ?")
      .bind(now)
      .run();
    try {
      await env.DB.prepare(
        "INSERT INTO write_locks (lock_key, nonce, expires_at) VALUES (?, ?, ?)",
      )
        .bind(lockKey, nonce, now + 120)
        .run();
    } catch {
      fail(
        409,
        "busy",
        "Another save is running on this branch. Try again shortly.",
      );
    }
    try {
      const current = await head(session, env, prefix, input.branch),
        paths = {},
        additions = [],
        conflicts = [];
      for (const [path, bytes] of contents) {
        const existing = await read(session, env, prefix, current, path, 0),
          expected = input.baseline?.[path] ?? null;
        const oid = await gitOid(bytes);
        paths[path] = oid;
        if ((existing?.sha || null) !== expected)
          conflicts.push({ path, sha: existing?.sha || null });
        if (existing?.sha !== oid)
          additions.push({ path, contents: base64(bytes) });
      }
      if (conflicts.length)
        fail(
          409,
          "package_conflict",
          "Package paths changed on GitHub. Compare the complete story before choosing a version.",
          { conflicts, commit: current },
        );
      // The source and its prior manifest must describe the same ownership.
      const oldSource = await read(
        session,
        env,
        prefix,
        current,
        manifest.entryPath,
        LIMITS.source,
      );
      const oldId =
        oldSource &&
        sourceFields(new TextDecoder().decode(oldSource.bytes))
          .storykit_workspace;
      await assertOwnership(session, env, prefix, current, manifest);
      const oldManifest = await read(
        session,
        env,
        prefix,
        current,
        mpath,
        LIMITS.manifest,
      );
      if (oldManifest) {
        let previous;
        try {
          previous = JSON.parse(new TextDecoder().decode(oldManifest.bytes));
        } catch {
          fail(409, "ownership", "The existing workspace manifest is invalid.");
        }
        if (previous.entryPath !== manifest.entryPath)
          fail(
            409,
            "ownership",
            "This workspace identity belongs to another Markdown destination.",
          );
      }
      if (oldId && oldId !== manifest.workspaceId)
        fail(
          409,
          "ownership",
          "Another workspace owns this Markdown destination. Save a copy to a different path.",
        );

      await env.DB.prepare(
        "INSERT INTO workspace_operations (id,user_id,repository,branch,digest,expected_head,path_oids,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          input.operationId,
          session.user_id,
          repo,
          input.branch,
          digest,
          input.expectedHead,
          JSON.stringify(paths),
          "uncertain",
          now,
        )
        .run();
      if (!additions.length) {
        const result = { commit: current, paths, digest, unchanged: true };
        await env.DB.prepare(
          "UPDATE workspace_operations SET state = 'succeeded', result = ? WHERE id = ?",
        )
          .bind(JSON.stringify(result), input.operationId)
          .run();
        return json(result);
      }
      let commit;
      try {
        commit = await commitPackage({
          graphql: async (body) => {
            const response = await github(session, env, "/graphql", {
              method: "POST",
              body: JSON.stringify(body),
            });
            checkGitHub(response);
            return response.json();
          },
          repository: repo,
          branch: input.branch,
          expectedHead: current,
          operationId: input.operationId,
          digest,
          additions,
        });
      } catch (error) {
        if (["head_changed", "protected_branch"].includes(error.code)) {
          await env.DB.prepare(
            "UPDATE workspace_operations SET state = 'rejected' WHERE id = ?",
          )
            .bind(input.operationId)
            .run();
          fail(error.status, error.code, error.message);
        }
        throw error;
      }
      const result = { commit: commit.oid, paths, digest };
      await env.DB.prepare(
        "UPDATE workspace_operations SET state = 'succeeded', result = ? WHERE id = ?",
      )
        .bind(JSON.stringify(result), input.operationId)
        .run();
      return json(result);
    } finally {
      await env.DB.prepare(
        "DELETE FROM write_locks WHERE lock_key = ? AND nonce = ?",
      )
        .bind(lockKey, nonce)
        .run();
    }
  };
}
