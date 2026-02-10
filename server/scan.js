// server/scan.js
import * as cheerio from "cheerio";
import crypto from "crypto";

const USER_AGENT =
  "WebsiteRiskCheckBot/1.0 (+https://websiteriskcheck.example)";

function normalizeUrl(input) {
  try {
    const u = new URL(input);
    // strip hash
    u.hash = "";
    return u.toString();
  } catch {
    // Try to coerce missing scheme
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

function detectTracking(html) {
  const findings = [];

  // Google Analytics (UA + GA4)
  if (/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+/i.test(html))
    findings.push("Google Analytics (GA4)");
  if (/google-analytics\.com\/analytics\.js/i.test(html))
    findings.push("Google Analytics (UA)");
  if (/googletagmanager\.com\/gtm\.js\?id=GTM-[A-Z0-9]+/i.test(html))
    findings.push("Google Tag Manager");

  // Meta Pixel
  if (/connect\.facebook\.net\/.*\/fbevents\.js/i.test(html))
    findings.push("Meta Pixel");

  // Hotjar
  if (/static\.hotjar\.com\/c\/hotjar-/i.test(html)) findings.push("Hotjar");

  // LinkedIn Insight
  if (/snap\.licdn\.com\/li\.lms-analytics/i.test(html))
    findings.push("LinkedIn Insight");

  // TikTok Pixel
  if (/analytics\.tiktok\.com\/i18n\/pixel/i.test(html))
    findings.push("TikTok Pixel");

  return Array.from(new Set(findings));
}

function detectCookieVendors(html) {
  const vendors = [];

  if (/cookiebot/i.test(html) || /consent\.cookiebot\.com/i.test(html))
    vendors.push("Cookiebot");
  if (/onetrust/i.test(html) || /cdn\.cookielaw\.org/i.test(html))
    vendors.push("OneTrust");
  if (/quantcast/i.test(html) || /quantcast\.mgr\.consensu\.org/i.test(html))
    vendors.push("Quantcast");
  if (/trustarc/i.test(html)) vendors.push("TrustArc");
  if (/iubenda/i.test(html)) vendors.push("iubenda");
  if (/osano/i.test(html)) vendors.push("Osano");

  return Array.from(new Set(vendors));
}

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

function detectPolicyLinks($, baseUrl) {
  const anchors = $("a[href]");
  const links = [];

  anchors.each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    // Keep relative links as absolute
    try {
      const abs = new URL(href, baseUrl).toString();
      links.push({
        abs,
        text: ($(a).text() || "").trim().toLowerCase(),
      });
    } catch {
      // ignore
    }
  });

  const hasPrivacy =
    links.some((l) => l.text.includes("privacy")) ||
    links.some((l) => /privacy/i.test(l.abs));

  const hasTerms =
    links.some((l) => l.text.includes("terms")) ||
    links.some((l) => /terms|conditions/i.test(l.abs));

  const hasCookies =
    links.some((l) => l.text.includes("cookie")) ||
    links.some((l) => /cookie/i.test(l.abs));

  return { hasPrivacy, hasTerms, hasCookies, links };
}

function detectForms($) {
  const forms = $("form");
  let personalDataSignals = 0;

  forms.each((_, f) => {
    const $f = $(f);
    const inputs = $f.find("input, textarea, select");

    inputs.each((__, el) => {
      const type = ($(el).attr("type") || "").toLowerCase();
      const name = ($(el).attr("name") || "").toLowerCase();
      const id = ($(el).attr("id") || "").toLowerCase();
      const placeholder = ($(el).attr("placeholder") || "").toLowerCase();

      const joined = `${type} ${name} ${id} ${placeholder}`;

      // crude “personal data” heuristic
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

  return {
    formsDetected: forms.length,
    personalDataSignals,
  };
}

function detectImagesMissingAlt($) {
  const imgs = $("img");
  let missing = 0;

  imgs.each((_, img) => {
    const alt = $(img).attr("alt");
    if (alt === undefined || alt === null || String(alt).trim() === "") missing++;
  });

  return { totalImages: imgs.length, imagesMissingAlt: missing };
}

function detectAccessibility($) {
  const notes = [];

  // html lang
  const lang = $("html").attr("lang");
  if (!lang) notes.push("No <html lang> attribute detected.");

  // heading structure: missing H1
  if ($("h1").length === 0) notes.push("No H1 heading detected on homepage.");

  // multiple H1 (not always bad, but common smell)
  if ($("h1").length > 1) notes.push("Multiple H1 headings detected.");

  // aria-label on icon-only buttons (very rough)
  const iconButtons = $("button").filter((_, b) => {
    const txt = ($(b).text() || "").trim();
    const hasIcon = $(b).find("svg, i").length > 0;
    const aria = $(b).attr("aria-label") || $(b).attr("title");
    return hasIcon && txt.length === 0 && !aria;
  });
  if (iconButtons.length > 0)
    notes.push("Some icon-only buttons may be missing accessible labels.");

  return notes;
}

function detectContactInfo($) {
  const text = $("body").text().toLowerCase();

  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const hasPhone = /\+?\d[\d\s().-]{7,}\d/.test(text);
  const hasAddressHints =
    text.includes("street") ||
    text.includes("road") ||
    text.includes("postcode") ||
    text.includes("zip");

  const hasContactLink = $('a[href*="contact" i]').length > 0;

  return Boolean(hasEmail || hasPhone || hasAddressHints || hasContactLink);
}

async function checkKnownPolicyPaths(baseUrl) {
  const candidates = [
    "/privacy",
    "/privacy-policy",
    "/privacy-notice",
    "/legal/privacy",
    "/terms",
    "/terms-and-conditions",
    "/terms-conditions",
    "/legal",
    "/cookies",
    "/cookie-policy",
  ];

  const results = {
    privacyHit: false,
    termsHit: false,
    cookiesHit: false,
    checked: [],
  };

  // Keep it small (speed + avoid being “crawler”)
  for (const p of candidates) {
    const target = new URL(p, baseUrl).toString();
    const { ok, status, html } = await fetchHtml(target);
    results.checked.push({ url: target, ok, status });

    if (!ok || !html) continue;

    const low = html.toLowerCase();
    if (p.includes("privacy") || low.includes("privacy")) results.privacyHit = true;
    if (p.includes("terms") || low.includes("terms")) results.termsHit = true;
    if (p.includes("cookie") || low.includes("cookie")) results.cookiesHit = true;

    // If we’ve already found all three, stop early
    if (results.privacyHit && results.termsHit && results.cookiesHit) break;
  }

  return results;
}

function scoreRisk(scan) {
  const reasons = [];
  let score = 0;

  if (!scan.https) {
    score += 3;
    reasons.push("Site does not appear to use HTTPS.");
  }

  // Tracking scripts without a cookie banner is a “feels risky” combo
  if (scan.trackingScriptsDetected.length > 0 && !scan.hasCookieBanner) {
    score += 3;
    reasons.push("Tracking scripts detected but no cookie consent banner found.");
  }

  if (!scan.hasPrivacyPolicy) {
    score += 2;
    reasons.push("No privacy policy page detected.");
  }

  if (scan.formsDetected > 0 && !scan.hasPrivacyPolicy) {
    score += 2;
    reasons.push("Forms detected that may collect personal data without a detected privacy policy.");
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
    reasons.push("Basic accessibility red flags detected on the homepage.");
  }

  let level = "LOW";
  if (score >= 6) level = "HIGH";
  else if (score >= 3) level = "MEDIUM";

  return { riskScore: score, riskLevel: level, riskReasons: reasons };
}

export async function scanWebsite(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const scanId = crypto.randomBytes(6).toString("hex"); // short, printable
  const scannedAt = Date.now();

  const https = url.startsWith("https://");

  const home = await fetchHtml(url);
  if (!home.ok || !home.html) {
    return {
      url,
      scanId,
      scannedAt,
      https,
      fetchOk: false,
      fetchStatus: home.status,
      hasPrivacyPolicy: false,
      hasTerms: false,
      hasCookieBanner: false,
      cookieVendorsDetected: [],
      trackingScriptsDetected: [],
      formsDetected: 0,
      formsPersonalDataSignals: 0,
      imagesMissingAlt: 0,
      totalImages: 0,
      accessibilityNotes: ["Homepage could not be scanned (non-HTML response or fetch failed)."],
      contactInfoPresent: false,
      riskLevel: "HIGH",
      riskScore: 999,
      riskReasons: ["We could not retrieve the homepage HTML to analyze detectable signals."],
    };
  }

  const $ = cheerio.load(home.html);

  const trackingScriptsDetected = detectTracking(home.html);
  const cookieVendorsDetected = detectCookieVendors(home.html);
  const hasCookieBanner =
    cookieVendorsDetected.length > 0 || detectCookieBannerHeuristics($);

  const { hasPrivacy, hasTerms, hasCookies } = detectPolicyLinks($, url);
  const pathChecks = await checkKnownPolicyPaths(url);

  const hasPrivacyPolicy = hasPrivacy || pathChecks.privacyHit;
  const hasTermsPage = hasTerms || pathChecks.termsHit;
  const hasCookiePolicy = hasCookies || pathChecks.cookiesHit;

  const { formsDetected, personalDataSignals } = detectForms($);
  const { totalImages, imagesMissingAlt } = detectImagesMissingAlt($);
  const accessibilityNotes = detectAccessibility($);
  const contactInfoPresent = detectContactInfo($);

  const scan = {
    url,
    hostname: safeHostname(url),
    scanId,
    scannedAt,
    https,
    fetchOk: true,
    fetchStatus: home.status,

    hasPrivacyPolicy,
    hasTerms: hasTermsPage,
    hasCookiePolicy,
    hasCookieBanner,
    cookieVendorsDetected,

    trackingScriptsDetected,

    formsDetected,
    formsPersonalDataSignals: personalDataSignals,

    totalImages,
    imagesMissingAlt,

    accessibilityNotes,
    contactInfoPresent,

    scanCoverageNotes: [
      "This scan checks detectable signals on the homepage and a small set of likely policy page paths.",
      "It does not perform a full crawl and may miss content behind logins, scripts, or blocked pages.",
    ],
  };

  const scored = scoreRisk(scan);

  return {
    ...scan,
    ...scored,
  };
}
