// server/integrity.js
// Deterministic integrity hash (SHA-256) over objective fields only.
// Supports both legacy flat scan shape and new structured scan shape.
//
// IMPORTANT:
// - Do not include payment/session IDs, share tokens, file paths, or anything mutable.
// - Keep payload construction explicit and canonicalized.

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

// Stable JSON stringify: sorts object keys recursively
function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

function normalizeLegacy(scan) {
  return {
    meta: {
      url: str(scan?.url),
      hostname: str(scan?.hostname),
      scanId: str(scan?.scanId),
      scannedAt: str(scan?.scannedAt),
      https: bool(scan?.https),
    },
    coverage: {
      notes: safeArr(scan?.scanCoverageNotes).map((s) => str(s)),
      checkedPages: safeArr(scan?.checkedPages).map((p) => ({
        url: str(p?.url),
        status: num(p?.status, 0),
      })),
      failedPages: safeArr(scan?.failedPages).map((p) => ({
        url: str(p?.url),
        status: num(p?.status, 0),
      })),
      // legacy had fetchOk/fetchStatus as top-level
      fetchOk: scan?.fetchOk === false ? false : true,
      fetchStatus: num(scan?.fetchStatus, 0),
    },
    signals: {
      policies: {
        privacy: bool(scan?.hasPrivacyPolicy),
        terms: bool(scan?.hasTerms),
        cookies: bool(scan?.hasCookiePolicy),
      },
      consent: {
        bannerDetected: bool(scan?.hasCookieBanner),
        vendors: safeArr(scan?.cookieVendorsDetected).map((s) => str(s)),
      },
      trackingScripts: safeArr(scan?.trackingScriptsDetected).map((s) => str(s)),
      forms: {
        detected: num(scan?.formsDetected, 0),
        personalDataSignals: num(scan?.formsPersonalDataSignals, 0),
      },
      accessibility: {
        notes: safeArr(scan?.accessibilityNotes).map((s) => str(s)),
        images: {
          total: num(scan?.totalImages, 0),
          missingAlt: num(scan?.imagesMissingAlt, 0),
        },
      },
      contact: {
        detected: bool(scan?.contactInfoPresent),
      },
    },
  };
}

function normalizeStructured(scan) {
  const meta = scan?.meta || {};
  const coverage = scan?.coverage || {};
  const signals = scan?.signals || {};

  return {
    meta: {
      url: str(meta?.url),
      hostname: str(meta?.hostname),
      scanId: str(meta?.scanId),
      scannedAt: str(meta?.scannedAt),
      https: bool(meta?.https),
    },
    coverage: {
      notes: safeArr(coverage?.notes).map((s) => str(s)),
      checkedPages: safeArr(coverage?.checkedPages).map((p) => ({
        url: str(p?.url),
        status: num(p?.status, 0),
      })),
      failedPages: safeArr(coverage?.failedPages).map((p) => ({
        url: str(p?.url),
        status: num(p?.status, 0),
      })),
    },
    signals: {
      policies: {
        privacy: bool(signals?.policies?.privacy),
        terms: bool(signals?.policies?.terms),
        cookies: bool(signals?.policies?.cookies),
      },
      consent: {
        bannerDetected: bool(signals?.consent?.bannerDetected),
        vendors: safeArr(signals?.consent?.vendors).map((s) => str(s)),
      },
      trackingScripts: safeArr(signals?.trackingScripts).map((s) => str(s)),
      forms: {
        detected: num(signals?.forms?.detected, 0),
        personalDataSignals: num(signals?.forms?.personalDataSignals, 0),
      },
      accessibility: {
        notes: safeArr(signals?.accessibility?.notes).map((s) => str(s)),
        images: {
          total: num(signals?.accessibility?.images?.total, 0),
          missingAlt: num(signals?.accessibility?.images?.missingAlt, 0),
        },
      },
      contact: {
        detected: bool(signals?.contact?.detected),
      },
    },
  };
}

export function computeIntegrityHash(scan) {
  // If report.js passes a normalized structured model already, we still normalize it
  // into the canonical payload format (stable keys / stable types).
  const looksStructured = !!scan?.meta && !!scan?.signals;
  const normalized = looksStructured ? normalizeStructured(scan) : normalizeLegacy(scan);

  // Objective facts only (explicit)
  const payload = {
    meta: normalized.meta,
    coverage: {
      notes: normalized.coverage.notes,
      checkedPages: normalized.coverage.checkedPages,
      failedPages: normalized.coverage.failedPages,
      // NOTE: fetchOk/fetchStatus are *derived* from coverage in structured model, so we do not hash them separately.
      // If you ever re-add them, ensure they are objective and consistent.
    },
    signals: normalized.signals,
  };

  const canonical = stableStringify(payload);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
