# Mistakes

Traps hit (or deliberately avoided) on this project. Each entry: what went wrong, why, and the rule that follows. Add to this file whenever something costs more than a few minutes.

---

## Two status codes, one response

**What went wrong:** `ZOHO.CRM.CONNECTION.invoke` reports success when the *connection call* succeeded, regardless of what the upstream API said. A WorkDrive 403 or 404 arrives wrapped inside `code: "SUCCESS"`.

**Why:** The connection layer is a proxy. Its status describes the proxy hop, not the destination. The real status is at `details.statusCode`.

**Rule going forward:** Never branch on the outer `code`/`status`. Route every response through `unwrap()` in `api/_shared.js`, which reads `details.statusCode`. There is a test pinning this exact case; don't delete it.

---

## `statusMessage` has two shapes

**What went wrong:** `details.statusMessage` is sometimes an already-parsed object and sometimes a raw JSON string, depending on how the content type was sniffed. Code that assumes one shape breaks intermittently, which is the worst kind of break.

**Why:** Content-type sniffing in the connection layer isn't deterministic from the caller's side.

**Rule going forward:** Always `parseBody()`. Never index into `statusMessage` directly.

---

## `EntityId` is sometimes an array

**What went wrong:** The `PageLoad` payload gives `EntityId` as a bare string in some widget placements and a single-element array in others. Passing the array straight to `getRecord` yields `RecordID=["123"]` and a confusing failure that reads like an auth problem.

**Why:** Related-list and detail-page widgets don't agree on the shape.

**Rule going forward:** `normalizeEntityId()` at the boundary, before the value reaches any API call.

---

## Missing JSON:API header returns 415

**What went wrong:** Every WorkDrive endpoint rejects requests without `Accept: application/vnd.api+json`, with an HTTP 415 that doesn't explain itself.

**Why:** WorkDrive is JSON:API compliant and enforces the content type strictly.

**Rule going forward:** Use `JSONAPI_HEADERS` from `config.js`. If a call suddenly 415s, check the headers before anything else.

---

## Don't infer an API format from blog posts

**What went wrong (nearly):** Most WorkDrive API detail online comes from third-party posts and old forum threads. Zoho's own API docs site is a JS single-page app that can't be fetched, so it's tempting to build against whatever a blog says.

**Why:** Third-party samples drift, and Deluge wrappers (`zoho.workdrive.uploadFile`) hide the real HTTP shape entirely.

**Rule going forward:** Capture the real request and response once, record it in `docs/api-findings.md`, and build against that. The Phase 0 spike page exists for exactly this.

---

## "WorkDrive returned NaN" — guessing a field name

**What went wrong:** The first live run in CRM showed "Couldn't load this folder / WorkDrive returned NaN". `unwrap()` read `details.statusCode`, that key wasn't present, `Number(undefined)` gave `NaN`, every range comparison against `NaN` was false, and a perfectly good response fell into the error branch. The user got a cryptic message for a call that had probably succeeded.

**Why:** Ironic given the warnings at the top of `_shared.js`. I documented that the envelope is inconsistent, then hardcoded a single guessed key for the most important field in it. Worse, the failure mode was silent about its own cause: "NaN" tells you nothing about which key was missing.

**Rule going forward:** Look for the status and body across all known key spellings, and treat "no status found" as *unknown*, not as failure. A body containing `data` is a successful response whose status simply wasn't included — judge by the payload when there's no status. Never interpolate a number into a user-facing string without checking it's finite; there's a test asserting no message ever contains "NaN". When a response shape isn't recognized, show the raw envelope in a collapsed "Technical details" block and log it, so the next surprise diagnoses itself instead of needing a rebuild to investigate.

---

## Listing silently truncates at 50 items

**What went wrong:** `GET /files/{id}/files` returns at most 50 items and gives **no indication that it truncated**. No `meta` block, no `has_next`, no cursor, no total count. A 52-file folder returns a bare array of 50 that is byte-for-byte indistinguishable from a complete listing of a 50-file folder.

The original code rendered `data` and assumed it was everything. On a real job folder with 60 documents, 10 would simply not exist as far as the user was concerned — no error, no warning, nothing to notice.

**Why:** The endpoint's default page size equals its maximum, so the common case looks fine right up until a folder crosses 50.

**Rule going forward:** Always page with `page[offset]` / `page[limit]`, and treat "returned fewer than requested" as the only termination signal. A count that's an exact multiple of 50 costs one extra request returning zero items; that's the correct trade. Pass `sort=name` too — the default is `last_modified desc`, so a folder being uploaded to will shift items between pages and you'll both miss and duplicate files. If a listing is ever incomplete, say so in the UI; never render a partial folder as if it were whole.

---

## An embed can't be a workspace

**What went wrong (avoided in design):** The obvious build is to publish the folder and embed WorkDrive's own viewer in an iframe. That was the original plan, and it was wrong: a published embed is view-only (`role_id: 34`), so it can never satisfy "let users add files and folders."

**Why:** The publish permission and the write requirement are mutually exclusive by design, not by configuration.

**Rule going forward:** When a requirement arrives late ("also let them upload"), re-check whether it invalidates the transport, not just the UI. Here it invalidated the entire approach.

---

## `FUNCTIONS.execute()` needs the function's REST API toggles on

**What went wrong:** The README stated that the `upload_file_to_workdrive` function needs neither OAuth nor an API key enabled. That was wrong, and it was documented confidently enough to send someone debugging elsewhere. Uploads only worked once **both** `OAuth 2.0` and `API Key` were switched on in the function's Overview → REST API panel.

**Why:** The reasoning behind the wrong claim was plausible, which is what made it dangerous. The widget calls the function from an already-authenticated CRM session, and the function reaches WorkDrive through the `wd` connection rather than any credential of its own, so no part of the visible chain looks like it needs a REST endpoint. But `ZOHO.CRM.FUNCTIONS.execute()` evidently dispatches over the function's REST endpoint, so the endpoint has to exist for the call to land at all.

**Rule going forward:** Enable both toggles on any standalone function a widget calls. When browsing, folder creation, and delete all work and *only* uploads fail, check this before anything else — those three go through `CONNECTION.invoke` and touch nothing on the function, so an upload-only failure isolates the cause to the function itself. More generally: an architectural argument for why a setting "shouldn't" be needed is not evidence. Toggle it and observe.
