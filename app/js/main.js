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
import { listFolder, createFolder, uploadFile, trashItems } from "./api/workdrive.js";
import { friendlyMessage } from "./api/_shared.js";
import * as render from "./ui/render.js";
import { initDropzone, initFilePicker } from "./ui/dropzone.js";

const el = {};
const state = {
  rootId: null,
  rootUrl: null, // the URL stored on the record, for "Open in WorkDrive"
  trail: [], // [{ id, name }] — root first, current folder last
  busy: false,
  items: [], // what's currently listed, so selection can resolve id -> name
  selected: new Set(), // ids ticked in the current folder
};

const currentFolder = () => state.trail[state.trail.length - 1] || null;

function cacheElements() {
  el.crumbs = document.getElementById("crumbs");
  el.btnOpenWd = document.getElementById("btn-open-wd");
  el.btnDelete = document.getElementById("btn-delete");
  el.btnDeleteLabel = document.getElementById("btn-delete-label");
  el.modal = document.getElementById("modal");
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
  el.btnDelete.disabled = busy;
}

function showActions(visible) {
  el.btnNewFolder.hidden = !visible;
  el.btnUpload.hidden = !visible;
  el.btnOpenWd.hidden = !visible;
  // Delete stays hidden regardless — it appears only when something is ticked.
  if (!visible) el.btnDelete.hidden = true;
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
// Selection
// ---------------------------------------------------------------------------

/** The Delete button only exists while something is ticked. */
function updateSelectionUi() {
  const n = state.selected.size;
  el.btnDelete.hidden = n === 0;
  el.btnDeleteLabel.textContent = n > 1 ? `Delete (${n})` : "Delete";
  el.btnDelete.disabled = state.busy;
}

function clearSelection() {
  state.selected.clear();
  updateSelectionUi();
}

function onSelectToggle(checkbox) {
  const id = checkbox.dataset.select;
  if (checkbox.checked) state.selected.add(id);
  else state.selected.delete(id);
  checkbox.closest(".row").classList.toggle("selected", checkbox.checked);
  updateSelectionUi();
}

// ---------------------------------------------------------------------------
// Delete (trash)
// ---------------------------------------------------------------------------

async function onDelete() {
  if (!state.selected.size || state.busy) return;

  // Resolve ids to the actual items so the dialog can name them. Anything no
  // longer in the list (a stale tick after a refresh) is dropped rather than
  // sent blind — never trash an id we can't describe.
  const chosen = state.items.filter((it) => state.selected.has(it.id));
  if (!chosen.length) {
    clearSelection();
    return;
  }

  const confirmed = await render.confirmTrash(el.modal, chosen);
  if (!confirmed) return;

  setBusy(true);
  const res = await trashItems(chosen.map((it) => it.id));
  setBusy(false);

  if (!res.ok) {
    render.renderBanner(el.banner, friendlyMessage(res.reason, res.message));
    return;
  }

  clearSelection();
  refresh();
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

async function openFolder(folderId, name, { push = true } = {}) {
  if (push) state.trail.push({ id: folderId, name });
  render.renderCrumbs(el.crumbs, state.trail);
  updateOpenLink();
  render.clear(el.banner); // don't carry a stale warning into a new folder
  // Ticks refer to items in the folder being left, so they must not survive.
  state.items = [];
  clearSelection();
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

  state.items = res.items;
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
  el.list.addEventListener("change", (e) => {
    if (e.target.matches("[data-select]")) onSelectToggle(e.target);
  });

  el.list.addEventListener("click", (e) => {
    // The checkbox and its label handle themselves; only the name area opens.
    if (e.target.closest(".row-check")) return;
    const opener = e.target.closest(".row-open");
    if (!opener) return;
    const row = opener.closest(".row");
    if (row) onRowActivate(row);
  });

  el.list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const opener = e.target.closest(".row-open");
    if (!opener) return;
    e.preventDefault();
    const row = opener.closest(".row");
    if (row) onRowActivate(row);
  });

  el.btnDelete.addEventListener("click", onDelete);

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
