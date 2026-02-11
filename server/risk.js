// server/risk.js
// Signal-based exposure scoring (NOT legal compliance)

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

export function computeRisk(data) {
  // If scan failed, we can’t confidently evaluate signals.
  if (data.fetchOk === false) {
    return {
      level: "High",
      score: 9,
      reasons: [
        "Homepage/policy pages could not be retrieved for analysis, limiting detection coverage.",
      ],
    };
  }

  const trackers = safeArr(data.trackingScriptsDetected);
  const vendors = safeArr(data.cookieVendorsDetected);

  const missingPrivacy = !data.hasPrivacyPolicy;
  const missingTerms = !data.hasTerms;
  const missingCookiePolicy = !data.hasCookiePolicy;

  const hasConsent = !!data.hasCookieBanner;
  const hasTracking = trackers.length > 0 || vendors.length > 0;

  const forms = num(data.formsDetected);
  const pdataSignals = num(data.formsPersonalDataSignals);

  const totalImages = num(data.totalImages);
  const missingAlt = num(data.imagesMissingAlt);
  const altMissingPct = totalImages > 0 ? pct(missingAlt, totalImages) : 0;

  let score = 0;
  const reasons = [];

  if (!data.https) {
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
    reasons.push("No common tracking scripts or cookie vendor signals were detected.");
  }

  if (forms > 0 && pdataSignals > 0) {
    score += 2;
    reasons.push("Forms were detected with potential personal-data field signals (heuristic).");
  } else if (forms > 0) {
    score += 1;
    reasons.push("Forms were detected on the public-facing surface.");
  }

  if (totalImages >= 5 && altMissingPct >= 30) {
    score += 2;
    reasons.push(`Many images appear to be missing alt text (${missingAlt} of ${totalImages}).`);
  } else if (totalImages >= 5 && altMissingPct >= 10) {
    score += 1;
    reasons.push(`Some images appear to be missing alt text (${missingAlt} of ${totalImages}).`);
  }

  if (!data.contactInfoPresent) {
    score += 1;
    reasons.push("Contact/business identity signals were not detected on the scanned surface.");
  }

  score = clamp(score, 0, 12);

  let level = "Low";
  if (score >= 7) level = "High";
  else if (score >= 4) level = "Medium";

  return { level, score, reasons };
}
