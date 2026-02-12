// server/scan.js
// AUDIT-GRADE — structured + legacy-flat, scope-locked, deterministic scanner
// - Returns structured model for /preview-scan UI
// - ALSO returns flat legacy fields for paid PDF + integrity hashing compatibility
// - ✅ Adds deterministic findingsText[] (strings) + findings[] (structured objects) for boutique PDF risk register

import * as cheerio from "cheerio";
import crypto from "crypto";
import { computeRisk } from "./risk.js";

const USER_AGENT =
  "WebsiteRiskCheckBot/1.0 (+https://www.websiteriskcheck.com)";

const MAX_PAGES = 6;
const FETCH_TIMEOUT_MS = 9000;

const STANDARD_PATHS = [
  "/privacy",
  "/privacy-policy",
  "/terms",
  "/terms-and-conditions",
  "/cookie-policy",
  "/contact",
];

/* =========================
   URL HELPERS
========================= */

function normalizeUrl(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    return u.toString();
  } catch {
    return `https://${String(input || "").replace(/^\/+/, "")}`;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function baseOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return {
    ctrl,
    wrapped: promise(ctrl.signal).finally(() => clearTimeout(t)),
  };
}

/* =========================
   FETCH (HTML ONLY)
========================= */

async function fetchHtml(url) {
  const { wrapped } = withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { ok: false, status: res.status, html: "", finalUrl: res.url };
    }

    const html = await res.text();
    return { ok: res.ok, status: res.status, html, finalUrl: res.url };
  }, FETCH_TIMEOUT_MS);

  try {
    return await wrapped;
  } catch (e) {
    return {
      ok: false,
      status: 0,
      html: "",
      finalUrl: url,
      error: String(e?.message || e),
    };
  }
}

/* =========================
   DETECTION HELPERS
========================= */

function detectTracking(html) {
  const found = [];

  if (/googletagmanager\.com\/gtag\/js\?id=G-/i.test(html))
    found.push("Google Analytics (GA4)");
  if (/google-analytics\.com\/analytics\.js/i.test(html))
    found.push("Google Analytics (UA)");
  if (/googletagmanager\.com\/gtm\.js\?id=GTM-/i.test(html))
    found.push("Google Tag Manager");
  if (/connect\.facebook\.net\/.*\/fbevents\.js/i.test(html))
    found.push("Meta Pixel");
  if (/static\.hotjar\.com\/c\/hotjar-/i.test(html))
    found.push("Hotjar");
  if (/snap\.licdn\.com\/li\.lms-analytics/i.test(html))
    found.push("LinkedIn Insight");
  if (/analytics\.tiktok\.com\/i18n\/pixel/i.test(html))
    found.push("TikTok Pixel");

  return Array.from(new Set(found));
}

function detectCookieVendors(html) {
  const vendors = [];

  if (/cookiebot/i.test(html)) vendors.push("Cookiebot");
  if (/onetrust|cookielaw\.org/i.test(html)) vendors.push("OneTrust");
  if (/quantcast/i.test(html)) vendors.push("Quantcast");
  if (/trustarc/i.test(html)) vendors.push("TrustArc");
  if (/iubenda/i.test(html)) vendors.push("iubenda");
  if (/osano/i.test(html)) vendors.push("Osano");

  return Array.from(new Set(vendors));
}

function detectCookieBannerHeuristic($) {
  const text = $("body").text().toLowerCase();

  const keywordMatch =
    text.includes("cookie") &&
    (text.includes("consent") ||
      text.includes("preferences") ||
      text.includes("accept"));

  const domMatch =
    $(
      '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]'
    ).length > 0;

  return keywordMatch || domMatch;
}

function detectPolicyLinks($, baseUrl) {
  const links = [];

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {}
  });

  return {
    privacy: links.some((l) => /privacy/i.test(l)),
    terms: links.some((l) => /terms|conditions/i.test(l)),
    cookies: links.some((l) => /cookie/i.test(l)),
  };
}

function detectForms($) {
  const forms = $("form");
  let personalSignals = 0;

  forms.find("input, textarea, select").each((_, el) => {
    const joined = [
      $(el).attr("type"),
      $(el).attr("name"),
      $(el).attr("id"),
      $(el).attr("placeholder"),
    ]
      .join(" ")
      .toLowerCase();

    if (
      joined.includes("email") ||
      joined.includes("phone") ||
      joined.includes("name") ||
      joined.includes("address") ||
      joined.includes("postcode") ||
      joined.includes("zip")
    ) {
      personalSignals++;
    }
  });

  return {
    formsDetected: forms.length,
    formsPersonalDataSignals: personalSignals,
  };
}

function detectAccessibility($) {
  const notes = [];

  if (!$("html").attr("lang"))
    notes.push("No <html lang> attribute detected.");

  if ($("h1").length === 0) notes.push("No H1 heading detected.");
  if ($("h1").length > 1) notes.push("Multiple H1 headings detected.");

  return notes;
}

function detectImagesMissingAlt($) {
  const imgs = $("img");
  let missing = 0;

  imgs.each((_, img) => {
    const alt = $(img).attr("alt");
    if (!alt || !alt.trim()) missing++;
  });

  return { totalImages: imgs.length, imagesMissingAlt: missing };
}

function detectContactInfo($) {
  const text = $("body").text().toLowerCase();

  return (
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) ||
    /\+?\d[\d\s().-]{7,}\d/.test(text) ||
    $('a[href*="contact" i]').length > 0
  );
}

function safePath(u) {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return "/";
  }
}

/* =========================
   FINDINGS (DETERMINISTIC)
   - findingsText: short human strings for UI
   - findings: structured objects for boutique PDF risk register
========================= */

function labelProb(v) {
  if (v >= 5) return "Almost certain";
  if (v === 4) return "Likely";
  if (v === 3) return "Possible";
  if (v === 2) return "Unlikely";
  return "Rare";
}

function labelImpact(v) {
  if (v >= 5) return "Severe";
  if (v === 4) return "Major";
  if (v === 3) return "Moderate";
  if (v === 2) return "Minor";
  return "Low";
}

function buildFindings(meta, coverage, signals) {
  const findings = [];
  const findingsText = [];

  const checked = Array.isArray(coverage?.checkedPages) ? coverage.checkedPages : [];
  const failed = Array.isArray(coverage?.failedPages) ? coverage.failedPages : [];

  const trackers = Array.isArray(signals?.trackingScripts) ? signals.trackingScripts : [];
  const vendors =
    Array.isArray(signals?.consent?.vendors) ? signals.consent.vendors : [];

  const formsDetected = Number(signals?.forms?.detected || 0);
  const pdataSignals = Number(signals?.forms?.personalDataSignals || 0);

  const totalImages = Number(signals?.accessibility?.images?.total || 0);
  const missingAlt = Number(signals?.accessibility?.images?.missingAlt || 0);
  const altPct = totalImages > 0 ? Math.round((missingAlt / totalImages) * 100) : 0;

  const hasPrivacy = !!signals?.policies?.privacy;
  const hasTerms = !!signals?.policies?.terms;
  const hasCookiePolicy = !!signals?.policies?.cookies;
  const hasConsent = !!signals?.consent?.bannerDetected;

  const hasTracking = trackers.length > 0 || vendors.length > 0;
  const hasContact = !!signals?.contact?.detected;

  // 0) Coverage / fetch health (always include as first)
  {
    const prob = checked.length ? 1 : 4;
    const impact = checked.length ? 2 : 4;
    const score = prob * impact;

    const desc = checked.length
      ? "Public pages were retrieved for analysis using a scope-locked approach (homepage + standard policy/contact paths)."
      : "No public HTML pages could be retrieved for analysis, limiting detection coverage and increasing uncertainty.";

    findings.push({
      id: "coverage",
      category: "Coverage",
      description: desc,
      probability: { value: prob, label: labelProb(prob) },
      impact: { value: impact, label: labelImpact(impact) },
      score,
      timing: "At scan time; affects interpretability of all detections.",
      trigger: checked.length ? "Successful retrieval of public HTML." : "Fetch failure / blocked / non-HTML responses.",
      mitigation: checked.length
        ? "For broader assurance, run a repeat scan after major changes or validate key pages manually."
        : "Check site availability, robots/WAF rules, and ensure key pages are publicly accessible before re-running.",
      evidence: {
        checkedPaths: checked.map((p) => safePath(p.url)),
        failedPaths: failed.map((p) => `${safePath(p.url)} (HTTP ${p.status || 0})`),
      },
    });

    findingsText.push(
      checked.length
        ? `Coverage: retrieved ${checked.length} page(s) (scope-locked)`
        : "Coverage: no pages retrieved (scan limited)"
    );
  }

  // 1) HTTPS
  {
    const https = !!meta?.https;
    if (!https) {
      const prob = 3;
      const impact = 4;
      const score = prob * impact;
      findings.push({
        id: "https",
        category: "Security",
        description: "HTTPS was not detected for the target URL. This can increase interception risk and reduce visitor trust.",
        probability: { value: prob, label: labelProb(prob) },
        impact: { value: impact, label: labelImpact(impact) },
        score,
        timing: "Present whenever users access the site over HTTP.",
        trigger: "Target URL does not resolve over HTTPS.",
        mitigation: "Enable HTTPS site-wide and enforce redirects (HSTS where appropriate).",
        evidence: { httpsDetected: false },
      });
      findingsText.push("HTTPS: not detected");
    } else {
      findingsText.push("HTTPS: detected");
    }
  }

  // 2) Policies
  {
    const missing = (!hasPrivacy ? 1 : 0) + (!hasTerms ? 1 : 0) + (!hasCookiePolicy ? 1 : 0);

    const prob = missing === 0 ? 1 : missing === 1 ? 3 : 4;
    const impact = missing >= 2 ? 4 : missing === 1 ? 3 : 2;
    const score = prob * impact;

    const desc =
      missing === 0
        ? "Standard policy pages were detected on common public paths."
        : "One or more standard policy pages were not detected on common public paths (privacy/terms/cookie policy).";

    findings.push({
      id: "policies",
      category: "Compliance",
      description: desc,
      probability: { value: prob, label: labelProb(prob) },
      impact: { value: impact, label: labelImpact(impact) },
      score,
      timing: "Present throughout the public lifecycle of the website.",
      trigger: "Policy pages missing, not linked, or not accessible on standard public paths.",
      mitigation:
        "Publish and link policy pages from the footer/homepage. Ensure wording matches actual data practices and vendor usage.",
      evidence: {
        privacyDetected: hasPrivacy,
        termsDetected: hasTerms,
        cookiePolicyDetected: hasCookiePolicy,
      },
    });

    findingsText.push(`Privacy policy: ${hasPrivacy ? "detected" : "not detected"}`);
    findingsText.push(`Terms: ${hasTerms ? "detected" : "not detected"}`);
    findingsText.push(`Cookie policy: ${hasCookiePolicy ? "detected" : "not detected"}`);
  }

  // 3) Tracking + consent
  {
    if (hasTracking) {
      const prob = 4;
      const impact = 4;
      const score = prob * impact;

      const consentNote = hasConsent
        ? "A consent banner indicator was detected (heuristic)."
        : "A consent banner indicator was not detected (heuristic).";

      findings.push({
        id: "tracking-consent",
        category: "Tracking & Consent",
        description:
          `Third-party tracking/cookie vendor signals were detected. ${consentNote} Misalignment between scripts and consent/disclosure can increase exposure.`,
        probability: { value: prob, label: labelProb(prob) },
        impact: { value: impact, label: labelImpact(impact) },
        score,
        timing: "Present whenever marketing tags/vendors are deployed on public pages.",
        trigger: "Detected tracking script patterns and/or consent vendor markers in HTML.",
        mitigation:
          "Review tag inventory and vendor list. Validate consent flow for target regions. Ensure disclosures match deployed scripts.",
        evidence: {
          consentBannerHeuristic: hasConsent,
          trackingScripts: trackers,
          cookieVendors: vendors,
        },
      });

      findingsText.push(
        `Tracking scripts: detected (${trackers.slice(0, 4).join(", ")}${trackers.length > 4 ? "…" : ""})`
      );
      findingsText.push(
        `Cookie vendor signals: detected (${vendors.slice(0, 4).join(", ")}${vendors.length > 4 ? "…" : ""})`
      );
      findingsText.push(
        hasConsent
          ? "Consent banner indicator: detected (heuristic)"
          : "Consent banner indicator: not detected (heuristic)"
      );
    } else {
      findingsText.push("Tracking scripts: none detected");
      findingsText.push("Cookie vendor signals: none detected");
      findingsText.push(
        hasConsent
          ? "Consent banner indicator: detected (heuristic)"
          : "Consent banner indicator: not detected (heuristic)"
      );
    }
  }

  // 4) Forms / personal data signals
  {
    if (formsDetected > 0) {
      const prob = pdataSignals > 0 ? 4 : 3;
      const impact = 4;
      const score = prob * impact;

      findings.push({
        id: "forms",
        category: "Data Capture",
        description:
          "Forms were detected on the public surface. If forms collect personal data, inadequate transparency, retention, or access controls can increase operational and compliance risk.",
        probability: { value: prob, label: labelProb(prob) },
        impact: { value: impact, label: labelImpact(impact) },
        score,
        timing: "Present whenever forms are live and receiving submissions.",
        trigger: "Forms and/or common personal-data field patterns detected (heuristic).",
        mitigation:
          "Audit form fields for minimum necessary data. Confirm storage/access controls/retention. Align privacy disclosures and confirmations.",
        evidence: {
          formsDetected,
          personalDataFieldSignals: pdataSignals,
        },
      });

      findingsText.push(`Forms detected: ${formsDetected}`);
      findingsText.push(`Potential personal-data field signals: ${pdataSignals} (heuristic)`);
    } else {
      findingsText.push("Forms detected: none");
    }
  }

  // 5) Accessibility (alt text)
  {
    if (totalImages > 0) {
      const prob = altPct >= 30 ? 4 : altPct >= 10 ? 3 : altPct > 0 ? 2 : 1;
      const impact = altPct >= 30 ? 3 : altPct >= 10 ? 2 : 1;
      const score = prob * impact;

      findings.push({
        id: "alt-text",
        category: "Accessibility",
        description:
          "Alt text gaps were detected on images. Missing descriptions may reduce accessibility and can become a risk depending on jurisdiction, audience, and page importance.",
        probability: { value: prob, label: labelProb(prob) },
        impact: { value: impact, label: labelImpact(impact) },
        score,
        timing: "Present on affected pages where images lack descriptions.",
        trigger: "Images missing alt attributes or empty alt text (heuristic).",
        mitigation:
          "Add alt text to meaningful images on key pages (conversion pages and policy/contact pages first).",
        evidence: {
          totalImages,
          imagesMissingAlt: missingAlt,
          missingAltPercent: altPct,
        },
      });

      findingsText.push(`Images missing alt text: ${missingAlt} of ${totalImages}`);
    } else {
      findingsText.push("Images: none detected on scanned pages");
    }
  }

  // 6) Contact / identity
  {
    const prob = hasContact ? 1 : 3;
    const impact = hasContact ? 1 : 2;
    const score = prob * impact;

    findings.push({
      id: "contact",
      category: "Trust",
      description:
        hasContact
          ? "Contact/business identity signals were detected on the scanned surface."
          : "Contact/business identity signals were not detected on the scanned surface, which can reduce trust and conversion.",
      probability: { value: prob, label: labelProb(prob) },
      impact: { value: impact, label: labelImpact(impact) },
      score,
      timing: "Present on landing and checkout journeys.",
      trigger: "No email/phone/contact link detected on scanned pages (heuristic).",
      mitigation:
        "Ensure a visible Contact page and footer identity details (email/phone/address where appropriate).",
      evidence: { contactDetected: hasContact },
    });

    findingsText.push(hasContact ? "Contact/identity signals: detected" : "Contact/identity signals: not detected");
  }

  // Keep findings deterministic order
  return { findings, findingsText };
}

/* =========================
   MAIN SCAN
========================= */

export async function scanWebsite(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const scanId = crypto.randomBytes(6).toString("hex");
  const scannedAt = Date.now();

  const hostname = safeHostname(url);
  const origin = baseOrigin(url);
  const https = url.startsWith("https://");

  const targets = [
    url,
    ...STANDARD_PATHS.map((p) => {
      try {
        return new URL(p, origin).toString();
      } catch {
        return null;
      }
    }).filter(Boolean),
  ].slice(0, MAX_PAGES);

  const checkedPages = [];
  const failedPages = [];

  let anyFetchOk = false;
  let firstStatus = 0;

  // Structured aggregates
  const policies = { privacy: false, terms: false, cookies: false };
  const consentVendors = new Set();
  let consentBannerDetected = false;

  const trackingSet = new Set();

  let formsDetectedTotal = 0;
  let formsPersonalSignalsTotal = 0;

  let totalImagesTotal = 0;
  let imagesMissingAltTotal = 0;

  const accessibilityNotes = new Set();
  let contactInfoDetected = false;

  // Fetch each target (same-origin enforced)
  for (const t of targets) {
    try {
      const tu = new URL(t);
      if (`${tu.protocol}//${tu.host}` !== origin) continue;
    } catch {
      continue;
    }

    const res = await fetchHtml(t);

    if (!firstStatus) firstStatus = res.status || 0;

    if (!res.ok || !res.html) {
      failedPages.push({ url: t, status: res.status || 0 });
      continue;
    }

    anyFetchOk = true;
    checkedPages.push({ url: t, status: res.status || 200 });

    const $ = cheerio.load(res.html);

    // Homepage link-based detection
    if (t === url) {
      const linkPolicies = detectPolicyLinks($, url);
      policies.privacy ||= !!linkPolicies.privacy;
      policies.terms ||= !!linkPolicies.terms;
      policies.cookies ||= !!linkPolicies.cookies;
    }

    // Path-based policy detection: if the page exists, count as present
    const pathname = safePath(t).toLowerCase();
    if (pathname === "/privacy" || pathname === "/privacy-policy")
      policies.privacy = true;
    if (pathname === "/terms" || pathname === "/terms-and-conditions")
      policies.terms = true;
    if (pathname === "/cookie-policy") policies.cookies = true;

    // Tracking / consent vendors
    detectTracking(res.html).forEach((s) => trackingSet.add(s));
    detectCookieVendors(res.html).forEach((v) => consentVendors.add(v));

    // Banner signal (heuristic)
    if (detectCookieBannerHeuristic($)) consentBannerDetected = true;

    // Forms
    const formData = detectForms($);
    formsDetectedTotal += formData.formsDetected;
    formsPersonalSignalsTotal += formData.formsPersonalDataSignals;

    // Images / a11y
    const imgData = detectImagesMissingAlt($);
    totalImagesTotal += imgData.totalImages;
    imagesMissingAltTotal += imgData.imagesMissingAlt;

    detectAccessibility($).forEach((n) => accessibilityNotes.add(n));

    // Contact
    if (!contactInfoDetected && detectContactInfo($)) contactInfoDetected = true;
  }

  // Coverage notes (kept identical to paid report copy)
  const checkedList =
    checkedPages.map((p) => safePath(p.url)).join(", ") || "none";

  const failedList = failedPages.length
    ? failedPages
        .map((p) => `${safePath(p.url)} (HTTP ${p.status || 0})`)
        .join(", ")
    : "none";

  const coverageNotes = anyFetchOk
    ? [
        "Homepage + standard policy/contact paths only (max 6 pages).",
        "Public, unauthenticated HTML only.",
        "No full crawl or behavioural simulation.",
        `Checked: ${checkedList}`,
        `Failed: ${failedList}`,
      ]
    : [
        "Attempted: homepage + standard policy/contact paths.",
        `Attempted pages: ${targets.map((u) => safePath(u)).join(", ")}`,
      ];

  // Structured model
  const structured = {
    meta: {
      url,
      hostname,
      scanId,
      scannedAt, // number (ms) for consistency with PDF + integrity
      https,
    },
    coverage: {
      checkedPages,
      failedPages,
      notes: coverageNotes,
      fetchOk: anyFetchOk,
      fetchStatus: anyFetchOk ? firstStatus || 200 : firstStatus || 0,
    },
    signals: {
      policies,
      consent: {
        bannerDetected: consentBannerDetected || consentVendors.size > 0,
        vendors: Array.from(consentVendors),
      },
      trackingScripts: Array.from(trackingSet),
      forms: {
        detected: formsDetectedTotal,
        personalDataSignals: formsPersonalSignalsTotal,
      },
      accessibility: {
        notes: Array.from(accessibilityNotes),
        images: { total: totalImagesTotal, missingAlt: imagesMissingAltTotal },
      },
      contact: { detected: contactInfoDetected },
    },
  };

  // Legacy/flat fields for existing report.js + integrity.js + verify flow
  const flat = {
    url,
    hostname,
    scanId,
    scannedAt,
    https,

    fetchOk: anyFetchOk,
    fetchStatus: anyFetchOk ? firstStatus || 200 : firstStatus || 0,

    hasPrivacyPolicy: !!policies.privacy,
    hasTerms: !!policies.terms,
    hasCookiePolicy: !!policies.cookies,
    hasCookieBanner: !!(structured.signals.consent.bannerDetected),

    cookieVendorsDetected: structured.signals.consent.vendors,
    trackingScriptsDetected: structured.signals.trackingScripts,

    formsDetected: formsDetectedTotal,
    formsPersonalDataSignals: formsPersonalSignalsTotal,

    totalImages: totalImagesTotal,
    imagesMissingAlt: imagesMissingAltTotal,
    accessibilityNotes: structured.signals.accessibility.notes,

    contactInfoPresent: contactInfoDetected,

    checkedPages,
    failedPages,
    scanCoverageNotes: coverageNotes,
  };

  // Risk computed from FLAT shape (so it matches your current risk.js logic)
  const risk = computeRisk(flat);

  structured.risk = {
    level: risk.level,
    score: risk.score,
    reasons: risk.reasons,
  };

  // ✅ Deterministic findings (both text + structured objects)
  const { findings, findingsText } = buildFindings(
    structured.meta,
    structured.coverage,
    structured.signals
  );

  structured.findings = findings;
  structured.findingsText = findingsText;

  // Return merged object so:
  // - /preview-scan can use structured: meta/coverage/signals/risk/findings/findingsText
  // - paid report + integrity + verify can use flat keys
  return {
    ...flat,
    ...structured,
    risk: structured.risk,
    findings: structured.findings,
    findingsText: structured.findingsText,
  };
}
