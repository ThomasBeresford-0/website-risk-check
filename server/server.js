// server/server.js
// FULL RAMBO — immutable reports + verification + payments + preview

import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { scanWebsite } from "./scan.js";
import { generateReport } from "./report.js";

/* =========================
   ENV
========================= */

// ES modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Load env explicitly from /server/.env (works regardless of where you run node from)
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// ✅ Fail fast in ALL environments (prevents Stripe(undefined) crash)
if (!STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing (check server/.env or host env vars)");
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

/* =========================
   STORAGE
========================= */

const DATA_DIR = path.join(__dirname, "data");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const SESSION_DIR = path.join(DATA_DIR, "sessions");

[DATA_DIR, REPORT_DIR, SESSION_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function generateToken() {
  return crypto.randomBytes(6).toString("base64url");
}

function isValidToken(token) {
  return /^[a-zA-Z0-9_-]{8,16}$/.test(token);
}

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   HEALTH
========================= */

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* =========================
   PREVIEW SCAN (RATE-LIMITED)
========================= */

const previewHits = new Map();

// tiny helper: keep preview light, never dump huge arrays
function cap(arr, n = 12) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function buildPreviewFindings(scan) {
  const findings = [];

  // Policies
  findings.push(
    scan.hasPrivacyPolicy ? "Privacy policy: detected" : "Privacy policy: not detected"
  );
  findings.push(
    scan.hasTerms ? "Terms: detected" : "Terms: not detected"
  );
  findings.push(
    scan.hasCookiePolicy ? "Cookie policy: detected" : "Cookie policy: not detected"
  );

  // Consent + tracking
  findings.push(
    scan.hasCookieBanner
      ? "Consent banner indicator: detected (heuristic)"
      : "Consent banner indicator: not detected (heuristic)"
  );

  if (Array.isArray(scan.trackingScriptsDetected) && scan.trackingScriptsDetected.length) {
    findings.push(
      `Tracking scripts: detected (${scan.trackingScriptsDetected.slice(0, 4).join(", ")}${
        scan.trackingScriptsDetected.length > 4 ? "…" : ""
      })`
    );
  } else {
    findings.push("Tracking scripts: none detected");
  }

  if (Array.isArray(scan.cookieVendorsDetected) && scan.cookieVendorsDetected.length) {
    findings.push(
      `Cookie vendor signals: detected (${scan.cookieVendorsDetected.slice(0, 4).join(", ")}${
        scan.cookieVendorsDetected.length > 4 ? "…" : ""
      })`
    );
  } else {
    findings.push("Cookie vendor signals: none detected");
  }

  // Forms
  if ((scan.formsDetected || 0) > 0) {
    findings.push(`Forms detected: ${scan.formsDetected}`);
    findings.push(
      `Potential personal-data field signals: ${scan.formsPersonalDataSignals || 0} (heuristic)`
    );
  } else {
    findings.push("Forms detected: none");
  }

  // Accessibility quick hits
  if ((scan.totalImages || 0) > 0) {
    findings.push(
      `Images missing alt text: ${scan.imagesMissingAlt || 0} of ${scan.totalImages || 0}`
    );
  } else {
    findings.push("Images: none detected on scanned pages");
  }

  if (Array.isArray(scan.accessibilityNotes) && scan.accessibilityNotes.length) {
    findings.push(`Accessibility note: ${scan.accessibilityNotes[0]}`);
  }

  // Contact/identity
  findings.push(
    scan.contactInfoPresent
      ? "Contact/identity signals: detected"
      : "Contact/identity signals: not detected"
  );

  // HTTPS
  findings.push(scan.https ? "HTTPS: detected" : "HTTPS: not detected");

  return findings.slice(0, 12);
}

app.post("/preview-scan", async (req, res) => {
  try {
    // Basic per-IP throttling
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.ip;

    const now = Date.now();
    const last = previewHits.get(ip) || 0;
    if (now - last < 4000) {
      return res.status(429).json({ error: "Too many requests" });
    }
    previewHits.set(ip, now);

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    const scan = await scanWebsite(url);

    // IMPORTANT:
    // - Preview returns structured signals for the frontend UI
    // - Still keeps it lightweight (caps arrays)
    // - No PDF generation, no persistence, no tokens
    const payload = {
      // identity
      url: scan.url,
      hostname: scan.hostname,
      scannedAt: scan.scannedAt,

      // top-level outcomes
      https: !!scan.https,
      fetchOk: scan.fetchOk !== false,
      fetchStatus: scan.fetchStatus || 0,

      // risk
      // If scan.js doesn't compute riskLevel, it will be undefined — frontend will fallback
      riskLevel: scan.riskLevel,

      // policy + consent signals
      hasPrivacyPolicy: !!scan.hasPrivacyPolicy,
      hasTerms: !!scan.hasTerms,
      hasCookiePolicy: !!scan.hasCookiePolicy,
      hasCookieBanner: !!scan.hasCookieBanner,

      // detections (capped)
      trackingScriptsDetected: cap(scan.trackingScriptsDetected, 12),
      cookieVendorsDetected: cap(scan.cookieVendorsDetected, 12),

      // forms
      formsDetected: Number(scan.formsDetected || 0),
      formsPersonalDataSignals: Number(scan.formsPersonalDataSignals || 0),

      // accessibility
      totalImages: Number(scan.totalImages || 0),
      imagesMissingAlt: Number(scan.imagesMissingAlt || 0),
      accessibilityNotes: cap(scan.accessibilityNotes, 8),

      // identity/contact
      contactInfoPresent: !!scan.contactInfoPresent,

      // coverage (for credibility)
      checkedPages: cap(scan.checkedPages, 12),
      failedPages: cap(scan.failedPages, 12),
      scanCoverageNotes: cap(scan.scanCoverageNotes, 10),

      // legacy list (so old UI + new UI both work)
      findings: buildPreviewFindings(scan),
    };

    res.json(payload);
  } catch (e) {
    console.error("preview-scan error:", e);
    res.status(500).json({ error: "Preview failed" });
  }
});

/* =========================
   STRIPE CHECKOUT (£99)
========================= */

app.post("/create-checkout", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "gbp",
          unit_amount: 9900,
          product_data: {
            name: "Website Risk Check — Verifiable Compliance Snapshot",
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      url,
      kind: "primary",
    },
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/`,
  });

  res.json({ url: session.url });
});

/* =========================
   PAID → IMMUTABLE REPORT (IDEMPOTENT)
========================= */

app.get("/download-report", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).send("Missing session_id");

  const sessionFile = path.join(SESSION_DIR, `${session_id}.json`);

  if (fs.existsSync(sessionFile)) {
    const { token } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return res.redirect(`/r/${token}`);
  }

  const session = await stripe.checkout.sessions.retrieve(session_id);
  if (!session || session.payment_status !== "paid") {
    return res.status(403).send("Payment not verified");
  }

  const url = session.metadata?.url;
  if (!url) return res.status(400).send("Missing URL");

  const token = generateToken();
  const pdfPath = path.join(REPORT_DIR, `${token}.pdf`);
  const jsonPath = path.join(REPORT_DIR, `${token}.json`);

  const scanData = await scanWebsite(url);

  await generateReport({ ...scanData, shareToken: token }, pdfPath);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        token,
        createdAt: Date.now(),
        integrityHash: scanData.integrityHash,
        scanData,
      },
      null,
      2
    )
  );

  fs.writeFileSync(sessionFile, JSON.stringify({ token, createdAt: Date.now() }));

  res.redirect(`/r/${token}`);
});

/* =========================
   REPORT DOWNLOAD
========================= */

app.get("/r/:token", (req, res) => {
  const { token } = req.params;
  if (!isValidToken(token)) return res.status(400).send("Invalid reference");

  const pdfPath = path.join(REPORT_DIR, `${token}.pdf`);
  if (!fs.existsSync(pdfPath)) return res.status(404).send("Not found");

  res.download(pdfPath, "website-risk-check-report.pdf");
});

/* =========================
   REPORT VERIFICATION (PUBLIC)
========================= */

app.get("/verify/:hash", (req, res) => {
  const hash = String(req.params.hash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return res.send(renderVerifyPage({ valid: false }));
  }

  const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(REPORT_DIR, file), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (parsed.integrityHash === hash && parsed.scanData) {
      const scan = parsed.scanData;
      return res.send(
        renderVerifyPage({
          valid: true,
          hash,
          url: scan.url,
          hostname: scan.hostname,
          scanId: scan.scanId,
          scannedAt: scan.scannedAt,
        })
      );
    }
  }

  res.send(renderVerifyPage({ valid: false, hash }));
});

function renderVerifyPage(data) {
  const ok = data.valid === true;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Report verification — Website Risk Check</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  background:#f7f7f8;
  padding:48px 20px;
}
.card{
  max-width:720px;
  margin:auto;
  background:#fff;
  padding:40px;
  border-radius:18px;
  border:1px solid rgba(0,0,0,0.06);
}
.status{
  display:inline-block;
  padding:10px 14px;
  border-radius:999px;
  font-size:13px;
  margin-bottom:20px;
  background:${ok ? "#ecfdf3" : "#fef2f2"};
  color:${ok ? "#166534" : "#991b1b"};
}
.mono{
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  background:#f2f2f3;
  padding:12px;
  border-radius:10px;
  font-size:13px;
  word-break:break-all;
}
p{ line-height:1.55; }
</style>
</head>
<body>
<div class="card">
  <h1>Report verification</h1>
  <div class="status">${ok ? "Valid report" : "Invalid or unknown report"}</div>

  ${
    ok
      ? `
      <p><strong>Domain:</strong> ${data.hostname || data.url}</p>
      <p><strong>Scan ID:</strong> ${data.scanId}</p>
      <p><strong>Scanned at:</strong> ${new Date(data.scannedAt).toISOString()}</p>
      <p><strong>Integrity hash:</strong></p>
      <div class="mono">${data.hash}</div>
      `
      : `<p>This report could not be verified.</p>`
  }

  <p style="margin-top:24px;font-size:14px;color:#555;">
    This page confirms whether a report matches the cryptographic fingerprint
    generated at scan time. Any modification invalidates verification.
  </p>
</div>
</body>
</html>`;
}

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`✅ Website Risk Check running on port ${PORT}`);
});
