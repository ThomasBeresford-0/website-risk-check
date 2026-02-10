// scan.js

export async function scanWebsite(url) {
  // Basic, deterministic scan (MVP)
  const hasHttps = url.startsWith("https://");

  return {
    url,
    scannedAt: Date.now(),
    https: hasHttps,
    hasPrivacyPolicy: false,
    hasTerms: false,
    hasCookieBanner: false,
    trackingScriptsDetected: [],
    formsDetected: 0,
    imagesMissingAlt: 0,
    accessibilityNotes: [],
    contactInfoPresent: false,
  };
}
