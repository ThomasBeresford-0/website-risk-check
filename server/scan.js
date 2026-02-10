// server/scan.js
// FULL RAMBO — scope-locked, deterministic, defensible scanning engine

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
    return { ok: false, status: res.status, html: "", contentType };
  }

  const html = await res.text();
  return { ok: res.ok, status: res.status, html, contentType };
}

/* =========================
   TRACKING DETECTION
========================= */

function detectTracking(html) {
  const findings = [];

  if (/googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+/i.test(html))
    findings.push("Google Analytics (GA4)");
  if (/google-analytics\.com\/analytics\.js/i.test(html))
    findings.push("Google Analytics (UA)");
  if (/googletagmanager\.com\/gtm\.js\?id=GTM-/i.test(html))
    findings.push("Google Tag Manager");
  if (/connect\.facebook\.net\/.*\/fbevents\.js/i.test(html))
    findings.push("Meta Pixel");
  if (/static\.hotjar\.com\/c\/hotjar-/i.test(html))
    findings.push("Hotjar");
  if (/snap\.licdn\.com\/li\.lms-analytics/i.test(html))
    findings.push("LinkedIn Insight");
  if (/analytics\.tiktok\.com\/i18n\/pixel/i.test(html))
    findings.push("TikTok Pixel");

  return Array.from(new Set(findings));
}

/* =========================
   COOKIE VENDORS
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

function detectCookieBannerHeuristics($) {
  const text = $("body").text().toLowerCase();

  const keywordHit =
    text.includes("cookie") &&
    (text.includes("consent") ||
      text.includes("preferences") ||
      text.includes("accept") ||
      text.includes("manage"));

  const idClassHit =
    $(
      '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]'
    ).length > 0;

  return keywordHit || idClassHit;
}

/* =========================
   POLICY LINKS
========================= */

function detectPolicyLinks($, baseUrl) {
  const anchors = $("a[href]");
  const links = [];

  anchors.each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      links.push({
        abs,
        text: ($(a).text() || "").toLowerCase(),
      });
    } catch {}
  });

  return {
    hasPrivacy:
      links.some((l) => l.text.includes("privacy")) ||
      links.some((l) => /privacy/i.test(l.abs)),
    hasTerms:
      links.some((l) => l.text.includes("terms")) ||
      links.some((l) => /terms|conditions/i.test(l.abs)),
    hasCookies:
      links.some((l) => l.text.includes("cookie")) ||
      links.some((l) => /cookie/i.test(l.abs)),
  };
}

/* =========================
   FORMS + DATA SIGNALS
========================= */

function detectForms($) {
  const forms = $("form");
  let personalDataSignals = 0;

  forms.each((_, f) => {
    $(f)
      .find("input, textarea, select")
      .each((__, el) => {
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
          personalDataSignals++;
        }
      });
  });

  return { formsDetected: forms.length, personalDataSignals };
}

/* =========================
   ACCESSIBILITY SIGNALS
========================= */

function detectImagesMissingAlt($) {
  const imgs = $("img");
  let missing = 0;

  imgs.each((_, img) => {
    const alt = $(img).attr("alt");
    if (!alt || !alt.trim()) missing++;
  });

  return { totalImages: imgs.length, imagesMissingAlt: missing };
}

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
   POLICY PATH CHECK
========================= */

async function checkKnownPolicyPaths(baseUrl) {
  const paths = [
    "/privacy",
    "/privacy-policy",
    "/terms",
    "/terms-and-conditions",
    "/cookies",
    "/cookie-policy",
  ];

  const hits = { privacy: false, terms: false, cookies: false };

  for (const p of paths) {
    const target = new URL(p, baseUrl).toString();
    const { ok, html } = await fetchHtml(target);
    if (!ok || !html) continue;

    const low = html.toLowerCase();
    if (low.includes("privacy")) hits.privacy = true;
    if (low.includes("terms")) hits.terms = true;
    if (low.includes("cookie")) hits.cookies = true;

    if (hits.privacy && hits.terms && hits.cookies) break;
  }

  return hits;
}

/* =========================
   RISK SCORING (NON-LEGAL)
========================= */

function scoreRisk(scan) {
  let score = 0;
  const reasons = [];

  if (!scan.https) {
    score += 3;
    reasons.push("Site does not appear to use HTTPS.");
  }

  if (
    scan.trackingScriptsDetected.length > 0 &&
    !scan.hasCookieBanner
  ) {
    score += 3;
    reasons.push(
      "Tracking scripts detected without a visible cookie consent mechanism."
    );
  }

  if (!scan.hasPrivacyPolicy) {
    score += 2;
    reasons.push("No privacy policy detected.");
  }

  if (scan.formsDetected > 0 && !scan.hasPrivacyPolicy) {
    score += 2;
    reasons.push(
      "Forms detected that may collect personal data without a detected privacy policy."
    );
  }

  if (!scan.hasTerms) {
    score += 1;
    reasons.push("No terms page detected.");
  }

  if (scan.imagesMissingAlt > 5) {
    score += 1;
    reasons.push("Multiple images appear to be missing alt text.");
  }

  if (scan.accessibilityNotes.length > 0) {
    score += 1;
    reasons.push("Basic accessibility red flags detected.");
  }

  let riskLevel = "LOW";
  if (score >= 6) riskLevel = "HIGH";
  else if (score >= 3) riskLevel = "MEDIUM";

  return { riskScore: score, riskLevel, riskReasons: reasons };
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
      riskLevel: "HIGH",
      riskScore: 999,
      riskReasons: [
        "Homepage HTML could not be retrieved for analysis.",
      ],
      accessibilityNotes: [
        "Homepage could not be scanned (non-HTML or fetch failed).",
      ],
    };
  }

  const $ = cheerio.load(home.html);

  const trackingScriptsDetected = detectTracking(home.html);
  const cookieVendorsDetected = detectCookieVendors(home.html);
  const hasCookieBanner =
    cookieVendorsDetected.length > 0 ||
    detectCookieBannerHeuristics($);

  const linkPolicies = detectPolicyLinks($, url);
  const pathPolicies = await checkKnownPolicyPaths(url);

  const { formsDetected, personalDataSignals } = detectForms($);
  const { totalImages, imagesMissingAlt } =
    detectImagesMissingAlt($);

  const scan = {
    url,
    hostname: safeHostname(url),
    scanId,
    scannedAt,
    https,
    fetchOk: true,
    fetchStatus: home.status,

    hasPrivacyPolicy:
      linkPolicies.hasPrivacy || pathPolicies.privacy,
    hasTerms:
      linkPolicies.hasTerms || pathPolicies.terms,
    hasCookiePolicy:
      linkPolicies.hasCookies || pathPolicies.cookies,
    hasCookieBanner,
    cookieVendorsDetected,

    trackingScriptsDetected,

    formsDetected,
    formsPersonalDataSignals: personalDataSignals,

    totalImages,
    imagesMissingAlt,

    accessibilityNotes: detectAccessibility($),
    contactInfoPresent: detectContactInfo($),

    scanCoverageNotes: [
      "Homepage only, plus a limited set of common policy paths.",
      "No full crawl. No authenticated or dynamic content.",
    ],
  };

  return {
    ...scan,
    ...scoreRisk(scan),
  };
}
