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
import { listFolder, createFolder, uploadFile, trashItems, downloadUrlFor } from "./api/workdrive.js";
import { friendlyMessage } from "./api/_shared.js";
import * as render from "./ui/render.js";
import { initDropzone, initFilePicker } from "./ui/dropzone.js";

const el = {};
const state = {
  rootId: null,
  rootUrl: null, // the URL stored on the record, for "Open in WorkDrive"
  trail: [], // [{ id, name }] — root first, current folder last
  busy: false,
  items: [], // everything in the current folder, as fetched
  selected: new Set(), // ids ticked in the current folder
  sortKey: "name", // name | size | modified
  sortDir: "asc",
  query: "", // search text; filters the current folder only
};

const currentFolder = () => state.trail[state.trail.length - 1] || null;

function cacheElements() {
  el.crumbs = document.getElementById("crumbs");
  el.btnOpenWd = document.getElementById("btn-open-wd");
  el.btnDelete = document.getElementById("btn-delete");
  el.btnDeleteLabel = document.getElementById("btn-delete-label");
  el.btnDownload = document.getElementById("btn-download");
  el.btnDownloadLabel = document.getElementById("btn-download-label");
  el.modal = document.getElementById("modal");
  el.listhead = document.getElementById("listhead");
  el.btnSearch = document.getElementById("btn-search");
  el.searchInput = document.getElementById("search-input");
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
  el.btnDownload.disabled = busy;
}

function showActions(visible) {
  el.btnNewFolder.hidden = !visible;
  el.btnUpload.hidden = !visible;
  el.btnOpenWd.hidden = !visible;
  el.btnSearch.hidden = !visible;
  if (!visible) {
    el.searchInput.hidden = true;
    el.listhead.hidden = true;
  }
  // Delete is never shown by this function. Its visibility is owned solely by
  // updateSelectionUi(), which derives it from the selection — so call that
  // rather than setting `hidden` here, and the two can never disagree.
  updateSelectionUi();
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
// Sorting and search
//
// Both operate on what's already loaded, in memory. The folder is fully paged
// in before rendering, so filtering client-side is honest — it can't hide
// matches that live on an unfetched page.
// ---------------------------------------------------------------------------

/** Items after the search filter, in the current sort order. */
function visibleItems() {
  const q = state.query.trim().toLowerCase();
  const filtered = q
    ? state.items.filter((it) => it.name.toLowerCase().includes(q))
    : state.items.slice();

  const dir = state.sortDir === "desc" ? -1 : 1;

  return filtered.sort((a, b) => {
    // Folders always lead, whatever the sort — they're containers, not peers,
    // and mixing them into a size sort just makes the list harder to scan.
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

    let cmp = 0;
    if (state.sortKey === "size") cmp = (a.size || 0) - (b.size || 0);
    else if (state.sortKey === "modified") cmp = (Number(a.modified) || 0) - (Number(b.modified) || 0);
    else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

    // Fall back to name so equal values (folders have no size) stay stable.
    if (cmp === 0 && state.sortKey !== "name") {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      return cmp; // secondary sort is always ascending
    }
    return cmp * dir;
  });
}

/** Re-render the list from state, without refetching. */
function renderCurrent() {
  const items = visibleItems();
  render.renderList(el.list, items, {
    emptyBecauseFiltered: state.items.length > 0 && items.length === 0,
    query: state.query,
  });
  render.markSort(el.listhead, state.sortKey, state.sortDir);
  el.listhead.hidden = state.items.length === 0;

  // A tick can survive a filter that hides its row; drop those so the toolbar
  // count never claims more than is visible.
  let changed = false;
  for (const id of [...state.selected]) {
    if (!items.some((it) => it.id === id)) {
      state.selected.delete(id);
      changed = true;
    }
  }
  restoreChecks();
  if (changed) updateSelectionUi();
}

/** Re-tick boxes after a re-render, since renderList rebuilds the DOM. */
function restoreChecks() {
  if (!state.selected.size) return;
  for (const box of el.list.querySelectorAll("[data-select]")) {
    if (state.selected.has(box.dataset.select)) {
      box.checked = true;
      box.closest(".row").classList.add("selected");
    }
  }
}

function onSort(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    // Dates and sizes are most useful largest/newest first; names A-Z.
    state.sortDir = key === "name" ? "asc" : "desc";
  }
  renderCurrent();
}

function toggleSearch(show) {
  el.searchInput.hidden = !show;
  el.btnSearch.classList.toggle("active", show);
  if (show) {
    el.searchInput.focus();
  } else if (state.query) {
    state.query = "";
    el.searchInput.value = "";
    renderCurrent();
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Delete and Download only exist while something is ticked. */
function updateSelectionUi() {
  const n = state.selected.size;
  el.btnDelete.hidden = n === 0;
  el.btnDeleteLabel.textContent = n > 1 ? `Delete (${n})` : "Delete";
  el.btnDelete.disabled = state.busy;

  // Folders can't be downloaded directly, so the button counts only files and
  // hides when a selection is folders-only.
  const files = selectedFiles();
  el.btnDownload.hidden = files.length === 0;
  el.btnDownloadLabel.textContent = files.length > 1 ? `Download (${files.length})` : "Download";
  el.btnDownload.disabled = state.busy;
}

/** Ticked items that are actually downloadable files. */
function selectedFiles() {
  return state.items.filter((it) => state.selected.has(it.id) && !it.isFolder);
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
// Download
// ---------------------------------------------------------------------------

/**
 * Download every ticked file.
 *
 * Each file is its own hidden <a download> click. Browsers rate-limit rapid
 * programmatic downloads and some will silently drop all but the first, so
 * they're spaced out — slower, but every file actually arrives.
 *
 * No zip: WorkDrive's zip endpoint is asynchronous (it returns a job key you
 * then poll), which is a lot of moving parts for something the browser can do
 * directly. Revisit if people routinely grab dozens at once.
 */
async function onDownload() {
  const files = selectedFiles();
  if (!files.length || state.busy) return;

  // Chrome asks permission for multi-file downloads; warn so a blocked prompt
  // isn't mistaken for a broken button.
  if (files.length > 1) {
    render.renderBanner(
      el.banner,
      `Downloading ${files.length} files. Your browser may ask permission to download multiple files.`,
      "info"
    );
  }

  for (const [i, file] of files.entries()) {
    triggerDownload(file);
    if (i < files.length - 1) await sleep(400);
  }
}

function triggerDownload(file) {
  const a = document.createElement("a");
  a.href = file.downloadUrl || downloadUrlFor(file.id);
  a.download = file.name; // hint only; cross-origin the server's name wins
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // Ticks and the search term refer to the folder being left, so neither
  // survives the move. Sort order does — it's a preference, not folder state.
  state.items = [];
  state.query = "";
  el.searchInput.value = "";
  clearSelection();
  el.listhead.hidden = true;
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
  renderCurrent();

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
    // The checkbox and the download link handle themselves; only the name
    // area opens the item.
    if (e.target.closest(".row-check") || e.target.closest(".row-dl")) return;
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
  el.btnDownload.addEventListener("click", onDownload);

  el.listhead.addEventListener("click", (e) => {
    const col = e.target.closest("[data-sort]");
    if (col) onSort(col.dataset.sort);
  });

  el.btnSearch.addEventListener("click", () => toggleSearch(el.searchInput.hidden));

  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value;
    renderCurrent();
  });

  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggleSearch(false);
  });

  // Collapse an empty search box on blur so the toolbar returns to normal.
  el.searchInput.addEventListener("blur", () => {
    if (!el.searchInput.value.trim()) toggleSearch(false);
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
  // Nothing can be selected before a folder has loaded, so assert the Delete
  // button's hidden state from the selection rather than trusting the markup.
  clearSelection();
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
