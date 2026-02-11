// server/integrity.js
import crypto from "crypto";

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function computeIntegrityHash(scan) {
  // Objective facts only
  const payload = {
    url: scan.url,
    hostname: scan.hostname,
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,

    https: scan.https,
    fetchOk: scan.fetchOk,
    fetchStatus: scan.fetchStatus,

    hasPrivacyPolicy: scan.hasPrivacyPolicy,
    hasTerms: scan.hasTerms,
    hasCookiePolicy: scan.hasCookiePolicy,
    hasCookieBanner: scan.hasCookieBanner,

    trackingScriptsDetected: safeArr(scan.trackingScriptsDetected),
    cookieVendorsDetected: safeArr(scan.cookieVendorsDetected),

    formsDetected: num(scan.formsDetected),
    formsPersonalDataSignals: num(scan.formsPersonalDataSignals),

    totalImages: num(scan.totalImages),
    imagesMissingAlt: num(scan.imagesMissingAlt),

    accessibilityNotes: safeArr(scan.accessibilityNotes),
    contactInfoPresent: scan.contactInfoPresent,

    scanCoverageNotes: safeArr(scan.scanCoverageNotes),

    // Optional: include per-page coverage for stronger verification
    checkedPages: safeArr(scan.checkedPages),
    failedPages: safeArr(scan.failedPages),
  };

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
