// server/scan.js
// AUDIT-GRADE — scope-locked, deterministic, evidence-only scanner

import * as cheerio from "cheerio";
import crypto from "crypto";

const USER_AGENT =
  "WebsiteRiskCheckBot/1.0 (+https://www.websiteriskcheck.com)";

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

/* =========================
   FETCH (HTML ONLY)
========================= */

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return { ok: false, status: res.status, html: "" };
  }

  const html = await res.text();
  return { ok: res.ok, status: res.status, html };
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
   POLICY LINKS
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

  if ($("h1").length === 0)
    notes.push("No H1 heading detected on the homepage.");

  if ($("h1").length > 1)
    notes.push("Multiple H1 headings detected.");

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
   MAIN SCAN
========================= */

export async function scanWebsite(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const scanId = crypto.randomBytes(6).toString("hex");
  const scannedAt = Date.now();
  const https = url.startsWith("https://");

  const home = await fetchHtml(url);

  if (!home.ok || !home.html) {
    return {
      url,
      hostname: safeHostname(url),
      scanId,
      scannedAt,
      https,
      fetchOk: false,
      fetchStatus: home.status,
      accessibilityNotes: [
        "Homepage HTML could not be retrieved for analysis.",
      ],
    };
  }

  const $ = cheerio.load(home.html);

  const trackingScriptsDetected = detectTracking(home.html);
  const cookieVendorsDetected = detectCookieVendors(home.html);

  const hasCookieBanner =
    cookieVendorsDetected.length > 0 ||
    detectCookieBannerHeuristic($);

  const linkPolicies = detectPolicyLinks($, url);
  const { formsDetected, formsPersonalDataSignals } = detectForms($);
  const { totalImages, imagesMissingAlt } =
    detectImagesMissingAlt($);

  return {
    url,
    hostname: safeHostname(url),
    scanId,
    scannedAt,
    https,
    fetchOk: true,
    fetchStatus: home.status,

    hasPrivacyPolicy: linkPolicies.privacy,
    hasTerms: linkPolicies.terms,
    hasCookiePolicy: linkPolicies.cookies,
    hasCookieBanner,

    cookieVendorsDetected,
    trackingScriptsDetected,

    formsDetected,
    formsPersonalDataSignals,

    totalImages,
    imagesMissingAlt,

    accessibilityNotes: detectAccessibility($),
    contactInfoPresent: detectContactInfo($),

    scanCoverageNotes: [
      "Homepage only.",
      "Public, unauthenticated HTML.",
      "No full crawl or behavioural simulation.",
    ],
  };
}
