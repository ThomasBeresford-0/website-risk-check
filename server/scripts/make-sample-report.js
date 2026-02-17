// server/scripts/make-sample-report.js
// Generates a deterministic boutique sample report for /public/sample-report.pdf
// FULL RAMBO — clean, repeatable, zero randomness.
// ✅ Includes optional “stress mode” findings to force-wrap + paginate the landscape table
// ✅ Prints BEFORE/AFTER stat + sha so you can prove the bytes changed
// ✅ Uses fixed timestamp + scan id + hostname for determinism

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

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

// Optional CLI flag: --stress (forces long findings that stress table layout)
const STRESS_MODE = process.argv.includes("--stress");

function long(s, n = 8) {
  return Array.from({ length: n }).map(() => s).join(" ");
}

function buildFindings() {
  if (!STRESS_MODE) {
    return [
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
    ];
  }

  // Stress mode: deliberately long strings + more rows to force wrapping/pagination
  return Array.from({ length: 12 }).map((_, i) => ({
    category: i % 2 ? "Tracking & Cookies" : "Policies & Disclosure",
    description: long(
      "Deliberately long description to force wrapping and prove the table never overflows the page width. This is a rendering stress test for the landscape register.",
      7
    ),
    probability: { label: "Likely", value: 4 },
    impact: { label: "Major", value: 4 },
    score: 16,
    trigger: long(
      "Deliberately long trigger text with details, clauses, and context to stress table rendering. Includes multiple phrases to cause line breaks and pagination checks.",
      7
    ),
    mitigation: long(
      "Deliberately long mitigation response to stress layout and pagination: inventory tags, validate consent, update disclosures, confirm retention/access controls, and re-run snapshot.",
      7
    ),
  }));
}

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

  findings: buildFindings(),
};

/* =========================
   UTILS (proof + logging)
========================= */

function fileSha256(p) {
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fileStatLine(p) {
  if (!fs.existsSync(p)) return "(missing)";
  const st = fs.statSync(p);
  return `${st.mtime.toISOString()}  ${st.size} bytes  ${p}`;
}

/* =========================
   EXECUTION
========================= */

async function run() {
  try {
    const publicDir = path.dirname(outputPath);
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const beforeStat = fileStatLine(outputPath);
    const beforeSha = fileSha256(outputPath);

    console.log("Generating boutique sample report…");
    if (STRESS_MODE) console.log("⚙️  Stress mode: ON (long findings + pagination test)");

    const result = await generateReport(sampleData, outputPath);

    const afterStat = fileStatLine(outputPath);
    const afterSha = fileSha256(outputPath);

    console.log("✅ Sample report generated:");
    console.log("   Path:", result.outputPath);
    console.log("   Integrity hash:", result.integrityHash);
    console.log("");
    console.log("   BEFORE:", beforeStat);
    console.log("   BEFORE SHA256:", beforeSha || "(missing)");
    console.log("   AFTER: ", afterStat);
    console.log("   AFTER  SHA256:", afterSha || "(missing)");

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to generate sample report");
    console.error(err);
    process.exit(1);
  }
}

run();
  