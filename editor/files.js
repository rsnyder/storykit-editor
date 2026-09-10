import { docs, workspaces } from "./store.js";
import {
  prepareFiles,
  addFiles,
  removeFile,
  capturePackage,
} from "./workspace.js";
import { scanReferences } from "./file-references.js";
import { sourceFields, setSourceField } from "./package-validation.js";
import { exportPackage, importPackage } from "./package-archive.js";

export function createFilesPanel({
  getDocId,
  getVersion,
  getView,
  update,
  notify,
  openDoc,
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "sk-dialog";
  dialog.id = "story-files-panel";
  dialog.innerHTML =
    '<h2>Story files</h2><p>Files stay in this browser until you explicitly save to GitHub. Removing a file here leaves any committed copy in GitHub.</p><div class="sk-file-actions"></div><p role="status" aria-live="polite"></p><div class="sk-file-list"></div>';
  document.body.append(dialog);
  const actions = dialog.querySelector(".sk-file-actions"),
    status = dialog.querySelector("[role=status]"),
    list = dialog.querySelector(".sk-file-list");
  let busy = false,
    urls = [];
  function button(label, action, parent = actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm";
    b.textContent = label;
    b.onclick = () =>
      Promise.resolve(action()).catch((e) => {
        status.textContent = e.message;
        notify(e.message, "error");
      });
    parent.append(b);
    return b;
  }
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".jpg,.jpeg,.png,.webp,.json,.geojson,.csv,.tsv,.txt";
  picker.multiple = true;
  picker.hidden = true;
  dialog.append(picker);
  const archive = document.createElement("input");
  archive.type = "file";
  archive.accept = ".zip";
  archive.hidden = true;
  dialog.append(archive);
  button("Add files", () => picker.click());
  button("Export story package", async () => {
    const id = getDocId();
    if (!id) return;
    await exportPackage(
      await capturePackage(id, getView()?.state.doc.toString(), getVersion?.()),
    );
    status.textContent =
      "Exported owned files and Markdown. External resources are not bundled.";
  });
  button("Import story package", () => archive.click());
  button("Close", () => dialog.close());
  picker.onchange = () => {
    ingest([...picker.files]).catch((e) => notify(e.message, "error"));
    picker.value = "";
  };
  archive.onchange = async () => {
    try {
      const saved = await importPackage(archive.files[0]);
      if (saved) {
        await openDoc(saved.id);
        await refresh();
      }
    } catch (e) {
      notify(e.message, "error");
    } finally {
      archive.value = "";
    }
  };
  dialog.addEventListener("close", () => {
    urls.forEach(URL.revokeObjectURL);
    urls = [];
    getView()?.focus();
  });
  async function ingest(
    files,
    { insert = false, pos, replacePath, locatePath } = {},
  ) {
    if (busy) throw new Error("Wait for the current file operation to finish.");
    const id = getDocId(),
      view = getView(),
      state = view?.state;
    if (!id) throw new Error("Open or create a post first.");
    busy = true;
    status.textContent = "Validating and saving files…";
    try {
      const { valid, invalid } = await prepareFiles(files);
      if (invalid.length) {
        const report = invalid.map((f) => `${f.name}: ${f.message}`).join("\n");
        if (!valid.length) throw new Error(report);
        if (
          !window.confirm(
            report + `\n\nAdd the ${valid.length} valid file(s)?`,
          )
        )
          return;
      }
      if (!valid.length) return;
      const current = getDocId() === id ? getView() : null;
      const source = current?.state.doc.toString();
      const snapshotState = current?.state;
      const result = await addFiles(id, valid, {
        content: source,
        expectedVersion: getVersion?.(),
        replacePath,
        locatePath,
        onCollision: async (path) => {
          const choice = window.prompt(
            `${path} already exists. Type reuse, rename, or replace.`,
            "rename",
          );
          if (!["reuse", "rename", "replace"].includes(choice))
            throw new Error("File import cancelled.");
          return choice;
        },
      });
      const unchanged =
        getDocId() === id &&
        getView() === current &&
        current?.state === snapshotState;
      if (unchanged) update(id, result.doc.content);
      else if (getDocId() === id && getView() === current) {
        let latest = current.state.doc.toString();
        const fields = sourceFields(result.doc.content);
        for (const key of ["media_subpath", "storykit_workspace"])
          latest = setSourceField(latest, key, fields[key]);
        await docs.update(
          id,
          { content: latest },
          { expectedContent: result.doc.content },
        );
        update(id, latest);
      }
      if (insert && unchanged && state === snapshotState) {
        const delta = result.doc.content.length - source.length;
        insertEntries(
          result.added,
          Math.max(0, (pos ?? state.selection.main.from) + delta),
        );
      }
      status.textContent = unchanged
        ? "Saved in this browser."
        : "Saved files. The document changed; use Insert in Story files when ready.";
      notify(status.textContent, "success");
      await refresh();
    } finally {
      busy = false;
    }
  }
  function insertEntries(entries, pos) {
    const view = getView();
    if (!view) return;
    const markdown = dialog.querySelector("#file-markdown")?.checked || false;
    const alt = entries.some(f => f.mime.startsWith("image/")) ? window.prompt(
      markdown
        ? "Alternative text (describe the image):"
        : "Caption (leave empty to add later):",
      entries[0]?.caption || entries[0]?.alt || "",
    ) : "";
    if (alt === null) return;
    const escape = (v) =>
      v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
    const source = view.state.doc.toString(),
      prefix = sourceFields(source).media_subpath?.replace(/^\//, "") + "/";
    const text = entries
      .map((f) => {
        const relative = f.path.startsWith(prefix)
          ? f.path.slice(prefix.length)
          : "/" + f.path;
        if (f.mime === 'application/geo+json') return `{% include embed/map.html geojson="${escape(relative)}" id="map-${f.assetId.slice(0,8)}" %}`;
        if (!f.mime.startsWith('image/')) return `[${escape(f.displayName).replace(/[\[\]\\]/g, "\\$&")}](<{{ "/${f.path}" | relative_url }}>)`;
        return markdown
          ? `![${alt.replace(/[\[\]\\]/g, "\\$&")}](<${relative}>)`
          : `{% include embed/image.html src="${escape(relative)}" id="image-${f.assetId.slice(0, 8)}" caption="${escape(alt)}" %}`;
      })
      .join("\n\n");
    const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
    const at = Math.max(
      front?.[0].length || 0,
      pos ?? view.state.selection.main.from,
    );
    view.dispatch({
      changes: { from: at, insert: "\n\n" + text + "\n\n" },
      selection: { anchor: at + text.length + 4 },
    });
    view.focus();
  }
  async function refresh() {
    urls.forEach(URL.revokeObjectURL);
    urls = [];
    list.replaceChildren();
    const id = getDocId();
    if (!id) {
      status.textContent = "Open a post to manage files.";
      return;
    }
    const doc = await docs.get(id);
    if (getDocId() !== id) return;
    const source = getView()?.state.doc.toString() ?? doc.content,
      refs = scanReferences(source, doc.manifest);
    const label = document.createElement("label");
    label.innerHTML =
      '<input id="file-markdown" type="checkbox"> Insert as ordinary Markdown image';
    list.append(label);
    for (const file of doc.manifest?.files || []) {
      const row = document.createElement("section");
      row.className = "sk-file-row";
      const blob = await workspaces.bytes(file.contentHash),
        uses = refs.filter((r) => r.path === file.path).length;
      if (blob && file.mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.alt = "";
        img.width = 70;
        img.height = 55;
        img.style.objectFit = "contain";
        img.src = URL.createObjectURL(blob);
        urls.push(img.src);
        row.append(img);
      }
      const detail = document.createElement("p");
      detail.textContent = `${file.displayName} · ${file.path} · ${(file.size / 1024).toFixed(1)} KB · ${uses} recognized use(s) · ${!blob ? "Missing" : doc.github?.package?.manifest?.files.some((f) => f.path === file.path && f.contentHash === file.contentHash) ? "Saved to GitHub" : doc.github?.package ? "Changed locally" : "Saved in this browser"}`;
      row.append(detail);
      button("Insert", () => insertEntries([file]), row);
      if (!blob)
        button(
          "Locate file",
          () => pickOne((f) => ingest([f], { replacePath: file.path })),
          row,
        );
      button(
        "Replace",
        () => {
          if (
            !window.confirm(
              `Replace bytes at ${file.path}? Existing references will use the new file. The previous version is retained in history.`,
            )
          )
            return;
          pickOne((f) => ingest([f], { replacePath: file.path }));
        },
        row,
      );
      button(
        "Edit description",
        async () => {
          const caption = window.prompt(
            "Description used for new insertions:",
            file.caption || file.alt || "",
          );
          if (caption === null) return;
          if (caption.length > 4000)
            throw new Error(
              "Descriptions can contain at most 4,000 characters.",
            );
          const current = await docs.get(id);
          const manifest = {
            ...current.manifest,
            files: current.manifest.files.map((f) =>
              f.path === file.path ? { ...f, caption } : f,
            ),
          };
          await workspaces.mutate(id, {
            expectedVersion: current.workspaceVersion,
            content: current.content,
            manifest,
          });
          await refresh();
        },
        row,
      );
      button(
        "Remove from workspace",
        async () => {
          if (refs.some((r) => r.path === file.path))
            throw new Error(
              "Remove or change this file’s recognized references before removing it.",
            );
          const saved = await removeFile(
            id,
            file.path,
            source,
            doc.workspaceVersion || 0,
          );
          update(id, saved.content);
          await refresh();
        },
        row,
      );
      button(
        "Download file",
        () => {
          if (!blob) throw new Error("File bytes are missing.");
          download(blob, file.displayName);
        },
        row,
      );
      list.append(row);
    }
    for (const r of refs) {
      if (r.state === "Managed" && r.alt) continue;
      const row = document.createElement("p");
      row.textContent = `${r.value}: ${r.state === "Managed" ? "Add an accessible description or caption" : r.state}.`;
      if (
        r.state === "Missing" ||
        (r.state === "Not verified" &&
          r.path?.startsWith(
            (sourceFields(source).media_subpath || "").slice(1) + "/",
          ))
      )
        button(
          "Locate file",
          () => pickOne((f) => ingest([f], { locatePath: r.path })),
          row,
        );
      list.append(row);
    }
    const estimate = await navigator.storage?.estimate?.();
    if (estimate)
      status.textContent = `Browser storage: ${(estimate.usage / 1048576).toFixed(1)} MiB used. Package export provides a portable backup.`;
  }
  function pickOne(fn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = picker.accept;
    input.onchange = () => {
      if (input.files[0])
        Promise.resolve(fn(input.files[0])).catch((e) =>
          notify(e.message, "error"),
        );
    };
    input.click();
  }
  return {
    async open() {
      dialog.showModal();
      await refresh();
    },
    ingest,
    refresh,
  };
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
