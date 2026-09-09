/**
 * Reading the host record. The only thing the widget needs from CRM is the
 * WorkDrive folder ID, which makes this layer module-agnostic: any module
 * carrying the WorkDrive URL field works, and the module name arrives at
 * runtime from PageLoad rather than being compiled in.
 */

import { FIELD, FALLBACK_FIELD, NAME_FIELDS } from "../config.js";

/**
 * PageLoad hands back EntityId as a bare string in some widget placements and
 * a single-element array in others. Normalize at the boundary or you end up
 * calling getRecord with RecordID=["123"], which fails confusingly.
 */
export function normalizeEntityId(raw) {
  if (Array.isArray(raw)) return raw.length ? String(raw[0]) : null;
  return raw == null ? null : String(raw);
}

/**
 * Accepts either a bare folder ID or a full WorkDrive URL and returns the ID.
 * Keeps working for records still holding a legacy URL value.
 */
export function extractFolderId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (!/^https?:\/\//i.test(trimmed)) {
    // Already an ID. Reject anything with path separators or whitespace.
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
  }

  // Full URL: take the last non-empty path segment, minus any query or hash.
  const withoutQuery = trimmed.split(/[?#]/)[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && /^[A-Za-z0-9_-]+$/.test(last) ? last : null;
}

/**
 * Find a record's display name without knowing which module it came from.
 * Modules disagree on the primary field, so try the known ones in order and
 * fall back to empty — the name is cosmetic (it labels the root breadcrumb),
 * so an unrecognized module degrades rather than fails.
 */
export function recordName(record) {
  if (!record) return "";
  for (const field of NAME_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Read the WorkDrive folder off any CRM record.
 *
 * @param {string} entity   module API name, from PageLoad's Entity
 * @param {string} recordId record id, from PageLoad's EntityId
 * @returns {Promise<{ok, folderId, recordName, reason}>}
 */
export async function getRecordFolder(entity, recordId) {
  if (typeof ZOHO === "undefined" || !ZOHO.CRM || !ZOHO.CRM.API) {
    return { ok: false, reason: "NO_SDK" };
  }

  let resp;
  try {
    resp = await ZOHO.CRM.API.getRecord({ Entity: entity, RecordID: recordId });
  } catch (err) {
    return { ok: false, reason: "FETCH_FAILED", message: String((err && err.message) || err) };
  }

  const record = resp && resp.data && resp.data[0];
  if (!record) return { ok: false, reason: "FETCH_FAILED" };

  const raw = record[FIELD] || record[FALLBACK_FIELD];
  const name = recordName(record);

  if (!raw) return { ok: false, reason: "NO_FOLDER", recordName: name };

  // Keep the stored URL when there is one: it's a known-good human link, which
  // beats a reconstructed one for the "Open in WorkDrive" escape hatch. Return
  // it on failure paths too, so an unparseable value can still be opened.
  const sourceUrl = /^https?:\/\//i.test(String(raw).trim()) ? String(raw).trim() : null;

  const folderId = extractFolderId(raw);
  if (!folderId) return { ok: false, reason: "BAD_FOLDER_ID", recordName: name, raw, sourceUrl };

  return { ok: true, folderId, recordName: name, sourceUrl };
}
