# API findings

Real request/response captures, so nothing downstream is built on a guess. Fill this in by running `spike.html` inside a real CRM widget.

**Spike URL:** https://camco.dev/zoho-widgets/camco_zcrm_workdrive_widget/spike.html

Register it temporarily in CRM Setup as a Related List widget on Jobs (Hosting: External), open a Job, run the buttons in order, and paste what the console shows.

---

## Status

| Spike | Question | Result |
|---|---|---|
| B1 | Does `GET /files/{id}/files` list a folder? | Works **via direct REST**. Not yet confirmed through `CONNECTION.invoke`. |
| B2 | Does `GET /files/{id}` return metadata? | _not yet run_ |
| B3 | Does `POST /files` create a folder? | Works **via direct REST**. Not yet confirmed through `CONNECTION.invoke`. |
| A1 | Upload via `FormData`? | _not run — superseded_ |
| A2 | Upload via base64 JSON body? | **FAILS on real files.** See below. |
| A3 | Upload via hand-built multipart string? | _not run — superseded_ |

**Upload transport in use:** `function` — a Deluge CRM Function (`deluge/upload_file_to_workdrive.dg`).

### A2 settled by a live failure, 2026-09-09

Uploading a real file from the widget failed. The Network tab told the story:

```
POST https://crm.zoho.com/crm/v2/connections/wd/actions/invoke
Content-Type:   application/x-www-form-urlencoded
Content-Length: 1618031          <- ~1.6MB of base64, as a form field
Response:       102 bytes, error
```

`CONNECTION.invoke` marshals its payload as `application/x-www-form-urlencoded`. A base64 file of any real size is rejected before it ever reaches WorkDrive, and the rejection carries no usable detail client-side — it surfaces as a generic failure indistinguishable from an auth problem.

**This means no amount of client-side work makes direct upload viable.** A1 and A3 weren't run because they'd hit the same wall: the payload never gets far enough for the encoding to matter.

The fix is the same one that made folder creation work: do it server-side in Deluge, where `zoho.workdrive.uploadFile` handles multipart natively.

```
zoho.workdrive.uploadFile(<file>, <folder_id>, <file_name>, <override_name_exist>, <connection>)
```

Notes from the docs that matter: the file name must be `encodeUrl`'d as UTF-8, and the scope needed is `WorkDrive.files.CREATE` (already on `wd`). The base64 is rebuilt with `base64Decode(...).toFile(name)`.

**Still unknown:** the maximum argument size a CRM Function accepts when invoked from a widget. Base64 inflates a file ~33%, and nothing documents this limit. `MAX_UPLOAD_BYTES` is set to a conservative 10MB — find where it actually breaks and record it here.

> **Important caveat on B1/B3.** Those were confirmed against the WorkDrive REST API *directly*, through a separate MCP connector — **not** through `ZOHO.CRM.CONNECTION.invoke` and the `wd` connection, which is what the widget actually uses. So they establish the upstream payload shape, which is what `details.statusMessage` should contain, but they say nothing about how the connection wrapper behaves around it. The spike still needs running.

## Test records (Jobs module)

Sandbox tree `_Widget Test Jobs` (`hr0wcd0b9ffb36e2e45b5bc0d4f0e93c3e3dd`) in the "Zoho CRM" team folder. Safe to trash wholesale.

| Job | Folder ID | Contents |
|---|---|---|
| JOB-1001 Harbor View Roof Replacement | `hr0wc4f4a3afc626a4c148238db8e68e2545c` | 2 files + subfolder "Site Photos" — **nested navigation test** |
| JOB-1002 Cedar Street Kitchen Remodel | `hr0wcc61449d08d744d0b96cd6bb7963da7c7` | 2 files, flat |
| JOB-1003 Miller Warehouse HVAC Install | `hr0wc58e61fbc6ee34a5e9c793fc81c75558f` | 1 file |
| JOB-1004 Ashwood Deck Rebuild | `hr0wcd08e85377f574d409ce3557b02436a81` | empty — **empty-state test** |

All four have `WorkDrive_URL` populated. (They also had `WorkDrive_Folder_ID`, but that field was removed from Jobs on 2026-09-09 — `WorkDrive_URL` is now the only one.)

Every folder came back `is_published=false` with `capabilities.can_publish=true`, so nothing has an embed code yet — a clean slate if the read-only embed fallback is ever needed.

## Confirmed attribute shapes (direct REST)

**Create folder** — single object under `data`, no array:
```
data.id                       the folder id
data.attributes.name, parent_id, is_folder=true, resource_type=1001,
                   permalink, library_id, storage_info{files_count, folders_count}
```

**Upload** — `data` is an ARRAY, and the keys are renamed:
```
data[0].attributes.resource_id   <- the id, NOT data[0].id
data[0].attributes.FileName      <- capitalized
data[0].attributes.Permalink     <- capitalized
data[0].attributes["File INFO"]  <- a JSON-encoded STRING; needs a second parse
                                    (MD5_CHECKSUM, size, AUDIT_INFO.statusCode "D201", OWNER)
```

**List** — folders and files interleaved, both `type: "files"`. Distinguish by `attributes.is_folder` or `resource_type` (1001 folder, 2002 txt, 2102 csv).

### Pagination — verified, and it silently truncates

Confirmed against JOB-1005 (52 files):

- No page params returns exactly **50** items. The folder has 52. Two files are simply absent.
- **There is no truncation signal.** No `meta`, no `has_next`, no cursor, no total. The response is a bare `{"data":[...50]}` that is indistinguishable from a complete 50-file listing.
- `?page[offset]=50&page[limit]=50` returns the remaining 2. Max page size is 50.
- Termination: keep requesting until a page returns fewer than the limit. An exact multiple of 50 costs one extra request returning 0.
- Default sort is `last_modified desc`, so an actively-changing folder shifts items between pages. Pass `sort=name` for stable paging.
- A `page[next]` cursor param exists in the docs, but no token comes back in these responses, so offset paging is what's actually verified.

Handled in `listFolder()`, with tests covering 52 files, exact multiples, under-a-page, and the safety ceiling.

`toItem()` in `api/workdrive.js` handles all three shapes; `tests/logic.test.mjs` pins each one.

---

## Deluge: `zoho.workdrive.createFolder` — confirmed working 2026-09-09

The workflow function `create_workdrive_folder_on_new_job` (see `deluge/`) creates a Job's folder server-side, which sidesteps the whole `CONNECTION.invoke` envelope question. Signature:

```
zoho.workdrive.createFolder(folderName, parent_id, connection)
```

The built-in task handles the JSON:API envelope and the `vnd.api+json` headers itself, so **none of the 415 workarounds apply here** — no `headerMp`, no hand-built `{"data":{"attributes":{...},"type":"files"}}` payload. This is meaningfully simpler than the `invokeurl` route and worth preferring anywhere Deluge can do the work.

Confirmed run: Job `2582206000076840730` ("tester") → folder `lxazfd287fd97630a40e78c974aaa4a59377b`, `WorkDrive_URL` written at 17:09:45.

### `R008 Unauthorized access` is ambiguous by design — check the ID first, then permissions

Cost a debugging cycle, so it's worth writing down. A create against a **non-existent or unresolvable `parent_id`** comes back as:

```
POST 401 zoho.workdrive.createFolder rt_ms=20
{"errors":[{"id":"R008","title":"Unauthorized access"}]}
```

The message points at auth; the actual cause was a placeholder string in `parentFolderIdStr`. WorkDrive can't distinguish "this folder doesn't exist" from "you may not write here", and reports both as `R008`.

Diagnostic order when this appears:

1. **Check the parent folder ID first.** Cheapest to rule out, and the most likely cause.
2. **Check the round-trip time.** ~20ms means it was rejected before any real work. A genuine permissions failure against a real folder takes longer.
3. **Only then suspect the connection.** For the record, `wd` was verified 2026-09-09: service `zoho_workdrive`, authorized, carrying `WorkDrive.files.ALL` and `WorkDrive.files.CREATE`. Note that `authentication.status: true` only means a token exists, not that it works.

#### The same code on a PATCH, where the ID was definitely valid

Captured live 2026-09-09 from the widget's Delete button. Same `R008`, different cause — which is why the heading above no longer says "usually a bad ID".

Request (decoded from the form-urlencoded body CRM actually sent):

```
url=https://www.zohoapis.com/workdrive/api/v1/files
method=PATCH
param_type=2
parameters={"data":[{"attributes":{"status":"61"},"id":"lxazf67d8ed91e494434ca7a516ccc5bf021a","type":"files"}]}
headers={"Accept":"application/vnd.api+json","Content-Type":"application/vnd.api+json"}
```

Response:

```json
{"code":"SUCCESS","details":{"statusMessage":{"errors":[{"id":"R008","title":"Unauthorized access"}]},"status":"true"},"message":"Connection invoked successfully","status":"success"}
```

Three things this pins down:

- **The nested array survives the form-urlencoding intact.** `parameters` arrives as a JSON string with the `data` array whole. Whatever broke base64 uploads, it is not generic payload mangling — that hypothesis is dead for PATCH.
- **There is no `statusCode` anywhere in the envelope.** `"status":"true"` is the connection layer reporting on *itself*. `findStatus()` correctly returns null, which used to drop the result into `UNKNOWN` and surface the bare string "Unauthorized access" in the UI. `classifyErrorCode()` now maps `R008` → `DENIED` so the banner can explain it.
- **The resource ID was valid.** It came from a listing that had just rendered the file on screen. GET and POST both succeed against the same folder with the same connection; only the write is refused.

Which leaves folder permissions on the account that authorized `wd`. Every call runs as that account, never as the CRM user clicking the button, so read-only access there fails deletes while listing keeps working perfectly.

### Still open

- Which response branch the successful run took — `data` as an array vs. a single object. Direct REST returns a **single object** under `data` (see above), so the task most likely does too, but the live log hasn't been read back to confirm. The function currently handles array, single-object, and flat shapes; two of those three branches are dead code once this is settled.

---

## Envelope shape

The thing everything else depends on. Record the literal structure.

```
(paste a real invoke() response here)
```

Answer these explicitly:

- Is `details.statusMessage` an object or a string? Does it vary by endpoint?
- Does `details.statusCode` carry WorkDrive's HTTP status, or something else?
- What does a WorkDrive error body actually look like — is it `{errors:[{id,title}]}`?

---

## List folder response

```
(paste)
```

Confirm the field names `toItem()` in `api/workdrive.js` reads:
- Folder detection: `is_folder`, or `resource_type === 1001`, or something else?
- Name: `name`, or `display_attr_name`?
- Size: `storage_info.size_in_bytes`, or `size_in_bytes`?
- Modified: `modified_time_in_millisecond` — epoch millis or a formatted string?

---

## Upload

### The function's REST API toggles must be ON — settled 2026-09-09

`ZOHO.CRM.FUNCTIONS.execute()` will not reach a standalone function unless that function exposes a REST endpoint. On the function's **Overview → REST API** panel, both **`OAuth 2.0`** and **`API Key`** have to be enabled.

This is genuinely counter-intuitive, and the reasoning that says otherwise is wrong:

> The widget already runs inside an authenticated CRM session, and the function reaches WorkDrive through the `wd` connection rather than any credential of its own. So nothing in the chain should need a REST endpoint.

That argument was written into the README and it was wrong. With both toggles off, uploads fail. Turning them on, with no other change, made uploads work. `FUNCTIONS.execute()` evidently goes through the function's REST endpoint, so the endpoint has to exist.

**Diagnostic signature:** browsing, folder creation, and delete all work; only uploads fail. Those three go through `CONNECTION.invoke` and need nothing on the function. Uploads are the only path that touches it, so an upload-only failure points here first.

Neither generated URL needs to be copied into the widget. Note that the API Key URL embeds a live `zapikey` that lets anyone holding it execute the function — it's a credential, so keep it out of tickets, commits, and screenshots.

```
OAuth 2.0   .../crm/v7/functions/upload_file_to_workdrive/actions/execute?auth_type=oauth
API Key     .../crm/v7/functions/upload_file_to_workdrive/actions/execute?auth_type=apikey&zapikey=<redacted>
```

### Still to record

```
(paste the winning request and its response)
```

- The largest file that actually made it through, and where it started failing.
- What a duplicate filename returns with `override-name-exist: false`.

---

## Notes

- WorkDrive folder ID = the last path segment of the folder's URL.
- Every endpoint needs `Accept: application/vnd.api+json` or returns HTTP 415.
- Known-good embed URL format, if the read-only fallback is ever needed:
  `https://workdrive.zohoexternal.com/embed/<id>?toolbar=true&layout=list&appearance=light&themecolor=blue`
