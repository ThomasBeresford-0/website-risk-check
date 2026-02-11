// server/server.js
// FULL RAMBO — immutable reports + verification + payments + analytics + bundles

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

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY && process.env.NODE_ENV === "production") {
  console.error("❌ STRIPE_SECRET_KEY missing");
  process.exit(1);
}
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

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
   PREVIEW SCAN
========================= */

const previewHits = new Map();

app.post("/preview-scan", async (req, res) => {
  try {
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

    res.json({
      url: scan.url,
      scannedAt: scan.scannedAt,
      findings: [
        scan.hasPrivacyPolicy
          ? "Privacy policy detected"
          : "No privacy policy detected",
        scan.hasCookieBanner
          ? "Cookie consent banner detected"
          : "No cookie consent banner detected",
        scan.trackingScriptsDetected.length
          ? `Tracking scripts detected (${scan.trackingScriptsDetected.join(
              ", "
            )})`
          : "No tracking scripts detected",
        scan.formsDetected > 0
          ? `Forms detected (${scan.formsDetected})`
          : "No forms detected",
      ],
    });
  } catch {
    res.status(500).json({ error: "Preview failed" });
  }
});

/* =========================
   STRIPE CHECKOUT (£99)
========================= */

app.post("/create-checkout", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

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
    metadata: { url, kind: "primary" },
    success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/`,
  });

  res.json({ url: session.url });
});

/* =========================
   PAID → IMMUTABLE REPORT
========================= */

app.get("/download-report", async (req, res) => {
  if (!stripe) return res.status(500).send("Stripe not configured");

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

  await generateReport({ ...scanData, shareToken: token }, pdfPath);

  fs.writeFileSync(
    sessionFile,
    JSON.stringify({ token, createdAt: Date.now() })
  );

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
body{font-family:system-ui;background:#f7f7f8;padding:40px}
.card{max-width:720px;margin:auto;background:#fff;padding:36px;border-radius:18px}
.status{padding:12px;border-radius:999px;margin-bottom:20px;
background:${ok ? "#ecfdf3" : "#fef2f2"};
color:${ok ? "#166534" : "#991b1b"}}
.mono{font-family:monospace;background:#f2f2f3;padding:12px;border-radius:10px}
</style>
</head>
<body>
<div class="card">
<h1>Report verification</h1>
<div class="status">${ok ? "Valid report" : "Invalid or unknown report"}</div>
${ok ? `
<p><strong>Domain:</strong> ${data.hostname || data.url}</p>
<p><strong>Scan ID:</strong> ${data.scanId}</p>
<p><strong>Scanned at:</strong> ${new Date(data.scannedAt).toISOString()}</p>
<p class="mono">${data.hash}</p>
` : `
<p>This report could not be verified.</p>
`}
<p>This page confirms whether a report matches the cryptographic fingerprint generated at scan time.</p>
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
