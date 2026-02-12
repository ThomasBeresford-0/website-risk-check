// server/integrity.js
// Deterministic integrity hash (SHA-256) over objective fields only.
// Supports both legacy flat scan shape and new structured scan shape.
//
// IMPORTANT:
// - Do not include payment/session IDs, share tokens, file paths, or anything mutable.
// - Keep payload construction explicit and canonicalized.
// - Canonicalization MUST match what report.js feeds in (buildIntegrityInput).
//
// KEY FIXES:
// ✅ Canonicalize scannedAt consistently (string) for both legacy + structured + already-normalized inputs
// ✅ Canonicalize ordering for sets that may vary (vendors, trackingScripts, accessibility notes)
// ✅ Canonicalize page lists order (by url, then status) so fetch ordering never changes hashes

import crypto from "crypto";

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, fallback = "") {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}

function bool(v) {
  return v === true;
}

function sortStrings(arr) {
  return safeArr(arr)
    .map((s) => str(s))
    .filter((s) => s.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function normalizePages(arr) {
  return safeArr(arr)
    .map((p) => ({
      url: str(p?.url),
      status: num(p?.status, 0),
    }))
    .filter((p) => p.url.length > 0)
    .sort((a, b) => {
      const c = a.url.localeCompare(b.url);
      return c !== 0 ? c : a.status - b.status;
    });
}

// Stable JSON stringify: sorts object keys recursively
function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Canonical payload builder.
 * Accepts:
 * - legacy flat scan output
 * - structured scan output
 * - already-normalized integrity input from report.js (meta/coverage/signals)
 */
function toCanonical(scan) {
  const looksStructured = !!scan?.meta && !!scan?.signals;

  // ----- meta -----
  const metaSrc = looksStructured ? scan.meta : scan;
  const meta = {
    url: str(metaSrc?.url),
    hostname: str(metaSrc?.hostname),
    scanId: str(metaSrc?.scanId),
    // ✅ canonicalize scannedAt to STRING always (prevents ms-number vs string hash drift)
    scannedAt: str(metaSrc?.scannedAt),
    https: bool(metaSrc?.https),
  };

  // ----- coverage -----
  const coverageSrc = looksStructured ? scan.coverage : scan;
  const notes = looksStructured
    ? safeArr(coverageSrc?.notes).map((s) => str(s))
    : safeArr(scan?.scanCoverageNotes).map((s) => str(s));

  const checkedPages = looksStructured
    ? normalizePages(coverageSrc?.checkedPages)
    : normalizePages(scan?.checkedPages);

  const failedPages = looksStructured
    ? normalizePages(coverageSrc?.failedPages)
    : normalizePages(scan?.failedPages);

  const coverage = {
    notes,
    checkedPages,
    failedPages,
  };

  // ----- signals -----
  const signalsSrc = looksStructured ? scan.signals : scan;

  // Policies
  const policies = looksStructured
    ? signalsSrc?.policies || {}
    : {
        privacy: bool(scan?.hasPrivacyPolicy),
        terms: bool(scan?.hasTerms),
        cookies: bool(scan?.hasCookiePolicy),
      };

  // Consent + vendors
  const consent = looksStructured
    ? signalsSrc?.consent || {}
    : {
        bannerDetected: bool(scan?.hasCookieBanner),
        vendors: safeArr(scan?.cookieVendorsDetected),
      };

  // Tracking scripts
  const trackingScripts = looksStructured
    ? // structured: signals.trackingScripts
      safeArr(signalsSrc?.trackingScripts)
    : safeArr(scan?.trackingScriptsDetected);

  // Forms
  const forms = looksStructured
    ? signalsSrc?.forms || {}
    : {
        detected: num(scan?.formsDetected, 0),
        personalDataSignals: num(scan?.formsPersonalDataSignals, 0),
      };

  // Accessibility
  const accessibility = looksStructured
    ? signalsSrc?.accessibility || {}
    : {
        notes: safeArr(scan?.accessibilityNotes),
        images: {
          total: num(scan?.totalImages, 0),
          missingAlt: num(scan?.imagesMissingAlt, 0),
        },
      };

  // Contact
  const contact = looksStructured
    ? signalsSrc?.contact || {}
    : { detected: bool(scan?.contactInfoPresent) };

  const signals = {
    policies: {
      privacy: bool(policies?.privacy),
      terms: bool(policies?.terms),
      cookies: bool(policies?.cookies),
    },
    consent: {
      bannerDetected: bool(consent?.bannerDetected),
      // ✅ canonicalize vendor order
      vendors: sortStrings(consent?.vendors),
    },
    // ✅ canonicalize tracking order
    trackingScripts: sortStrings(trackingScripts),
    forms: {
      detected: num(forms?.detected, 0),
      personalDataSignals: num(forms?.personalDataSignals, 0),
    },
    accessibility: {
      // ✅ canonicalize notes order (set-derived notes may vary)
      notes: sortStrings(accessibility?.notes),
      images: {
        total: num(accessibility?.images?.total, 0),
        missingAlt: num(accessibility?.images?.missingAlt, 0),
      },
    },
    contact: {
      // structured: contact.detected
      detected: bool(contact?.detected),
    },
  };

  // Objective facts only (explicit)
  return {
    meta,
    coverage,
    signals,
  };
}

export function computeIntegrityHash(scan) {
  const payload = toCanonical(scan);
  const canonical = stableStringify(payload);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
