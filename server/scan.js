// server/scan.js
// AUDIT-GRADE — scope-locked, deterministic, evidence-only scanner (expanded coverage + risk)

import * as cheerio from "cheerio";
import crypto from "crypto";
import { computeRisk } from "./risk.js";

const USER_AGENT =
  "WebsiteRiskCheckBot/1.0 (+https://www.websiteriskcheck.com)";

// Hard limits so we never become a crawler
const MAX_PAGES = 6; // homepage + up to 5 standard paths
const FETCH_TIMEOUT_MS = 9000;

// Standard paths (tight scope)
const STANDARD_PATHS = [
  "/privacy",
  "/privacy-policy",
  "/terms",
  "/terms-and-conditions",
  "/cookie-policy",
  "/contact",
];

/* =========================
   URL NORMALISATION
========================= */

function normalizeUrl(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    return u.toString();
  } catch {
    return `https://${input.replace(/^\/+/, "")}`;
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
   TRACKING SCRIPTS (KNOWN)
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

/* =========================
   COOKIE CONSENT VENDORS
========================= */

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

/* =========================
   COOKIE BANNER (HEURISTIC)
========================= */

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

/* =========================
   POLICY LINKS (HOMEPAGE ONLY, STILL USED)
========================= */

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

/* =========================
   FORMS
========================= */

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

/* =========================
   ACCESSIBILITY SIGNALS
========================= */

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

/* =========================
   CONTACT INFO
========================= */

function detectContactInfo($) {
  const text = $("body").text().toLowerCase();

  return (
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) ||
    /\+?\d[\d\s().-]{7,}\d/.test(text) ||
    $('a[href*="contact" i]').length > 0
  );
}

/* =========================
   PAGE LIST (SCOPE-LOCKED)
========================= */

function buildCandidateUrls(homeUrl) {
  const origin = baseOrigin(homeUrl);
  const out = [homeUrl];

  for (const p of STANDARD_PATHS) {
    if (out.length >= MAX_PAGES) break;
    try {
      out.push(new URL(p, origin).toString());
    } catch {}
  }

  // de-dupe
  return Array.from(new Set(out));
}

function pathOf(u) {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return "/";
  }
}

function finalize(result) {
  const risk = computeRisk(result);
  result.riskLevel = risk.level;
  result.riskScore = risk.score;
  result.riskReasons = risk.reasons;
  return result;
}

/* =========================
   MAIN SCAN
========================= */

export async function scanWebsite(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const scanId = crypto.randomBytes(6).toString("hex");
  const scannedAt = Date.now();
  const https = url.startsWith("https://");

  const hostname = safeHostname(url);
  const origin = baseOrigin(url);
  const targets = buildCandidateUrls(url);

  // Aggregates
  let anyFetchOk = false;
  let firstStatus = 0;

  let hasPrivacyPolicy = false;
  let hasTerms = false;
  let hasCookiePolicy = false;
  let hasCookieBanner = false;

  const trackingSet = new Set();
  const vendorSet = new Set();

  let formsDetectedTotal = 0;
  let formsPersonalSignalsTotal = 0;

  let totalImagesTotal = 0;
  let imagesMissingAltTotal = 0;

  const accessibilityNotes = new Set();
  let contactInfoPresent = false;

  const checkedPages = [];
  const failedPages = [];

  // Fetch each target (tight scope, same origin enforced)
  for (const t of targets) {
    // enforce same host/origin (prevents weird redirects to CDNs etc.)
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

    // On homepage, still detect link policies (useful)
    if (t === url) {
      const linkPolicies = detectPolicyLinks($, url);
      hasPrivacyPolicy = hasPrivacyPolicy || !!linkPolicies.privacy;
      hasTerms = hasTerms || !!linkPolicies.terms;
      hasCookiePolicy = hasCookiePolicy || !!linkPolicies.cookies;
    }

    // Path-based policy detection: if the page exists, count as present
    try {
      const pathname = new URL(t).pathname.toLowerCase();
      if (pathname === "/privacy" || pathname === "/privacy-policy")
        hasPrivacyPolicy = true;
      if (pathname === "/terms" || pathname === "/terms-and-conditions")
        hasTerms = true;
      if (pathname === "/cookie-policy") hasCookiePolicy = true;
    } catch {}

    // Trackers/vendors across all checked pages
    for (const s of detectTracking(res.html)) trackingSet.add(s);
    for (const v of detectCookieVendors(res.html)) vendorSet.add(v);

    // Banner signal: heuristic on any checked page
    if (detectCookieBannerHeuristic($)) hasCookieBanner = true;

    // Forms/images/accessibility/contact aggregated
    const forms = detectForms($);
    formsDetectedTotal += forms.formsDetected;
    formsPersonalSignalsTotal += forms.formsPersonalDataSignals;

    const imgs = detectImagesMissingAlt($);
    totalImagesTotal += imgs.totalImages;
    imagesMissingAltTotal += imgs.imagesMissingAlt;

    for (const n of detectAccessibility($)) accessibilityNotes.add(n);

    if (!contactInfoPresent && detectContactInfo($)) contactInfoPresent = true;
  }

  if (!anyFetchOk) {
    const attemptedPaths = targets.map((u) => pathOf(u)).join(", ");

    const result = {
      url,
      hostname,
      scanId,
      scannedAt,
      https,
      fetchOk: false,
      fetchStatus: firstStatus || 0,

      // Minimal signals (unknown/undetected)
      hasPrivacyPolicy: false,
      hasTerms: false,
      hasCookiePolicy: false,
      hasCookieBanner: false,
      cookieVendorsDetected: [],
      trackingScriptsDetected: [],
      formsDetected: 0,
      formsPersonalDataSignals: 0,
      totalImages: 0,
      imagesMissingAlt: 0,
      contactInfoPresent: false,

      accessibilityNotes: ["No HTML pages could be retrieved for analysis."],

      checkedPages,
      failedPages,

      scanCoverageNotes: [
        "Attempted: homepage + standard policy/contact paths.",
        `Attempted pages: ${attemptedPaths}`,
      ],
    };

    return finalize(result);
  }

  const cookieVendorsDetected = Array.from(vendorSet);
  const trackingScriptsDetected = Array.from(trackingSet);

  // Vendor presence can imply consent tooling exists
  if (cookieVendorsDetected.length > 0) hasCookieBanner = true;

  const checkedList =
    checkedPages
      .map((p) => {
        try {
          return new URL(p.url).pathname || "/";
        } catch {
          return "/";
        }
      })
      .join(", ") || "none";

  const failedList = failedPages.length
    ? failedPages
        .map((p) => {
          try {
            return `${new URL(p.url).pathname} (HTTP ${p.status || 0})`;
          } catch {
            return `unknown (HTTP ${p.status || 0})`;
          }
        })
        .join(", ")
    : "none";

  const result = {
    url,
    hostname,
    scanId,
    scannedAt,
    https,
    fetchOk: true,
    fetchStatus: firstStatus || 200,

    hasPrivacyPolicy,
    hasTerms,
    hasCookiePolicy,
    hasCookieBanner,

    cookieVendorsDetected,
    trackingScriptsDetected,

    formsDetected: formsDetectedTotal,
    formsPersonalDataSignals: formsPersonalSignalsTotal,

    totalImages: totalImagesTotal,
    imagesMissingAlt: imagesMissingAltTotal,

    accessibilityNotes: Array.from(accessibilityNotes),
    contactInfoPresent,

    checkedPages,
    failedPages,

    scanCoverageNotes: [
      "Homepage + standard policy/contact paths only (max 6 pages).",
      "Public, unauthenticated HTML only.",
      "No full crawl or behavioural simulation.",
      `Checked: ${checkedList}`,
      `Failed: ${failedList}`,
    ],
  };

  return finalize(result);
}
