# Camco Zoho CRM WorkDrive Widget

A Zoho CRM widget that lists a record's WorkDrive folder inline on the record, and lets people create folders and upload files without leaving CRM. Registered as a Related List, hosted as static files on camco.dev, and built to be repackaged for a client tenant later.

Deployed against the **Jobs** module, but the code is module-agnostic: the module arrives at runtime from `PageLoad`'s `Entity`, so the same files serve any module whose records carry a `WorkDrive_URL` field. `DEFAULT_MODULE` in `config.js` is only a fallback for a misconfigured placement. Don't reintroduce a hardcoded module name. See README for the per-module setup.

## Repo layout

```
app/                    SHIPS. Static, hosting-agnostic, no build step.
  widget.html           entry point (keep this name — zet expects it)
  index.html            redirect to widget.html so the bare folder URL works
  spike.html            Phase 0 throwaway; delete once findings are recorded
  css/widget.css
  js/
    main.js             SDK boot, PageLoad, orchestration
    config.js           every tunable value
    api/_shared.js      envelope unwrapping — read this before touching the API
    api/crm.js          Job record -> folder ID
    api/workdrive.js    list / create folder / upload
    ui/render.js        all DOM writes
    ui/dropzone.js      drag-and-drop + file picker
tests/logic.test.mjs    pure-logic tests (node --test)
server/                 LOCAL ONLY — zet dev server
cert.pem, key.pem       LOCAL ONLY, gitignored
plugin-manifest.json    LOCAL ONLY — {"service":"CRM"}; placement is set in CRM Setup
.env                    LOCAL ONLY, gitignored — FTP credentials
docs/api-findings.md    real request/response captures
```

**The boundary that matters:** only `app/` is uploaded. Everything else is local tooling and must never ship.

## Verified integration facts

Confirmed against the live CRM on 2026-09-09. These are expensive to rediscover.

| | |
|---|---|
| Module | `Jobs` (custom module, layout `Standard__s`) |
| Field (primary) | `WorkDrive_URL` — website type, 450 chars, id `2582206000076840576`. Clickable on the record; the widget parses the folder ID off the end. |
| Field (fallback) | `WorkDrive_Folder_ID` — text, 100 chars, id `2582206000076819004`. A bare ID works too. |
| Connection | `wd` (service `zoho_workdrive`), already authorized |
| Scopes | Has `WorkDrive.files.ALL` + `WorkDrive.files.CREATE`. **Nothing to enable.** |
| JS SDK | `https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js` |
| Widget URL | `https://camco.dev/zoho-widgets/camco_zcrm_workdrive_widget/widget.html` |

### WorkDrive endpoints (base `https://www.zohoapis.com/workdrive/api/v1`)

| Operation | Method | Path | param_type |
|---|---|---|---|
| List folder | GET | `/files/{id}/files` | 1 |
| Folder metadata | GET | `/files/{id}` | 1 |
| Create folder | POST | `/files` | 2 |
| Upload file | POST | `/upload` | 2 |
| Publish (unused) | POST | `/permissions` | 2 |

Every endpoint needs `Accept: application/vnd.api+json`. Without it you get **HTTP 415**, every time.

Create-folder body:
```json
{"data":{"attributes":{"name":"...","parent_id":"<id>"},"type":"files"}}
```

### The response envelope — read this before touching the API layer

`ZOHO.CRM.CONNECTION.invoke` wraps the upstream response, so there are **two levels of status that answer different questions**:

- `resp.code` / `resp.status` — did the *connection call* work?
- `resp.details.statusCode` — what did *WorkDrive* actually return?

A WorkDrive 403 arrives inside a perfectly successful connection call. Read only the outer status and a permission error looks like a success. `api/_shared.js` `unwrap()` handles this; there's a test pinning the behavior.

Second trap: `details.statusMessage` is sometimes a parsed object and sometimes a JSON string. Always run it through `parseBody()`.

### Attribute names differ between endpoints

Captured from real responses, not docs:

- **List** (`/files/{id}/files`) returns `id` and `name` on each resource. Folders and files come back interleaved, both with `type: "files"` — tell them apart by `is_folder` or `resource_type` (1001 folder, 2002 txt, 2102 csv). **Caps at 50 items with no truncation signal** — see below.
- **Create folder** (`POST /files`) returns a **single object** under `data`, no array.
- **Upload** (`POST /upload`) returns an **array** under `data`, and renames things: the id is `attributes.resource_id` (not `resource.id`), the name is `FileName`, the link is `Permalink`. There's also a `File INFO` key holding a JSON-encoded string that needs a second parse.

`toItem()` in `api/workdrive.js` normalizes all of this, with tests pinning each shape.

### Listing pages at 50, silently

The worst trap in this API. `/files/{id}/files` returns at most 50 items and **gives no signal that it truncated** — no meta, no cursor, no total. A 52-file folder returns a bare array of 50 that looks exactly like a complete listing.

`listFolder()` pages with `page[offset]` / `page[limit]=50` until a response comes back with fewer than 50, and passes `sort=name` so paging is stable (the default sort is `last_modified desc`, which shifts items between pages in an active folder). If a listing is ever incomplete, the UI says so — never render a partial folder as if it were whole.

## Local dev

```
npm start          # or: zet run
```

Serves `https://127.0.0.1:5000`, with `app/` mounted at **`/app`** — so the URL is `https://127.0.0.1:5000/app/widget.html`, not `/widget.html`.

**First run:** the cert is self-signed. Open `https://127.0.0.1:5000` in a tab and click Advanced → Proceed **before** CRM will load it in an iframe. Skip this and the widget silently shows nothing, which looks like a code bug and is not one.

To test against real CRM data, register a second dev-only widget in CRM Setup pointing at the localhost URL. The SDK and the `wd` connection only exist inside a CRM-hosted iframe, so there is no way around this.

```
npm test           # pure logic only: ID parsing, envelope unwrapping, formatting
```

## Deploy

```
npm run deploy:dry     # list what would upload
npm run deploy         # upload app/ to camco.dev
```

Uses `C:\Users\john\cli-tools\sftp-deploy` (extended with plain-FTP support). Protocol auto-selects: `FTP_*` vars with no `SFTP_*` means FTP. Credentials live in this project's gitignored `.env`, never in the shared tool's directory.

## Code style

Plain ES modules, no bundler, no framework. The deployed artifact is exactly the source, which matters when the only way to debug is through a cross-origin iframe inside someone else's page.

The SDK loads via a plain `<script>` tag (it's a global, not a module); everything else is `type="module"`. Keep parsing and formatting pure so they stay testable outside a browser.

The UI deliberately matches Zoho's own type scale and neutral palette. It should read as part of the CRM, not as a guest with its own opinions.

## Before writing to CRM or WorkDrive

Anything that creates, deletes, or modifies CRM schema, CRM records, or WorkDrive contents needs John's explicit go-ahead first. Say what you're about to change and wait for **"go go gadget"**.
