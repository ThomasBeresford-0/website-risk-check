// server/scripts/make-sample-report.js
// Generates a deterministic boutique sample report for /public/sample-report.pdf
// FULL RAMBO — clean, repeatable, zero randomness.

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { generateReport } from "../report.js";

/* =========================
   PATH SETUP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This file is /server/scripts/..., so project root is two levels up
const projectRoot = path.join(__dirname, "..", "..");
const outputPath = path.join(projectRoot, "public", "sample-report.pdf");

/* =========================
   DETERMINISTIC SAMPLE DATA
========================= */

const SAMPLE_TIMESTAMP = "2026-02-10T14:32:00.000Z";
const SAMPLE_SCAN_ID = "SAMPLE-001";
const SAMPLE_URL = "https://example-retail-site.com";
const SAMPLE_HOSTNAME = "example-retail-site.com";

const sampleData = {
  meta: {
    url: SAMPLE_URL,
    hostname: SAMPLE_HOSTNAME,
    scanId: SAMPLE_SCAN_ID,
    scannedAt: SAMPLE_TIMESTAMP,
    https: true,
  },

  coverage: {
    checkedPages: [
      { url: SAMPLE_URL, status: 200 },
      { url: `${SAMPLE_URL}/privacy-policy`, status: 200 },
      { url: `${SAMPLE_URL}/terms`, status: 200 },
      { url: `${SAMPLE_URL}/contact`, status: 200 },
      { url: `${SAMPLE_URL}/returns`, status: 200 },
      { url: `${SAMPLE_URL}/about`, status: 200 },
    ],
    failedPages: [],
    notes: [
      "Scope-locked to homepage and standard public policy/contact paths.",
      "No authenticated areas scanned.",
    ],
  },

  signals: {
    policies: { privacy: true, terms: true, cookies: false },
    consent: { bannerDetected: true, vendors: ["OneTrust"] },
    trackingScripts: ["Google Analytics", "Meta Pixel"],
    forms: { detected: 3, personalDataSignals: 2 },
    accessibility: {
      notes: ["Several product images missing alt text."],
      images: { total: 24, missingAlt: 7 },
    },
    contact: { detected: true },
  },

  findings: [
    {
      category: "Tracking",
      description:
        "Third-party tracking scripts were detected on public pages. Without region-appropriate consent configuration, regulatory exposure may increase.",
      probability: { value: 4, label: "Likely" },
      impact: { value: 4, label: "Major" },
      score: 16,
      trigger: "Google Analytics and Meta Pixel scripts detected in page source.",
      mitigation:
        "Review consent configuration for target regions. Ensure vendor disclosure matches deployed scripts.",
    },
    {
      category: "Data capture",
      description:
        "Customer-facing forms appear to collect personal information. Inadequate transparency or retention controls may increase compliance and operational risk.",
      probability: { value: 3, label: "Possible" },
      impact: { value: 4, label: "Major" },
      score: 12,
      trigger:
        "Contact and checkout forms detected with personal-data field signals (heuristic).",
      mitigation:
        "Audit form fields for minimum necessary data. Confirm storage, retention, and access controls.",
    },
    {
      category: "Accessibility",
      description:
        "A portion of meaningful images were detected without alt text. This may affect accessibility depending on audience and jurisdiction.",
      probability: { value: 3, label: "Possible" },
      impact: { value: 2, label: "Minor" },
      score: 6,
      trigger: "7 of 24 images missing alt text based on lightweight heuristic scan.",
      mitigation:
        "Add descriptive alt text to meaningful images on key product and conversion pages.",
    },
    {
      category: "Compliance",
      description:
        "No dedicated cookie policy page detected on standard public paths.",
      probability: { value: 3, label: "Possible" },
      impact: { value: 3, label: "Moderate" },
      score: 9,
      trigger: "Cookie policy not detected via homepage links or common public paths.",
      mitigation:
        "Publish and link a cookie policy page outlining tracking technologies and purposes.",
    },
  ],
};

/* =========================
   EXECUTION
========================= */

async function run() {
  try {
    console.log("Generating boutique sample report…");
    const publicDir = path.dirname(outputPath);
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const result = await generateReport(sampleData, outputPath);

    console.log("✅ Sample report generated:");
    console.log("   Path:", result.outputPath);
    console.log("   Integrity hash:", result.integrityHash);
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to generate sample report");
    console.error(err);
    process.exit(1);
  }
}

run();
