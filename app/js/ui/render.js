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

// ---------------------------------------------------------------------------
// File-type icons
//
// All built on the same page-with-a-folded-corner silhouette so the set reads
// as one family; only the fill colour and the glyph inside change. Images and
// media get a distinct shape instead, because for those the content matters
// more than the fact that it's a file.
// ---------------------------------------------------------------------------

/** Extension -> icon kind. Anything unlisted falls back to a generic page. */
const EXT_KIND = {
  // documents
  doc: "doc", docx: "doc", odt: "doc", rtf: "doc", pages: "doc",
  txt: "text", md: "text", log: "text", rtfd: "text",
  pdf: "pdf",
  // spreadsheets
  xls: "sheet", xlsx: "sheet", csv: "sheet", tsv: "sheet", ods: "sheet", numbers: "sheet",
  // presentations
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides",
  // images
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image",
  webp: "image", heic: "image", heif: "image", tif: "image", tiff: "image",
  svg: "image", ico: "image", avif: "image",
  // video / audio
  mp4: "video", mov: "video", avi: "video", mkv: "video", webm: "video", wmv: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  // archives
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", bz2: "archive",
  // code / data
  js: "code", mjs: "code", ts: "code", jsx: "code", tsx: "code", html: "code", htm: "code",
  css: "code", py: "code", java: "code", rb: "code", php: "code", go: "code", rs: "code",
  c: "code", cpp: "code", h: "code", sh: "code", dg: "code",
  json: "data", xml: "data", yml: "data", yaml: "data", sql: "data",
  // cad / 3d — common in job folders
  stl: "model", obj: "model", "3mf": "model", step: "model", stp: "model",
  dwg: "model", dxf: "model", skp: "model", f3d: "model",
};

/** The page silhouette every document-ish icon shares. */
const PAGE = 'M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z';
const FOLD = 'M13 2v7h7';

/** A page icon with a short type label across the middle. */
function pageIcon(color, label) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="${PAGE}" fill="${color}" opacity=".14"/>
    <path d="${PAGE}" fill="none" stroke="${color}" stroke-width="1.6"
          stroke-linejoin="round"/>
    <path d="${FOLD}" fill="none" stroke="${color}" stroke-width="1.6"
          stroke-linejoin="round"/>
    <text x="12" y="17.6" text-anchor="middle" font-size="6.2"
          font-family="system-ui, -apple-system, sans-serif" font-weight="700"
          fill="${color}" letter-spacing="-.2">${label}</text>
  </svg>`;
}

/** A page icon with lines on it, for plain text. */
function linedPageIcon(color) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="${PAGE}" fill="${color}" opacity=".12"/>
    <path d="${PAGE}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="${FOLD}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M8 13h8M8 16h8M8 10h3" stroke="${color}" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

const TYPE_COLORS = {
  doc: "#2b6cb0",
  text: "#667085",
  pdf: "#c0392b",
  sheet: "#1a7f4b",
  slides: "#c2410c",
  image: "#7c3aed",
  video: "#be185d",
  audio: "#0e7490",
  archive: "#a16207",
  code: "#334155",
  data: "#475569",
  model: "#0f766e",
  generic: "#98a2b3",
};

const FILE_ICONS = {
  doc: pageIcon(TYPE_COLORS.doc, "DOC"),
  text: linedPageIcon(TYPE_COLORS.text),
  pdf: pageIcon(TYPE_COLORS.pdf, "PDF"),
  sheet: pageIcon(TYPE_COLORS.sheet, "XLS"),
  slides: pageIcon(TYPE_COLORS.slides, "PPT"),
  code: pageIcon(TYPE_COLORS.code, "&lt;/&gt;"),
  data: pageIcon(TYPE_COLORS.data, "{ }"),

  // A framed picture with a horizon and sun — reads at 18px better than a
  // page would, and instantly says "image".
  image: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" fill="${TYPE_COLORS.image}" opacity=".14"/>
    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="${TYPE_COLORS.image}" stroke-width="1.6"/>
    <circle cx="8.5" cy="9.5" r="1.6" fill="${TYPE_COLORS.image}"/>
    <path d="M4 17l4.5-4.5a1.5 1.5 0 012 0L15 17M14 14l1.8-1.8a1.5 1.5 0 012 0L20 14.5"
          fill="none" stroke="${TYPE_COLORS.image}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  video: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" fill="${TYPE_COLORS.video}" opacity=".14"/>
    <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="${TYPE_COLORS.video}" stroke-width="1.6"/>
    <path d="M10.5 9.5l4.5 2.5-4.5 2.5z" fill="${TYPE_COLORS.video}"/>
  </svg>`,

  audio: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 17V6l10-2v11" fill="none" stroke="${TYPE_COLORS.audio}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="7" cy="17.5" r="2.5" fill="${TYPE_COLORS.audio}" opacity=".25"/>
    <circle cx="7" cy="17.5" r="2.5" fill="none" stroke="${TYPE_COLORS.audio}" stroke-width="1.6"/>
    <circle cx="17" cy="15.5" r="2.5" fill="${TYPE_COLORS.audio}" opacity=".25"/>
    <circle cx="17" cy="15.5" r="2.5" fill="none" stroke="${TYPE_COLORS.audio}" stroke-width="1.6"/>
  </svg>`,

  archive: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="${PAGE}" fill="${TYPE_COLORS.archive}" opacity=".14"/>
    <path d="${PAGE}" fill="none" stroke="${TYPE_COLORS.archive}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="${FOLD}" fill="none" stroke="${TYPE_COLORS.archive}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M9 5h2M9 8h2M9 11h2M9 14h2" stroke="${TYPE_COLORS.archive}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,

  // A cube, for CAD and 3D files — common enough in job folders to deserve one.
  model: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" fill="${TYPE_COLORS.model}" opacity=".14"/>
    <path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" fill="none" stroke="${TYPE_COLORS.model}"
          stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M4 7.2l8 4.4 8-4.4M12 11.6V21" fill="none" stroke="${TYPE_COLORS.model}"
          stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,

  generic: `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="${PAGE}" fill="${TYPE_COLORS.generic}" opacity=".16"/>
    <path d="${PAGE}" fill="none" stroke="${TYPE_COLORS.generic}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="${FOLD}" fill="none" stroke="${TYPE_COLORS.generic}" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`,
};

/** Filled folder, so it stands apart from every file icon at a glance. */
const FOLDER_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M3 6.5A1.5 1.5 0 014.5 5h4.6a1.5 1.5 0 011.06.44L11.5 6.5h8A1.5 1.5 0 0121 8v10a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z"
        fill="#eab308" opacity=".22"/>
  <path d="M3 6.5A1.5 1.5 0 014.5 5h4.6a1.5 1.5 0 011.06.44L11.5 6.5h8A1.5 1.5 0 0121 8v10a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z"
        fill="none" stroke="#ca8a04" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M3 9.5h18" stroke="#ca8a04" stroke-width="1.4"/>
</svg>`;

/** Lowercased extension, or "" when there isn't one. */
export function fileExtension(name) {
  const clean = String(name || "").trim();
  const dot = clean.lastIndexOf(".");
  // A leading dot means a hidden file (".gitignore"), not an extension.
  if (dot <= 0 || dot === clean.length - 1) return "";
  return clean.slice(dot + 1).toLowerCase();
}

/** Which icon a name maps to. Exported so it can be tested directly. */
export function iconKind(name, isFolder) {
  if (isFolder) return "folder";
  return EXT_KIND[fileExtension(name)] || "generic";
}

function iconFor(name, isFolder) {
  if (isFolder) return FOLDER_ICON;
  return FILE_ICONS[iconKind(name, false)] || FILE_ICONS.generic;
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
      <div class="row"
           data-id="${esc(it.id)}"
           data-folder="${it.isFolder ? "1" : "0"}"
           data-name="${esc(it.name)}">
        <label class="row-check" title="Select">
          <input type="checkbox" data-select="${esc(it.id)}" aria-label="Select ${esc(it.name)}">
        </label>
        <span class="row-open" role="button" tabindex="0" title="${esc(it.name)}">
          <span class="row-icon ${it.isFolder ? "folder" : ""}">${iconFor(it.name, it.isFolder)}</span>
          <span class="row-name">${esc(it.name)}</span>
        </span>
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

/**
 * Confirmation before trashing. Names the items rather than saying "3 items",
 * so it's possible to notice the wrong thing is selected before confirming.
 * Resolves true on confirm, false on cancel or Escape.
 */
export function confirmTrash(container, items) {
  return new Promise((resolve) => {
    const names = items
      .slice(0, 5)
      .map((i) => `<li>${i.isFolder ? "📁 " : ""}${esc(i.name)}</li>`)
      .join("");
    const more = items.length > 5 ? `<li class="more">and ${items.length - 5} more…</li>` : "";
    const hasFolder = items.some((i) => i.isFolder);

    container.innerHTML = `
      <div class="confirm-backdrop">
        <div class="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="confirm-title" id="confirm-title">
            Move ${items.length === 1 ? "this item" : `these ${items.length} items`} to WorkDrive trash?
          </div>
          <ul class="confirm-list">${names}${more}</ul>
          ${hasFolder ? '<div class="confirm-warn">Folders are removed with everything inside them.</div>' : ""}
          <div class="confirm-note">You can restore items from Trash in WorkDrive.</div>
          <div class="confirm-actions">
            <button class="btn" type="button" data-cancel>Cancel</button>
            <button class="btn danger" type="button" data-confirm>Move to trash</button>
          </div>
        </div>
      </div>`;

    const done = (result) => {
      document.removeEventListener("keydown", onKey);
      container.innerHTML = "";
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
    };

    document.addEventListener("keydown", onKey);
    container.querySelector("[data-cancel]").addEventListener("click", () => done(false));
    container.querySelector("[data-confirm]").addEventListener("click", () => done(true));
    // Clicking the backdrop cancels; clicking the dialog itself must not.
    container.querySelector(".confirm-backdrop").addEventListener("click", (e) => {
      if (e.target.classList.contains("confirm-backdrop")) done(false);
    });
    // Focus Cancel, not the destructive button.
    container.querySelector("[data-cancel]").focus();
  });
}

export { ICONS, wdFileUrl };
