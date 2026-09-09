/**
 * Every tunable value in one place.
 */

// The widget is module-agnostic. At runtime the module comes from PageLoad's
// Entity, which is whatever record page the widget was placed on — so the same
// deployed files serve Jobs, Deals, Accounts or any custom module.
//
// This constant is only the fallback for when PageLoad hands back no Entity,
// which in practice means a misconfigured placement. Nothing else reads it.
export const DEFAULT_MODULE = "Jobs";

// The only field the widget reads. A website field, so it renders as a
// clickable link on the record and people can reach WorkDrive without the
// widget. The folder ID is parsed off the end of it.
//
// This API name must match on every module the widget is placed on. A field
// labelled "WorkDrive URL" gets the API name WorkDrive_URL by default, but CRM
// will append a suffix if the name is already taken — check the API name in
// Setup rather than assuming it from the label.
export const FIELD = "WorkDrive_URL";

// Where to look for a record's display name, in order. Different modules use
// different primary fields: Jobs and most custom modules use "Name", Deals use
// "Deal_Name", Accounts "Account_Name". The first non-empty one wins, and it's
// only used for the root breadcrumb label — an unrecognized module still works,
// it just shows the generic fallback.
export const NAME_FIELDS = [
  "Name",
  "Job_Name",
  "Deal_Name",
  "Account_Name",
  "Subject",
  "Last_Name",
];

// CRM Connection (Setup > Developer Hub > Connections). Already authorized
// with WorkDrive.files.ALL + WorkDrive.files.CREATE, which covers every call.
//
// Delete (trashItems) is a PATCH, so it needs the write half of files.ALL —
// and separately, the account that authorized this connection needs delete
// rights on the folder in WorkDrive. Every call runs as that account, not as
// the CRM user clicking the button, so view-only access there means delete
// fails with a 403 no matter what the scopes say.
export const CONNECTION = "wd";

export const WD_API = "https://www.zohoapis.com/workdrive/api/v1";

// WorkDrive is JSON:API compliant. Without these headers every endpoint
// returns HTTP 415.
export const JSONAPI_HEADERS = {
  Accept: "application/vnd.api+json",
  "Content-Type": "application/vnd.api+json",
};

// Human-facing WorkDrive URL, used for the "Open in WorkDrive" escape hatch
// that every error state offers.
export const wdFolderUrl = (id) => `https://workdrive.zoho.com/folder/${id}`;
export const wdFileUrl = (id) => `https://workdrive.zoho.com/file/${id}`;

// Uploads go through a Deluge CRM Function (see deluge/upload_file_to_workdrive.dg).
// The file is base64'd in the browser, which inflates it by ~33%, then passed as a
// function argument — so the real ceiling is whatever CRM accepts as an argument,
// not WorkDrive's own limit.
//
// 10MB is a deliberately conservative starting point. Zoho documents 50MB for
// file uploads in Creator, but nothing documents the argument-size limit for a
// function invoked from a widget. Raise this only after testing where it
// actually breaks, and record the finding in docs/api-findings.md.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// WorkDrive resource_type codes.
export const FOLDER_TYPE = 1001;

// PATCH /files with attributes.status = "61" moves items to WorkDrive's trash.
// Recoverable, unlike DELETE /files/{id} which is permanent. The widget only
// ever trashes — see trashItems().
export const TRASH_STATUS = "61";

// WorkDrive caps a listing page at 50 and gives NO indication when it
// truncates — no meta, no cursor, no total. See listFolder() for why that
// matters and how it's handled.
export const PAGE_SIZE = 50;

// Backstop so a pathological folder can't spin forever. At 20 pages this is
// far past anything a job folder should hold; hitting it flags the listing as
// truncated rather than pretending it's complete.
export const MAX_LIST_ITEMS = 1000;
