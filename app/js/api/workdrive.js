/**
 * WorkDrive operations, all routed through the "wd" CRM connection.
 *
 * Endpoints (JSON:API, all require the vnd.api+json headers):
 *   GET  /files/{id}/files   list folder contents
 *   GET  /files/{id}         folder metadata
 *   POST /files              create folder
 *   POST /upload             upload file (transport decided by Phase 0 spike)
 */

import {
  WD_API,
  JSONAPI_HEADERS,
  FOLDER_TYPE,
  MAX_UPLOAD_BYTES,
  PAGE_SIZE,
  MAX_LIST_ITEMS,
} from "../config.js";
import { invoke, parseBody, DEBUG } from "./_shared.js";

/**
 * JSON:API resource -> the flat shape the UI renders.
 *
 * WorkDrive is not consistent about attribute names between endpoints. The
 * list endpoint returns `id` / `name`; the upload endpoint returns
 * `resource_id` / `FileName` (capitalized, and the id lives in attributes
 * rather than on the resource). Accept both rather than assume.
 */
export function toItem(resource) {
  const a = (resource && resource.attributes) || {};
  const isFolder =
    a.is_folder === true ||
    Number(a.resource_type) === FOLDER_TYPE ||
    a.type === "folder";

  return {
    id: resource.id || a.resource_id || null,
    name: a.name || a.FileName || a.display_html_name || a.display_attr_name || "(untitled)",
    isFolder,
    size: Number(a.storage_info && a.storage_info.size_in_bytes) || Number(a.size_in_bytes) || 0,
    modified: a.modified_time_in_millisecond || a.modified_time || null,
    permalink: a.permalink || a.Permalink || null,
  };
}

/**
 * Fetch one page of a folder's contents.
 *
 * Sorted by name so paging is stable. The default sort is last_modified desc,
 * which means an active folder can shift items between pages and you'd both
 * miss and duplicate files.
 */
async function listPage(folderId, offset) {
  return invoke({
    url: `${WD_API}/files/${encodeURIComponent(folderId)}/files`,
    method: "GET",
    param_type: 1,
    headers: JSONAPI_HEADERS,
    parameters: {
      "page[offset]": String(offset),
      "page[limit]": String(PAGE_SIZE),
      sort: "name",
    },
  });
}

/**
 * List a folder, following pagination to the end.
 *
 * WorkDrive caps a page at 50 items and — this is the trap — gives NO signal
 * that it truncated. No meta block, no next cursor, no total count. A 52-file
 * folder returns a bare array of 50 that looks exactly like a complete listing
 * of a 50-file folder. Render that and two files silently cease to exist.
 *
 * So the only termination signal is "got back fewer than we asked for". A
 * folder whose count is an exact multiple of 50 costs one extra request that
 * returns nothing, which is the correct trade for not dropping files.
 */
export async function listFolder(folderId) {
  const all = [];
  let offset = 0;
  let last = null;

  while (offset < MAX_LIST_ITEMS) {
    const res = await listPage(folderId, offset);
    if (!res.ok) {
      // A later page failing is different from the first page failing: we have
      // partial data. Return it flagged rather than throwing it all away.
      if (all.length) return { ...res, ok: true, items: sortItems(all), partial: true };
      return res;
    }
    last = res;

    const data = (res.body && res.body.data) || [];
    const batch = (Array.isArray(data) ? data : [data]).filter(Boolean);
    all.push(...batch.map(toItem));

    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const truncated = offset >= MAX_LIST_ITEMS;
  return { ...(last || { ok: true, status: 200 }), items: sortItems(all), truncated };
}

/** Folders first, then by name. Matches what WorkDrive itself shows. */
function sortItems(items) {
  return items.sort((x, y) => {
    if (x.isFolder !== y.isFolder) return x.isFolder ? -1 : 1;
    return x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
  });
}

export async function getFolderMeta(folderId) {
  const res = await invoke({
    url: `${WD_API}/files/${encodeURIComponent(folderId)}`,
    method: "GET",
    param_type: 1,
    headers: JSONAPI_HEADERS,
  });
  if (!res.ok) return res;
  const a = (res.body && res.body.data && res.body.data.attributes) || {};
  return { ...res, name: a.name || "", parentId: a.parent_id || null };
}

export async function createFolder(parentId, name) {
  const clean = String(name || "").trim();
  if (!clean) return { ok: false, reason: "UNKNOWN", message: "Enter a folder name." };

  // WorkDrive rejects these outright; catching it here gives a better message.
  if (/[\\/:*?"<>|]/.test(clean)) {
    return { ok: false, reason: "UNKNOWN", message: 'A folder name can\'t contain \\ / : * ? " < > |' };
  }

  return invoke({
    url: `${WD_API}/files`,
    method: "POST",
    param_type: 2,
    headers: JSONAPI_HEADERS,
    parameters: { data: { attributes: { name: clean, parent_id: parentId }, type: "files" } },
  });
}

/**
 * Upload transport.
 *
 * SETTLED 2026-09-09 by a live failure, not by guessing: base64 through
 * CONNECTION.invoke does NOT work. The connection layer marshals its payload
 * as application/x-www-form-urlencoded, and a ~1.6MB base64 body was rejected
 * before it ever reached WorkDrive. Worse, the rejection carries no useful
 * detail client-side, so it surfaces as a generic failure.
 *
 * The Deluge task zoho.workdrive.uploadFile handles multipart properly
 * server-side, so uploads route through a CRM Function. Same reasoning that
 * made createFolder work server-side.
 *
 *   "function"  Deluge CRM Function proxy — the working path
 *   "base64"    kept only for A/B testing; known to fail on real files
 */
export const UPLOAD_TRANSPORT = "function";

/** Name of the Deluge function; see deluge/upload_file_to_workdrive.dg */
export const UPLOAD_FUNCTION = "upload_file_to_workdrive";

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

export async function uploadFile(parentId, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    return { ok: false, reason: "TOO_LARGE", message: `Files over ${mb} MB must be added in WorkDrive directly.` };
  }

  let content;
  try {
    content = await readAsBase64(file);
  } catch (err) {
    return { ok: false, reason: "UNKNOWN", message: err.message };
  }

  if (UPLOAD_TRANSPORT === "base64") {
    return invoke({
      url: `${WD_API}/upload`,
      method: "POST",
      param_type: 2,
      parameters: {
        parent_id: parentId,
        filename: file.name,
        content,
        // Surface a name clash instead of silently replacing someone's file.
        "override-name-exist": "false",
      },
    });
  }

  if (UPLOAD_TRANSPORT === "function") {
    return uploadViaFunction(parentId, file, content);
  }

  return { ok: false, reason: "UNKNOWN", message: `Unknown upload transport "${UPLOAD_TRANSPORT}".` };
}

/**
 * Upload via a Deluge CRM Function, which does the multipart POST server-side.
 *
 * The function returns a JSON string; it arrives at details.output, and like
 * everything else in this API it may be a string or already parsed.
 */
async function uploadViaFunction(parentId, file, base64) {
  if (typeof ZOHO === "undefined" || !ZOHO.CRM || !ZOHO.CRM.FUNCTIONS) {
    return { ok: false, reason: "CONNECTION", message: "Zoho SDK unavailable." };
  }

  let resp;
  try {
    resp = await ZOHO.CRM.FUNCTIONS.execute(UPLOAD_FUNCTION, {
      arguments: JSON.stringify({
        folderIdStr: parentId,
        fileNameStr: file.name,
        fileContentStr: base64,
      }),
    });
  } catch (err) {
    console.warn("[wd] function execute threw", err);
    return { ok: false, reason: "UNKNOWN", message: String((err && err.message) || err) };
  }

  if (DEBUG()) console.log("[wd] function raw response", resp);

  const output = resp && resp.details && resp.details.output;
  const parsed = parseBody(output);

  if (!parsed) {
    console.warn("[wd] function returned no parseable output", resp);

    // A function that isn't deployed yet is the most likely cause the first
    // time this runs, and the generic message would hide it.
    const looksMissing =
      JSON.stringify(resp || {}).toLowerCase().includes("not exist") ||
      (resp && resp.code === "invalid_data");

    return {
      ok: false,
      reason: "UNKNOWN",
      message: looksMissing
        ? `The "${UPLOAD_FUNCTION}" function isn't set up in CRM yet. Uploads need it — see deluge/upload_file_to_workdrive.dg.`
        : "The upload function returned nothing usable.",
      raw: resp,
    };
  }

  if (parsed.status === "SUCCESS") {
    return { ok: true, status: 200, body: parsed, raw: resp };
  }

  console.warn("[wd] function reported failure", parsed);
  return {
    ok: false,
    reason: "UNKNOWN",
    message: parsed.message || "Upload failed.",
    raw: resp,
  };
}
