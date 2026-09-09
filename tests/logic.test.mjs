/**
 * Tests for the pure logic: ID extraction, envelope unwrapping, formatting.
 * Everything else needs a live CRM iframe.
 *
 *   node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractFolderId, normalizeEntityId, recordName } from "../app/js/api/crm.js";
import { parseBody, unwrap } from "../app/js/api/_shared.js";
import { toItem } from "../app/js/api/workdrive.js";
import { TRASH_STATUS } from "../app/js/config.js";
import { formatSize, formatDate, esc } from "../app/js/ui/render.js";

const ID = "kj2n4a880e2a09bcf4641b2ef7c60e81b7b2f";

test("extractFolderId: bare id passes through", () => {
  assert.equal(extractFolderId(ID), ID);
});

test("extractFolderId: full workdrive folder url", () => {
  assert.equal(extractFolderId(`https://workdrive.zoho.com/home/team/ws/wsid/folders/${ID}`), ID);
});

test("extractFolderId: external and embed urls", () => {
  assert.equal(extractFolderId(`https://workdrive.zohoexternal.com/folder/${ID}`), ID);
  assert.equal(extractFolderId(`https://workdrive.zohoexternal.com/embed/${ID}?toolbar=true`), ID);
});

test("extractFolderId: trailing slash and whitespace", () => {
  assert.equal(extractFolderId(`  https://workdrive.zoho.com/folder/${ID}  `), ID);
});

test("extractFolderId: rejects junk", () => {
  assert.equal(extractFolderId(""), null);
  assert.equal(extractFolderId(null), null);
  assert.equal(extractFolderId("not a folder id"), null);
  assert.equal(extractFolderId("has/slashes"), null);
});

test("normalizeEntityId: scalar and array both work", () => {
  assert.equal(normalizeEntityId("123"), "123");
  assert.equal(normalizeEntityId(["123"]), "123");
  assert.equal(normalizeEntityId(123), "123");
  assert.equal(normalizeEntityId([]), null);
  assert.equal(normalizeEntityId(null), null);
});

test("parseBody: object, JSON string, and garbage", () => {
  assert.deepEqual(parseBody({ a: 1 }), { a: 1 });
  assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseBody("<html>nope</html>"), { _unparsed: "<html>nope</html>" });
  assert.equal(parseBody(null), null);
});

test("unwrap: success", () => {
  const r = unwrap({ code: "SUCCESS", details: { statusCode: 200, statusMessage: { data: [] } } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
});

test("unwrap: a WorkDrive 403 inside a successful connection call is NOT ok", () => {
  // The exact trap this file exists to prevent.
  const r = unwrap({
    code: "SUCCESS",
    status: "success",
    details: { statusCode: 403, statusMessage: '{"errors":[{"id":"F7003","title":"No permission"}]}' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "DENIED");
  assert.equal(r.message, "No permission");
});

test("unwrap: 404 and 415 classify", () => {
  assert.equal(unwrap({ details: { statusCode: 404, statusMessage: "{}" } }).reason, "NOT_FOUND");
  assert.equal(unwrap({ details: { statusCode: 415, statusMessage: "{}" } }).reason, "BAD_HEADERS");
});

test("unwrap: missing details means the connection itself failed", () => {
  const r = unwrap({ code: "FAILURE", message: "no such connection" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "CONNECTION");
});

// Regression: the live widget showed "WorkDrive returned NaN" because the
// status wasn't under details.statusCode and Number(undefined) is NaN.
test("unwrap: a body with data and NO status anywhere is a success", () => {
  const r = unwrap({ details: { statusMessage: { data: [{ id: "a" }] } } });
  assert.equal(r.ok, true, "a payload carrying data must not be treated as an error");
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
});

test("unwrap: never emits NaN in a user-facing message", () => {
  for (const resp of [
    { details: {} },
    { details: { statusCode: undefined } },
    { details: { statusCode: "not-a-number" } },
    { details: { statusMessage: "totally unparseable" } },
  ]) {
    const r = unwrap(resp);
    assert.ok(!String(r.message).includes("NaN"), `leaked NaN for ${JSON.stringify(resp)}`);
    assert.ok(Number.isFinite(r.status), `non-finite status for ${JSON.stringify(resp)}`);
  }
});

test("unwrap: finds the status under alternate key names", () => {
  assert.equal(unwrap({ details: { status_code: 200, statusMessage: "{}" } }).ok, true);
  assert.equal(unwrap({ details: { statuscode: 200, statusMessage: "{}" } }).ok, true);
  assert.equal(unwrap({ status_code: 404, details: { statusMessage: "{}" } }).reason, "NOT_FOUND");
});

test("unwrap: finds the body under alternate key names", () => {
  assert.equal(unwrap({ details: { statusCode: 200, response: { data: [] } } }).body.data.length, 0);
  assert.equal(unwrap({ details: { statusCode: 200, body: { data: [1] } } }).body.data.length, 1);
});

test("unwrap: JSON:API payload sitting directly on details", () => {
  const r = unwrap({ details: { data: [{ id: "x" }] } });
  assert.equal(r.ok, true);
  assert.equal(r.body.data[0].id, "x");
});

test("unwrap: errors array with no status is still a failure", () => {
  const r = unwrap({ details: { statusMessage: { errors: [{ id: "F7003", title: "No permission" }] } } });
  assert.equal(r.ok, false);
  assert.equal(r.message, "No permission");
});

// WorkDrive's attribute names differ between endpoints. These shapes are taken
// from real captured responses, not from docs.
test("toItem: list-endpoint folder (id/name, resource_type 1001)", () => {
  const item = toItem({
    id: "hr0wcbe0be549b19349058edb9cbcaddef34d",
    type: "files",
    attributes: { name: "Site Photos", is_folder: true, resource_type: 1001 },
  });
  assert.equal(item.id, "hr0wcbe0be549b19349058edb9cbcaddef34d");
  assert.equal(item.name, "Site Photos");
  assert.equal(item.isFolder, true);
});

test("toItem: list-endpoint file (resource_type 2002 = txt)", () => {
  const item = toItem({
    id: "abc123",
    type: "files",
    attributes: { name: "scope-of-work.txt", is_folder: false, resource_type: 2002 },
  });
  assert.equal(item.isFolder, false);
  assert.equal(item.name, "scope-of-work.txt");
});

test("toItem: upload-endpoint shape uses resource_id and FileName", () => {
  // The upload response capitalizes keys and puts the id inside attributes.
  const item = toItem({
    type: "files",
    attributes: {
      resource_id: "hr0wc93b0000",
      FileName: "materials-list.csv",
      Permalink: "https://workdrive.zoho.com/file/hr0wc93b0000",
    },
  });
  assert.equal(item.id, "hr0wc93b0000");
  assert.equal(item.name, "materials-list.csv");
  assert.equal(item.permalink, "https://workdrive.zoho.com/file/hr0wc93b0000");
});

test("toItem: missing attributes doesn't throw", () => {
  const item = toItem({ id: "x" });
  assert.equal(item.name, "(untitled)");
  assert.equal(item.isFolder, false);
});

// ---------------------------------------------------------------------------
// Pagination. WorkDrive caps a page at 50 and gives no truncation signal, so
// "fewer than we asked for" is the only way to know we're done.
// ---------------------------------------------------------------------------

/** Mimics listFolder's loop so the termination logic can be tested directly. */
function pageLoop(totalItems, pageSize = 50, maxItems = 1000) {
  const collected = [];
  let offset = 0;
  let requests = 0;

  while (offset < maxItems) {
    const remaining = Math.max(0, totalItems - offset);
    const batch = Math.min(remaining, pageSize);
    requests++;
    for (let i = 0; i < batch; i++) collected.push(offset + i);
    if (batch < pageSize) break;
    offset += pageSize;
  }
  return { count: collected.length, requests };
}

test("pagination: 52 files needs 2 requests and loses none", () => {
  // The exact case that exposed the bug: a bare array of 50 looks complete.
  const r = pageLoop(52);
  assert.equal(r.count, 52);
  assert.equal(r.requests, 2);
});

test("pagination: under one page is a single request", () => {
  assert.deepEqual(pageLoop(3), { count: 3, requests: 1 });
  assert.deepEqual(pageLoop(0), { count: 0, requests: 1 });
});

test("pagination: exact multiple of 50 costs one extra empty request", () => {
  // No has_next means a full final page is indistinguishable from more to come.
  assert.deepEqual(pageLoop(50), { count: 50, requests: 2 });
  assert.deepEqual(pageLoop(100), { count: 100, requests: 3 });
});

test("pagination: stops at the safety ceiling instead of looping forever", () => {
  const r = pageLoop(5000, 50, 1000);
  assert.equal(r.count, 1000);
  assert.equal(r.requests, 20);
});

// ---------------------------------------------------------------------------
// Trash payload. The widget must only ever TRASH (recoverable), never
// permanently delete.
// ---------------------------------------------------------------------------

test("TRASH_STATUS is the recoverable-trash code, not a delete", () => {
  // PATCH /files with status 61 trashes. DELETE /files/{id} is permanent and
  // must never be what this widget sends.
  assert.equal(TRASH_STATUS, "61");
});

test("trash payload shape: one entry per id, JSON:API typed", () => {
  const ids = ["a1", "b2", "c3"];
  const payload = {
    data: ids.map((id) => ({ attributes: { status: TRASH_STATUS }, id, type: "files" })),
  };
  assert.equal(payload.data.length, 3);
  for (const entry of payload.data) {
    assert.equal(entry.type, "files");
    assert.equal(entry.attributes.status, "61");
    assert.ok(entry.id);
  }
});

test("formatSize", () => {
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});

test("formatDate: epoch millis and junk", () => {
  assert.match(formatDate(1710000000000), /\w+ \d+/);
  assert.equal(formatDate(null), "");
  assert.equal(formatDate("nonsense"), "");
});

test("esc: escapes html", () => {
  assert.equal(esc('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

// Real filenames from the JOB-1006 fixture folder.
test("esc: leaves accents, RTL and em dashes intact", () => {
  const accented = "Résumé — café naïve façade ️.txt";
  assert.equal(esc(accented), accented);

  const rtl = "ملف المشروع العربي - עברית.txt";
  assert.equal(esc(rtl), rtl);
});

test("toItem: unicode filenames survive normalization", () => {
  const long = "a-" + "x".repeat(180) + ".txt";
  for (const name of ["Résumé — café naïve façade ️.txt", "ملف المشروع العربي - עברית.txt", long]) {
    const item = toItem({ id: "i", attributes: { name, is_folder: false } });
    assert.equal(item.name, name);
  }
});

// ---------------------------------------------------------------------------
// Module-agnostic record naming
//
// The widget is placed on whatever module carries the WorkDrive URL field, so
// it can't assume a primary field name. These pin the fallback order.
// ---------------------------------------------------------------------------

test("recordName: reads the primary field of several modules", () => {
  assert.equal(recordName({ Name: "JOB-1001 Harbor View" }), "JOB-1001 Harbor View");
  assert.equal(recordName({ Deal_Name: "Acme renewal" }), "Acme renewal");
  assert.equal(recordName({ Account_Name: "Acme Corp" }), "Acme Corp");
  assert.equal(recordName({ Subject: "Broken boiler" }), "Broken boiler");
});

test("recordName: earlier fields win over later ones", () => {
  assert.equal(recordName({ Name: "first", Deal_Name: "second" }), "first");
});

test("recordName: unknown module degrades to empty, never throws", () => {
  assert.equal(recordName({ Some_Custom_Field: "x" }), "");
  assert.equal(recordName({}), "");
  assert.equal(recordName(null), "");
  assert.equal(recordName(undefined), "");
});

test("recordName: blank and non-string values are skipped", () => {
  assert.equal(recordName({ Name: "   ", Deal_Name: "real" }), "real");
  assert.equal(recordName({ Name: 12345, Deal_Name: "real" }), "real");
  assert.equal(recordName({ Name: "  padded  " }), "padded");
});
