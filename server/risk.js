// server/risk.js
// Signal-based exposure scoring (NOT legal compliance)
// Supports both legacy flat scan output and the new structured scan output.

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pct(n, d) {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 100);
}

function hasAnyCheckedPages(data) {
  const checked =
    data?.coverage?.checkedPages ||
    data?.checkedPages ||
    [];
  return Array.isArray(checked) && checked.length > 0;
}

/**
 * Normalizes both scan shapes (legacy flat + new structured) into one view model.
 */
function normalizeSignals(data) {
  const structured = !!data?.meta && !!data?.signals;

  // Structured
  if (structured) {
    const https = !!data?.meta?.https;

    const policies = data?.signals?.policies || {};
    const consent = data?.signals?.consent || {};
    const forms = data?.signals?.forms || {};
    const accessibility = data?.signals?.accessibility || {};
    const images = accessibility?.images || {};
    const contact = data?.signals?.contact || {};

    return {
      // meta
      https,

      // policies
      hasPrivacyPolicy: !!policies?.privacy,
      hasTerms: !!policies?.terms,
      hasCookiePolicy: !!policies?.cookies,

      // consent / tracking
      hasCookieBanner: !!consent?.bannerDetected,
      cookieVendorsDetected: safeArr(consent?.vendors),
      trackingScriptsDetected: safeArr(data?.signals?.trackingScripts),

      // forms
      formsDetected: num(forms?.detected),
      formsPersonalDataSignals: num(forms?.personalDataSignals),

      // images / a11y
      totalImages: num(images?.total),
      imagesMissingAlt: num(images?.missingAlt),

      // contact
      contactInfoPresent: !!contact?.detected,

      // coverage
      fetchOk: hasAnyCheckedPages(data),
    };
  }

  // Legacy flat
  return {
    https: !!data?.https,

    hasPrivacyPolicy: !!data?.hasPrivacyPolicy,
    hasTerms: !!data?.hasTerms,
    hasCookiePolicy: !!data?.hasCookiePolicy,

    hasCookieBanner: !!data?.hasCookieBanner,
    cookieVendorsDetected: safeArr(data?.cookieVendorsDetected),
    trackingScriptsDetected: safeArr(data?.trackingScriptsDetected),

    formsDetected: num(data?.formsDetected),
    formsPersonalDataSignals: num(data?.formsPersonalDataSignals),

    totalImages: num(data?.totalImages),
    imagesMissingAlt: num(data?.imagesMissingAlt),

    contactInfoPresent: !!data?.contactInfoPresent,

    // legacy had explicit fetchOk; fall back to checkedPages existence if not present
    fetchOk:
      data?.fetchOk === false
        ? false
        : data?.fetchOk === true
          ? true
          : hasAnyCheckedPages(data),
  };
}

export function computeRisk(data) {
  const s = normalizeSignals(data);

  // If scan failed / no pages retrieved, we can’t confidently evaluate signals.
  if (s.fetchOk === false) {
    return {
      level: "High",
      score: 9,
      reasons: [
        "No HTML pages could be retrieved for analysis, limiting detection coverage.",
      ],
    };
  }

  const trackers = safeArr(s.trackingScriptsDetected);
  const vendors = safeArr(s.cookieVendorsDetected);

  const missingPrivacy = !s.hasPrivacyPolicy;
  const missingTerms = !s.hasTerms;
  const missingCookiePolicy = !s.hasCookiePolicy;

  const hasConsent = !!s.hasCookieBanner;
  const hasTracking = trackers.length > 0 || vendors.length > 0;

  const forms = num(s.formsDetected);
  const pdataSignals = num(s.formsPersonalDataSignals);

  const totalImages = num(s.totalImages);
  const missingAlt = num(s.imagesMissingAlt);
  const altMissingPct = totalImages > 0 ? pct(missingAlt, totalImages) : 0;

  let score = 0;
  const reasons = [];

  if (!s.https) {
    score += 3;
    reasons.push("HTTPS was not detected.");
  }

  if (missingPrivacy) {
    score += 2;
    reasons.push("Privacy policy was not detected on common public paths.");
  }
  if (missingTerms) {
    score += 1;
    reasons.push("Terms were not detected on common public paths.");
  }
  if (missingCookiePolicy) {
    score += 1;
    reasons.push("Cookie policy was not detected on common public paths.");
  }

  if (hasTracking && !hasConsent) {
    score += 3;
    reasons.push(
      "Tracking/cookie vendor signals were detected but a consent banner indicator was not detected (heuristic)."
    );
  } else if (hasTracking) {
    score += 1;
    reasons.push("Tracking/cookie vendor signals were detected.");
  } else {
    reasons.push(
      "No common tracking scripts or cookie vendor signals were detected."
    );
  }

  if (forms > 0 && pdataSignals > 0) {
    score += 2;
    reasons.push(
      "Forms were detected with potential personal-data field signals (heuristic)."
    );
  } else if (forms > 0) {
    score += 1;
    reasons.push("Forms were detected on the public-facing surface.");
  }

  if (totalImages >= 5 && altMissingPct >= 30) {
    score += 2;
    reasons.push(
      `Many images appear to be missing alt text (${missingAlt} of ${totalImages}).`
    );
  } else if (totalImages >= 5 && altMissingPct >= 10) {
    score += 1;
    reasons.push(
      `Some images appear to be missing alt text (${missingAlt} of ${totalImages}).`
    );
  }

  if (!s.contactInfoPresent) {
    score += 1;
    reasons.push(
      "Contact/business identity signals were not detected on the scanned surface."
    );
  }

  score = clamp(score, 0, 12);

  let level = "Low";
  if (score >= 7) level = "High";
  else if (score >= 4) level = "Medium";

  return { level, score, reasons };
}
