/**
 * Entry point. Boots the SDK, reads the host record's folder ID, and drives
 * the browse / create / upload loop.
 *
 * Nothing here is tied to a particular module: the module name arrives with
 * PageLoad, so the same deployed files serve every module the widget is
 * placed on, provided the record carries the WorkDrive URL field.
 */

import { DEFAULT_MODULE, wdFolderUrl } from "./config.js";
import { getRecordFolder, normalizeEntityId } from "./api/crm.js";
import { listFolder, createFolder, uploadFile } from "./api/workdrive.js";
import { friendlyMessage } from "./api/_shared.js";
import * as render from "./ui/render.js";
import { initDropzone, initFilePicker } from "./ui/dropzone.js";

const el = {};
const state = {
  rootId: null,
  rootUrl: null, // the URL stored on the record, for "Open in WorkDrive"
  trail: [], // [{ id, name }] — root first, current folder last
  busy: false,
};

const currentFolder = () => state.trail[state.trail.length - 1] || null;

function cacheElements() {
  el.crumbs = document.getElementById("crumbs");
  el.btnOpenWd = document.getElementById("btn-open-wd");
  el.list = document.getElementById("list");
  el.banner = document.getElementById("banner");
  el.uploads = document.getElementById("uploads");
  el.newFolderBar = document.getElementById("newfolder");
  el.btnNewFolder = document.getElementById("btn-new-folder");
  el.btnUpload = document.getElementById("btn-upload");
  el.fileInput = document.getElementById("file-input");
  el.dropzone = document.getElementById("dropzone");
}

function setBusy(busy) {
  state.busy = busy;
  el.btnNewFolder.disabled = busy;
  el.btnUpload.disabled = busy;
}

function showActions(visible) {
  el.btnNewFolder.hidden = !visible;
  el.btnUpload.hidden = !visible;
  el.btnOpenWd.hidden = !visible;
}

/**
 * Point "Open in WorkDrive" at the folder currently being viewed, so it
 * follows you into subfolders rather than always going back to the root.
 * At the root, prefer the URL stored on the record — it's known to work.
 */
function updateOpenLink() {
  const cur = currentFolder();
  if (!cur) return;
  const atRoot = cur.id === state.rootId;
  el.btnOpenWd.href = atRoot && state.rootUrl ? state.rootUrl : wdFolderUrl(cur.id);
  el.btnOpenWd.title = `Open "${cur.name}" in WorkDrive`;
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

async function openFolder(folderId, name, { push = true } = {}) {
  if (push) state.trail.push({ id: folderId, name });
  render.renderCrumbs(el.crumbs, state.trail);
  updateOpenLink();
  render.clear(el.banner); // don't carry a stale warning into a new folder
  render.renderLoading(el.list);
  setBusy(true);

  const res = await listFolder(folderId);
  setBusy(false);

  if (!res.ok) {
    // Link to the record's own URL when we're at the root; deeper in, build
    // one from the folder we failed to open.
    const link = folderId === state.rootId && state.rootUrl ? state.rootUrl : folderId;
    render.renderError(
      el.list,
      titleFor(res.reason),
      friendlyMessage(res.reason, res.message),
      link,
      // An unrecognized envelope is a bug in this widget, not a user problem.
      // Show the raw response so it can be diagnosed without a rebuild.
      res.reason === "UNKNOWN" ? res.raw : null
    );
    return;
  }

  render.renderList(el.list, res.items);

  // Never show a partial listing as if it were complete — that's the whole
  // point of paginating. Say so, and offer the full folder in WorkDrive.
  if (res.partial) {
    render.renderBanner(
      el.banner,
      `Showing the first ${res.items.length} items — the rest couldn't be loaded. Open the folder in WorkDrive to see everything.`
    );
  } else if (res.truncated) {
    render.renderBanner(
      el.banner,
      `This folder has more than ${res.items.length} items. Open it in WorkDrive to see them all.`
    );
  }
}

function titleFor(reason) {
  switch (reason) {
    case "DENIED": return "No access to this folder";
    case "NOT_FOUND": return "Folder not found";
    case "CONNECTION": return "Couldn't reach WorkDrive";
    default: return "Couldn't load this folder";
  }
}

function refresh() {
  const cur = currentFolder();
  if (cur) openFolder(cur.id, cur.name, { push: false });
}

function onRowActivate(row) {
  const id = row.dataset.id;
  const isFolder = row.dataset.folder === "1";
  const name = row.dataset.name;

  if (isFolder) {
    openFolder(id, name);
  } else {
    // Files open in WorkDrive; the widget is a browser, not a viewer.
    window.open(render.wdFileUrl(id), "_blank", "noopener");
  }
}

// ---------------------------------------------------------------------------
// Create folder
// ---------------------------------------------------------------------------

function openNewFolderForm() {
  el.newFolderBar.innerHTML = `
    <div class="newfolder">
      <input type="text" id="nf-name" placeholder="New folder name" maxlength="120" autocomplete="off">
      <button class="btn primary" type="button" id="nf-create">Create</button>
      <button class="btn" type="button" id="nf-cancel">Cancel</button>
    </div>`;

  const input = document.getElementById("nf-name");
  const close = () => { el.newFolderBar.innerHTML = ""; };

  input.focus();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") close();
  });
  document.getElementById("nf-cancel").addEventListener("click", close);
  document.getElementById("nf-create").addEventListener("click", submit);

  async function submit() {
    const name = input.value.trim();
    if (!name) return;

    const parent = currentFolder();
    setBusy(true);
    const res = await createFolder(parent.id, name);
    setBusy(false);

    if (!res.ok) {
      render.renderBanner(el.banner, friendlyMessage(res.reason, res.message));
      return;
    }
    close();
    refresh();
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function handleFiles(files) {
  const parent = currentFolder();
  if (!parent || state.busy) return;

  // Sequential, not parallel: one failure shouldn't take down the batch, and
  // the connection layer is not a high-throughput path.
  el.uploads.innerHTML = '<div class="uploads"></div>';
  const box = el.uploads.firstElementChild;
  setBusy(true);

  let failures = 0;

  for (const file of files) {
    const row = document.createElement("div");
    row.className = "upload-row";
    row.innerHTML = `
      <span class="upload-name">${render.esc(file.name)}</span>
      <span class="upload-status">Uploading…</span>`;
    box.appendChild(row);

    const res = await uploadFile(parent.id, file);
    const status = row.querySelector(".upload-status");

    if (res.ok) {
      row.classList.add("done");
      status.textContent = "Added";
    } else {
      failures++;
      row.classList.add("failed");
      status.textContent = friendlyMessage(res.reason, res.message);
    }
  }

  setBusy(false);
  refresh();

  // Clear the successful rows shortly after; leave failures on screen.
  if (!failures) {
    setTimeout(() => { el.uploads.innerHTML = ""; }, 2500);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start(data) {
  // Entity is whatever module hosts this placement. Fall back only if CRM
  // sends nothing, which means the placement itself is misconfigured.
  const entity = (data && data.Entity) || DEFAULT_MODULE;
  const recordId = normalizeEntityId(data && data.EntityId);

  if (!recordId) {
    render.renderError(el.list, "No record context", "The widget didn't receive a record to read.");
    return;
  }

  render.renderLoading(el.list, "Reading record…");

  const rec = await getRecordFolder(entity, recordId);

  if (!rec.ok) {
    showActions(false);
    // Even when the folder can't be read, a stored URL is still worth
    // offering — the user can go straight to WorkDrive.
    if (rec.raw || rec.sourceUrl) {
      const href = rec.sourceUrl || (rec.raw && /^https?:\/\//i.test(rec.raw) ? rec.raw : null);
      if (href) {
        el.btnOpenWd.href = href;
        el.btnOpenWd.hidden = false;
      }
    }
    if (rec.reason === "NO_FOLDER") {
      render.renderNoFolder(el.list);
    } else if (rec.reason === "BAD_FOLDER_ID") {
      render.renderError(el.list, "That folder ID doesn't look right", `Stored value: ${rec.raw}`);
    } else if (rec.reason === "NO_SDK") {
      render.renderError(el.list, "Zoho SDK unavailable", "The widget couldn't load Zoho's JS SDK.");
    } else {
      render.renderError(el.list, "Couldn't read this record", rec.message || "");
    }
    return;
  }

  state.rootId = rec.folderId;
  state.rootUrl = rec.sourceUrl || null;
  showActions(true);
  await openFolder(rec.folderId, rec.recordName || "Files");
}

function wireEvents() {
  el.list.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) onRowActivate(row);
  });

  el.list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".row");
    if (row) { e.preventDefault(); onRowActivate(row); }
  });

  el.crumbs.addEventListener("click", (e) => {
    const crumb = e.target.closest(".crumb");
    if (!crumb || crumb.disabled) return;
    const depth = Number(crumb.dataset.depth);
    state.trail = state.trail.slice(0, depth + 1);
    const target = currentFolder();
    openFolder(target.id, target.name, { push: false });
  });

  el.btnNewFolder.addEventListener("click", openNewFolderForm);
  el.btnUpload.addEventListener("click", () => el.fileInput.click());

  initFilePicker(el.fileInput, handleFiles);
  initDropzone(el.dropzone, handleFiles);
}

function boot() {
  cacheElements();
  wireEvents();
  showActions(false);

  if (typeof ZOHO === "undefined" || !ZOHO.embeddedApp) {
    render.renderError(
      el.list,
      "Zoho SDK failed to load",
      "The widget couldn't reach Zoho's JS SDK. Check the network and that this page is served over HTTPS."
    );
    return;
  }

  render.renderLoading(el.list, "Connecting to Zoho…");

  // PageLoad only fires inside a CRM-hosted iframe. Opened directly in a tab
  // it never arrives, and without this the panel just stays blank forever —
  // which reads as a broken widget rather than the wrong context.
  let loaded = false;
  const timer = setTimeout(() => {
    if (loaded) return;
    render.renderError(
      el.list,
      "No CRM context",
      "This widget has to run inside a Zoho CRM record page. Opened on its own, there's no record to read."
    );
  }, 6000);

  ZOHO.embeddedApp.on("PageLoad", (data) => {
    loaded = true;
    clearTimeout(timer);
    start(data);
  });

  ZOHO.embeddedApp.init();
}

document.addEventListener("DOMContentLoaded", boot);
