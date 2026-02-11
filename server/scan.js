// server/scan.js
// AUDIT-GRADE — structured + legacy-flat, scope-locked, deterministic scanner
// - Returns structured model for /preview-scan UI
// - ALSO returns flat legacy fields for paid PDF + integrity hashing compatibility

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

  // Return merged object so:
  // - /preview-scan can use structured: meta/coverage/signals/risk
  // - paid report + integrity + verify can use flat keys
  return { ...flat, ...structured, risk: structured.risk };
}
