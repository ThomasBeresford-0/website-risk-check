// server/server.js
// FULL RAMBO — immutable reports + structured preview + verification + payments
// + Preview compat layer (flat fields + findings[]) so existing public/app.js works.

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing");
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

function tokenPaths(token) {
  return {
    pdfPath: path.join(REPORT_DIR, `${token}.pdf`),
    jsonPath: path.join(REPORT_DIR, `${token}.json`),
  };
}

function generateUniqueToken() {
  // avoid (tiny) collision — keep it deterministic, fast
  for (let i = 0; i < 6; i++) {
    const token = generateToken();
    const { pdfPath, jsonPath } = tokenPaths(token);
    if (!fs.existsSync(pdfPath) && !fs.existsSync(jsonPath)) return token;
  }
  // if the universe hates us
  return crypto.randomBytes(10).toString("base64url");
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
   PREVIEW SCAN (STRUCTURED + COMPAT)
========================= */

const previewHits = new Map();

function rateLimitPreview(ip) {
  const now = Date.now();
  const last = previewHits.get(ip) || 0;

  if (now - last < 5000) return false;

  previewHits.set(ip, now);
  return true;
}

function cap(arr, n = 12) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function buildFindingsFromFlat(flat) {
  const findings = [];

  findings.push(
    flat.hasPrivacyPolicy ? "Privacy policy: detected" : "Privacy policy: not detected"
  );
  findings.push(flat.hasTerms ? "Terms: detected" : "Terms: not detected");
  findings.push(
    flat.hasCookiePolicy ? "Cookie policy: detected" : "Cookie policy: not detected"
  );

  findings.push(
    flat.hasCookieBanner
      ? "Consent banner indicator: detected (heuristic)"
      : "Consent banner indicator: not detected (heuristic)"
  );

  if (Array.isArray(flat.trackingScriptsDetected) && flat.trackingScriptsDetected.length) {
    findings.push(
      `Tracking scripts: detected (${flat.trackingScriptsDetected.slice(0, 4).join(", ")}${
        flat.trackingScriptsDetected.length > 4 ? "…" : ""
      })`
    );
  } else {
    findings.push("Tracking scripts: none detected");
  }

  if (Array.isArray(flat.cookieVendorsDetected) && flat.cookieVendorsDetected.length) {
    findings.push(
      `Cookie vendor signals: detected (${flat.cookieVendorsDetected.slice(0, 4).join(", ")}${
        flat.cookieVendorsDetected.length > 4 ? "…" : ""
      })`
    );
  } else {
    findings.push("Cookie vendor signals: none detected");
  }

  if ((flat.formsDetected || 0) > 0) {
    findings.push(`Forms detected: ${flat.formsDetected}`);
    findings.push(
      `Potential personal-data field signals: ${flat.formsPersonalDataSignals || 0} (heuristic)`
    );
  } else {
    findings.push("Forms detected: none");
  }

  if ((flat.totalImages || 0) > 0) {
    findings.push(
      `Images missing alt text: ${flat.imagesMissingAlt || 0} of ${flat.totalImages || 0}`
    );
  } else {
    findings.push("Images: none detected on scanned pages");
  }

  findings.push(flat.contactInfoPresent ? "Contact/identity signals: detected" : "Contact/identity signals: not detected");
  findings.push(flat.https ? "HTTPS: detected" : "HTTPS: not detected");

  return findings.slice(0, 12);
}

app.post("/preview-scan", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip;

    if (!rateLimitPreview(ip)) {
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        message:
          "Preview rate limit reached. Please wait a few seconds before retrying.",
      });
    }

    const { url } = req.body;
    if (!url) {
      return res.status(400).json({
        ok: false,
        error: "invalid_request",
        message: "URL required",
      });
    }

    const scan = await scanWebsite(url);

    // --- Structured (source of truth) ---
    const structured = {
      ok: true,
      meta: scan.meta,
      coverage: {
        checkedPages: scan.coverage?.checkedPages || [],
        failedPages: scan.coverage?.failedPages || [],
        notes: scan.coverage?.notes || [],
      },
      signals: scan.signals,
      risk: scan.risk,
    };

    // --- Flat compat layer (so existing public/app.js renders without changes) ---
    const checkedPages = structured.coverage.checkedPages;
    const failedPages = structured.coverage.failedPages;

    const trackingScriptsDetected = cap(scan.signals?.trackingScripts, 12);
    const cookieVendorsDetected = cap(scan.signals?.consent?.vendors, 12);

    const totalImages = Number(scan.signals?.accessibility?.images?.total || 0);
    const imagesMissingAlt = Number(scan.signals?.accessibility?.images?.missingAlt || 0);

    const flat = {
      // identity
      url: scan.meta?.url,
      hostname: scan.meta?.hostname,
      scannedAt: scan.meta?.scannedAt,

      // outcomes
      https: !!scan.meta?.https,
      fetchOk: Array.isArray(checkedPages) && checkedPages.length > 0,
      fetchStatus: 200,

      // risk
      riskLevel: scan.risk?.level || "Medium",

      // policy + consent signals
      hasPrivacyPolicy: !!scan.signals?.policies?.privacy,
      hasTerms: !!scan.signals?.policies?.terms,
      hasCookiePolicy: !!scan.signals?.policies?.cookies,
      hasCookieBanner: !!scan.signals?.consent?.bannerDetected,

      // detections
      trackingScriptsDetected,
      cookieVendorsDetected,

      // forms
      formsDetected: Number(scan.signals?.forms?.detected || 0),
      formsPersonalDataSignals: Number(scan.signals?.forms?.personalDataSignals || 0),

      // accessibility
      totalImages,
      imagesMissingAlt,
      accessibilityNotes: cap(scan.signals?.accessibility?.notes, 8),

      // identity/contact
      contactInfoPresent: !!scan.signals?.contact?.detected,

      // coverage (for credibility)
      checkedPages: cap(checkedPages, 12),
      failedPages: cap(failedPages, 12),
      scanCoverageNotes: cap(structured.coverage.notes, 10),
    };

    return res.json({
      ...structured,
      ...flat,
      findings: buildFindingsFromFlat(flat), // legacy list for older UI + secondary detail
    });
  } catch (e) {
    console.error("preview-scan error:", e);
    return res.status(500).json({
      ok: false,
      error: "preview_failed",
      message: "Preview scan failed",
    });
  }
});

/* =========================
   STRIPE CHECKOUT (£99)
========================= */

app.post("/create-checkout", async (req, res) => {
  try {
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
              name: "Website Risk Check — Verifiable Snapshot",
            },
          },
          quantity: 1,
        },
      ],
      metadata: { url, kind: "primary" },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("checkout error:", err);
    return res.status(500).json({ error: "checkout_failed" });
  }
});

/* =========================
   PAID → IMMUTABLE REPORT (IDEMPOTENT)
========================= */

app.get("/download-report", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).send("Missing session_id");

    const sessionFile = path.join(SESSION_DIR, `${session_id}.json`);

    // Idempotent: if already created, redirect to stable token
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

    const token = generateUniqueToken();
    const { pdfPath, jsonPath } = tokenPaths(token);

    const scanData = await scanWebsite(url);

    // ✅ SOURCE OF TRUTH FOR integrityHash IS generateReport RETURN VALUE
    const { integrityHash } = await generateReport(
      { ...scanData, shareToken: token },
      pdfPath
    );

    // Persist JSON record beside PDF
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          token,
          createdAt: Date.now(),
          integrityHash,
          scanData: {
            ...scanData,
            integrityHash, // mirror for convenience
          },
        },
        null,
        2
      )
    );

    // Session mapping for idempotency
    fs.writeFileSync(sessionFile, JSON.stringify({ token, createdAt: Date.now() }));

    return res.redirect(`/r/${token}`);
  } catch (e) {
    console.error("download-report error:", e);
    return res.status(500).send("Report generation failed");
  }
});

/* =========================
   REPORT DOWNLOAD
========================= */

app.get("/r/:token", (req, res) => {
  const { token } = req.params;
  if (!isValidToken(token)) return res.status(400).send("Invalid reference");

  const { pdfPath } = tokenPaths(token);
  if (!fs.existsSync(pdfPath)) return res.status(404).send("Not found");

  return res.download(pdfPath, "website-risk-check-report.pdf");
});

/* =========================
   REPORT VERIFICATION
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
      const meta = scan.meta || {};

      return res.send(
        renderVerifyPage({
          valid: true,
          hash,
          url: meta.url,
          hostname: meta.hostname,
          scanId: meta.scanId,
          scannedAt: meta.scannedAt,
        })
      );
    }
  }

  return res.send(renderVerifyPage({ valid: false, hash }));
});

function renderVerifyPage(data) {
  const ok = data.valid === true;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Report verification</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui;background:#f7f7f8;padding:48px}
.card{max-width:720px;margin:auto;background:#fff;padding:40px;border-radius:18px;border:1px solid rgba(0,0,0,0.06)}
.status{padding:10px 14px;border-radius:999px;font-size:13px;margin-bottom:20px;background:${ok ? "#ecfdf3" : "#fef2f2"};color:${ok ? "#166534" : "#991b1b"}}
.mono{font-family:monospace;background:#f2f2f3;padding:12px;border-radius:10px;font-size:13px;word-break:break-all}
</style>
</head>
<body>
<div class="card">
<h1>Report verification</h1>
<div class="status">${ok ? "Valid report" : "Invalid or unknown report"}</div>
${
  ok
    ? `
<p><strong>Domain:</strong> ${data.hostname || ""}</p>
<p><strong>Scan ID:</strong> ${data.scanId || ""}</p>
<p><strong>Scanned at:</strong> ${data.scannedAt || ""}</p>
<p><strong>Integrity hash:</strong></p>
<div class="mono">${data.hash}</div>`
    : `<p>This report could not be verified.</p>`
}
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
