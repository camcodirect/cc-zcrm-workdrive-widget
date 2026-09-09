/**
 * All DOM writing lives here. Every terminal state offers an "Open in
 * WorkDrive" escape hatch, so the widget is never a dead end.
 */

import { wdFolderUrl, wdFileUrl, FIELD } from "../config.js";

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H2v16h20V6H12l-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 4H2v16h20V6H12l-2-2z"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/></svg>',
  newFolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4H2v16h20V6H12l-2-2z"/><path d="M12 11v6M9 14h6"/></svg>',
};

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function formatDate(value) {
  if (!value) return "";
  const ms = typeof value === "number" ? value : Number(value);
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : value);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Prefer the URL stored on the record — it's known to work. Fall back to one
 * built from the folder ID.
 */
function openLink(idOrUrl, label) {
  const href = /^https?:\/\//i.test(String(idOrUrl)) ? String(idOrUrl) : wdFolderUrl(idOrUrl);
  return `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">
      ${ICONS.link}<span>${esc(label || "Open in WorkDrive")}</span>
    </a>`;
}

/** The list body: the rows themselves. */
export function renderList(container, items) {
  if (!items.length) {
    container.innerHTML = `
      <div class="state">
        <div class="state-icon">${ICONS.empty}</div>
        <div class="state-title">This folder is empty</div>
        <div class="state-detail">Drag files here, or use Upload above.</div>
      </div>`;
    return;
  }

  container.innerHTML = items
    .map(
      (it) => `
      <div class="row" role="button" tabindex="0"
           data-id="${esc(it.id)}"
           data-folder="${it.isFolder ? "1" : "0"}"
           data-name="${esc(it.name)}"
           title="${esc(it.name)}">
        <span class="row-icon ${it.isFolder ? "folder" : ""}">${it.isFolder ? ICONS.folder : ICONS.file}</span>
        <span class="row-name">${esc(it.name)}</span>
        <span class="row-meta row-size">${it.isFolder ? "" : esc(formatSize(it.size))}</span>
        <span class="row-meta row-date">${esc(formatDate(it.modified))}</span>
      </div>`
    )
    .join("");
}

export function renderLoading(container, label) {
  container.innerHTML = `
    <div class="state">
      <div class="spinner"></div>
      <div class="state-detail">${esc(label || "Loading files…")}</div>
    </div>`;
}

/** No folder on the record: guidance, not an error. */
export function renderNoFolder(container) {
  container.innerHTML = `
    <div class="state">
      <div class="state-icon">${ICONS.empty}</div>
      <div class="state-title">No WorkDrive folder linked</div>
      <div class="state-detail">
        Paste the folder's WorkDrive address into the <code>${esc(FIELD)}</code>
        field on this record, then reload.
      </div>
    </div>`;
}

export function renderError(container, title, detail, folderId, rawResponse) {
  let diagnostics = "";
  if (rawResponse) {
    let dump;
    try {
      dump = JSON.stringify(rawResponse, null, 2);
    } catch {
      dump = String(rawResponse);
    }
    diagnostics = `
      <details class="diag">
        <summary>Technical details</summary>
        <pre>${esc(dump.slice(0, 4000))}</pre>
      </details>`;
  }

  container.innerHTML = `
    <div class="state error">
      <div class="state-icon">${ICONS.warn}</div>
      <div class="state-title">${esc(title)}</div>
      ${detail ? `<div class="state-detail">${esc(detail)}</div>` : ""}
      ${folderId ? openLink(folderId) : ""}
      ${diagnostics}
    </div>`;
}

/** Breadcrumb trail. The last entry is the current folder. */
export function renderCrumbs(container, trail) {
  container.innerHTML = trail
    .map((node, i) => {
      const last = i === trail.length - 1;
      const sep = i > 0 ? '<span class="crumb-sep">/</span>' : "";
      return `${sep}<button class="crumb ${last ? "current" : ""}" data-depth="${i}"
        ${last ? "disabled" : ""} title="${esc(node.name)}">${esc(node.name)}</button>`;
    })
    .join("");
}

export function renderBanner(container, message) {
  container.innerHTML = `
    <div class="banner">
      <span>${esc(message)}</span>
      <button type="button" data-dismiss aria-label="Dismiss">&times;</button>
    </div>`;
  container.querySelector("[data-dismiss]").addEventListener("click", () => {
    container.innerHTML = "";
  });
}

export function clear(container) {
  container.innerHTML = "";
}

export { ICONS, wdFileUrl };
