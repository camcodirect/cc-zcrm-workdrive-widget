/**
 * Unwrapping ZOHO.CRM.CONNECTION.invoke responses.
 *
 * The single most important thing in this file: the invoke() response has TWO
 * levels of status, and they answer different questions.
 *
 *   resp.code / resp.status      did the CONNECTION call itself work?
 *   resp.details.statusCode      what did WorkDrive actually return?
 *
 * A WorkDrive 403 arrives inside a perfectly successful connection call. Read
 * only the outer status and a permission error looks like a success.
 *
 * Second trap: details.statusMessage is sometimes a parsed object and
 * sometimes a JSON string, depending on how the content type was sniffed.
 * Always run it through parseBody().
 */

import { CONNECTION } from "../config.js";

/** statusMessage may be an object, a JSON string, or absent. */
export function parseBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _unparsed: raw };
    }
  }
  return null;
}

/**
 * The upstream HTTP status has been observed under several different keys
 * depending on the endpoint and how the connection layer wrapped it. Look in
 * all the known places rather than assuming one.
 *
 * Returns null when no status is present at all — which is NOT the same as a
 * failure. Some responses carry a usable body with no status anywhere; those
 * are judged by their payload instead (see unwrap).
 */
function findStatus(resp, details) {
  const candidates = [
    details && details.statusCode,
    details && details.status_code,
    details && details.statuscode,
    resp && resp.status_code,
    resp && resp.statusCode,
    details && details.code,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The response body can also hide under a few different keys. */
function findBody(resp, details) {
  const candidates = [
    details && details.statusMessage,
    details && details.status_message,
    details && details.response,
    details && details.body,
    details && details.output,
    resp && resp.response,
  ];
  for (const c of candidates) {
    const parsed = parseBody(c);
    if (parsed) return parsed;
  }
  // Some shapes put the JSON:API payload directly on details.
  if (details && (details.data || details.errors)) return details;
  return null;
}

/** A JSON:API payload is itself evidence the call succeeded. */
function looksSuccessful(body) {
  if (!body) return false;
  if (Array.isArray(body.errors) && body.errors.length) return false;
  return Object.prototype.hasOwnProperty.call(body, "data");
}

/**
 * Normalize any invoke() response into { ok, status, body, reason, message }.
 * Nothing downstream should touch the raw envelope.
 */
export function unwrap(resp) {
  const details = resp && resp.details;
  const status = findStatus(resp, details);
  const body = findBody(resp, details);

  // The connection layer itself failed (bad connection name, revoked auth).
  if (!details && !body) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: resp,
      reason: "CONNECTION",
      message: (resp && resp.message) || "Couldn't reach WorkDrive.",
    };
  }

  if (status !== null && status >= 200 && status < 300) {
    return { ok: true, status, body, raw: resp, reason: null, message: null };
  }

  // No status anywhere. Don't guess a failure — judge by the payload. A body
  // carrying `data` is a successful response whose status simply wasn't
  // included; treating that as an error is what produced "returned NaN".
  if (status === null) {
    if (looksSuccessful(body)) {
      return { ok: true, status: 200, body, raw: resp, reason: null, message: null };
    }
    const code = errorCode(body);
    return {
      ok: false,
      status: 0,
      body,
      raw: resp,
      reason: classifyErrorCode(code) || "UNKNOWN",
      message: errorText(body) || "WorkDrive returned an unrecognized response.",
    };
  }

  return {
    ok: false,
    status,
    body,
    raw: resp,
    reason: classify(status),
    message: errorText(body) || `WorkDrive returned ${status}.`,
  };
}

function classify(status) {
  if (status === 401 || status === 403) return "DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "TOO_LARGE";
  if (status === 415) return "BAD_HEADERS";
  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

/** The JSON:API error id, e.g. "R008". */
function errorCode(body) {
  if (!body || !Array.isArray(body.errors) || !body.errors.length) return null;
  const id = body.errors[0].id;
  return id ? String(id).toUpperCase() : null;
}

/**
 * Map a WorkDrive error id to a reason, for the responses that arrive with no
 * HTTP status at all.
 *
 * R008 is the one that matters. WorkDrive returns it for BOTH "this resource
 * doesn't exist" and "you may not write here", with identical text and no
 * status code — see docs/api-findings.md. DENIED is the right call because the
 * ambiguity is itself worth surfacing: the friendly message names both causes
 * rather than asserting one.
 */
function classifyErrorCode(code) {
  if (!code) return null;
  if (code === "R008") return "DENIED";
  return null;
}

/** WorkDrive returns JSON:API errors: { errors: [ { id, title } ] }. */
function errorText(body) {
  if (!body) return null;
  if (Array.isArray(body.errors) && body.errors.length) {
    const e = body.errors[0];
    return e.title || e.detail || e.id || null;
  }
  return body._unparsed ? String(body._unparsed).slice(0, 200) : null;
}

/** Friendly text per reason code, for the UI. */
export function friendlyMessage(reason, fallback) {
  switch (reason) {
    case "CONNECTION":
      // Deliberately does NOT blame the connection. This fires whenever
      // invoke() rejects for any reason — a payload too large for the
      // connection layer looks identical to revoked auth from here, and
      // pointing at auth sends people debugging the wrong thing.
      return fallback
        ? `WorkDrive call failed: ${fallback}`
        : "The WorkDrive call didn't go through. See the browser console for details.";
    case "DENIED":
      // Covers reads AND writes, so it can't say "view". WorkDrive reports a
      // missing resource and a forbidden one identically (R008), so name both
      // possibilities instead of asserting the wrong one. The account that
      // authorized the connection is what matters here, not the CRM user
      // clicking — that distinction is the usual cause and the least obvious.
      return "WorkDrive turned that down. The account connected to CRM may not have permission for this folder, or the item may no longer exist.";
    case "NOT_FOUND":
      return "That WorkDrive folder no longer exists, or the ID is wrong.";
    case "CONFLICT":
      return "A file or folder with that name already exists here.";
    case "TOO_LARGE":
      return "That file is too large to upload from here.";
    case "BAD_HEADERS":
      return "WorkDrive rejected the request format.";
    case "SERVER":
      return "WorkDrive is having trouble right now. Try again shortly.";
    default:
      return fallback || "Something went wrong talking to WorkDrive.";
  }
}

/**
 * Set true to log every raw invoke() response to the console. Useful when a
 * response shape is unexpected; the envelope varies more than the docs admit.
 * Toggle at runtime from the console: window.__WD_DEBUG = true
 */
export const DEBUG = () => typeof window !== "undefined" && window.__WD_DEBUG === true;

/** Thin wrapper so callers never see the raw envelope. */
export async function invoke(req) {
  if (typeof ZOHO === "undefined" || !ZOHO.CRM || !ZOHO.CRM.CONNECTION) {
    return { ok: false, status: 0, body: null, reason: "CONNECTION", message: "Zoho SDK unavailable." };
  }
  try {
    const resp = await ZOHO.CRM.CONNECTION.invoke(CONNECTION, req);
    if (DEBUG()) console.log("[wd] request", req, "\n[wd] raw response", resp);
    const result = unwrap(resp);
    if (!result.ok) {
      // Always log failures: the message alone rarely explains an envelope
      // problem, and this is the only way to see one from inside the iframe.
      console.warn("[wd] call failed", { request: req, raw: resp, parsed: result });
    }
    return result;
  } catch (err) {
    console.warn("[wd] invoke threw", err);
    return {
      ok: false,
      status: 0,
      body: null,
      reason: "CONNECTION",
      message: (err && err.message) || String(err),
    };
  }
}
