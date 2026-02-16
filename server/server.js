// server/server.js
// FULL RAMBO — immutable reports + structured preview + verification + payments
// ✅ Boutique PDF supported (report.js)
// ✅ Cryptographic verification is REAL (recomputes integrity hash from stored scanData)
// ✅ Atomic writes (no partial PDFs/JSON on crash)

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
import { computeIntegrityHash } from "./integrity.js";

/* =========================
   ENV + APP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// IMPORTANT: keep this consistent across ALL pages (index, success, share, threepack, verify, sample-report)
const ASSET_VERSION = process.env.ASSET_VERSION || "13";

if (!STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY missing");
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
  return crypto.randomBytes(6).toString("base64url"); // ~8 chars
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
  for (let i = 0; i < 6; i++) {
    const token = generateToken();
    const { pdfPath, jsonPath } = tokenPaths(token);
    if (!fs.existsSync(pdfPath) && !fs.existsSync(jsonPath)) return token;
  }
  return crypto.randomBytes(10).toString("base64url");
}

// Atomic write (tmp → rename) to avoid partial files on crash
function writeFileAtomic(filePath, data, encoding = "utf8") {
  const tmp = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, data, encoding);
  fs.renameSync(tmp, filePath);
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* =========================
   MIDDLEWARE
========================= */

app.disable("x-powered-by");

app.use(cors());
app.use(express.json({ limit: "30kb" }));

// Serve /public
const PUBLIC_DIR = path.join(__dirname, "../public");
app.use(express.static(PUBLIC_DIR, { etag: true }));

app.get("/sample-report.pdf", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "sample-report.pdf");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/sample-report.pdf on server");
  return res.sendFile(p);
});

app.get("/vendor/pdfjs/pdf.min.js", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "vendor/pdfjs/pdf.min.js");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/vendor/pdfjs/pdf.min.js");
  return res.sendFile(p);
});

app.get("/vendor/pdfjs/pdf.worker.min.js", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "vendor/pdfjs/pdf.worker.min.js");
  if (!fs.existsSync(p)) return res.status(404).send("Missing public/vendor/pdfjs/pdf.worker.min.js");
  return res.sendFile(p);
});

/* =========================
   DEBUG: ASSET CHECK (safe, no secrets)
   Hit /__assets to see what Render actually has.
========================= */

app.get("/__assets", (_req, res) => {
  try {
    const exists = (rel) => fs.existsSync(path.join(PUBLIC_DIR, rel));
    const size = (rel) => {
      try {
        return fs.statSync(path.join(PUBLIC_DIR, rel)).size;
      } catch {
        return 0;
      }
    };

    return res.json({
      ok: true,
      publicDir: PUBLIC_DIR,
      files: {
        "sample-report.pdf": { exists: exists("sample-report.pdf"), bytes: size("sample-report.pdf") },
        "vendor/pdfjs/pdf.min.js": {
          exists: exists("vendor/pdfjs/pdf.min.js"),
          bytes: size("vendor/pdfjs/pdf.min.js"),
        },
        "vendor/pdfjs/pdf.worker.min.js": {
          exists: exists("vendor/pdfjs/pdf.worker.min.js"),
          bytes: size("vendor/pdfjs/pdf.worker.min.js"),
        },
        "sample-report.html": { exists: exists("sample-report.html"), bytes: size("sample-report.html") },
        "sample-report.js": { exists: exists("sample-report.js"), bytes: size("sample-report.js") },
        "sample-report.css": { exists: exists("sample-report.css"), bytes: size("sample-report.css") },
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "asset_check_failed" });
  }
});

/* =========================
   HEALTH
========================= */

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/__version", (_req, res) => {
  res.type("text").send("server.js live: sample-report-assets v1");
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

// Legacy fallback (only used if scan.js doesn't provide findingsText[])
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

  findings.push(
    flat.contactInfoPresent
      ? "Contact/identity signals: detected"
      : "Contact/identity signals: not detected"
  );
  findings.push(flat.https ? "HTTPS: detected" : "HTTPS: not detected");

  return findings.slice(0, 12);
}

app.post("/preview-scan", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.headers["cf-connecting-ip"]?.toString() ||
      req.ip;

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
      return res
        .status(400)
        .json({ ok: false, error: "invalid_request", message: "URL required" });
    }

    const scan = await scanWebsite(url);

    const structured = {
      ok: true,
      meta: scan.meta,
      coverage: {
        checkedPages: scan.coverage?.checkedPages || [],
        failedPages: scan.coverage?.failedPages || [],
        notes: scan.coverage?.notes || [],
        fetchOk: scan.coverage?.fetchOk,
        fetchStatus: scan.coverage?.fetchStatus,
      },
      signals: scan.signals,
      risk: scan.risk,
      findings: Array.isArray(scan.findings) ? scan.findings : [],
      findingsText: Array.isArray(scan.findingsText) ? scan.findingsText : [],
    };

    const checkedPages = structured.coverage.checkedPages;
    const failedPages = structured.coverage.failedPages;

    const trackingScriptsDetected = cap(scan.signals?.trackingScripts, 12);
    const cookieVendorsDetected = cap(scan.signals?.consent?.vendors, 12);

    const totalImages = Number(scan.signals?.accessibility?.images?.total || 0);
    const imagesMissingAlt = Number(
      scan.signals?.accessibility?.images?.missingAlt || 0
    );

    const flat = {
      url: scan.meta?.url,
      hostname: scan.meta?.hostname,
      scannedAt: scan.meta?.scannedAt,

      https: !!scan.meta?.https,
      fetchOk: Array.isArray(checkedPages) && checkedPages.length > 0,
      fetchStatus: Number(scan.coverage?.fetchStatus || 200),

      riskLevel: scan.risk?.level || "Medium",

      hasPrivacyPolicy: !!scan.signals?.policies?.privacy,
      hasTerms: !!scan.signals?.policies?.terms,
      hasCookiePolicy: !!scan.signals?.policies?.cookies,
      hasCookieBanner: !!scan.signals?.consent?.bannerDetected,

      trackingScriptsDetected,
      cookieVendorsDetected,

      formsDetected: Number(scan.signals?.forms?.detected || 0),
      formsPersonalDataSignals: Number(
        scan.signals?.forms?.personalDataSignals || 0
      ),

      totalImages,
      imagesMissingAlt,
      accessibilityNotes: cap(scan.signals?.accessibility?.notes, 8),

      contactInfoPresent: !!scan.signals?.contact?.detected,

      checkedPages: cap(checkedPages, 12),
      failedPages: cap(failedPages, 12),
      scanCoverageNotes: cap(structured.coverage.notes, 10),
    };

    const findingsText =
      Array.isArray(scan.findingsText) && scan.findingsText.length
        ? scan.findingsText.slice(0, 12)
        : buildFindingsFromFlat(flat);

    return res.json({
      ...structured,
      ...flat,
      findings: findingsText,
      findingsStructured: structured.findings,
    });
  } catch (e) {
    console.error("preview-scan error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "preview_failed", message: "Preview scan failed" });
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
            product_data: { name: "Website Risk Check — Verifiable Snapshot" },
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

    if (fs.existsSync(sessionFile)) {
      const existing = safeReadJson(sessionFile);
      if (existing?.token) return res.redirect(`/r/${existing.token}`);
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session || session.payment_status !== "paid") {
      return res.status(403).send("Payment not verified");
    }

    const url = session.metadata?.url;
    if (!url) return res.status(400).send("Missing URL");

    const token = generateUniqueToken();
    const { pdfPath, jsonPath } = tokenPaths(token);

    const tmpPdf = `${pdfPath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    const scanData = await scanWebsite(url);

    const { integrityHash } = await generateReport(
      { ...scanData, shareToken: token },
      tmpPdf
    );

    const sealed = {
      token,
      createdAt: Date.now(),
      integrityHash,
      scanData: {
        ...scanData,
        integrityHash,
      },
    };

    writeFileAtomic(jsonPath, JSON.stringify(sealed, null, 2), "utf8");
    fs.renameSync(tmpPdf, pdfPath);

    writeFileAtomic(
      sessionFile,
      JSON.stringify({ token, createdAt: Date.now() }),
      "utf8"
    );

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
    const parsed = safeReadJson(path.join(REPORT_DIR, file));
    if (!parsed || !parsed.scanData) continue;

    const scan = parsed.scanData;

    let recomputed = "";
    try {
      recomputed = computeIntegrityHash(scan);
    } catch {
      continue;
    }

    if (recomputed !== hash) continue;

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

  return res.send(renderVerifyPage({ valid: false, hash }));
});

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderVerifyPage(data) {
  const ok = data.valid === true;

  const safeHash = escapeHtml(data.hash || "");
  const safeHostname = escapeHtml(data.hostname || "");
  const safeUrl = escapeHtml(data.url || "");
  const safeScanId = escapeHtml(data.scanId || "");
  const safeScannedAt = escapeHtml(data.scannedAt || "");

  const title = ok ? "Verified report" : "Unverified report";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Website Risk Check</title>
  <meta name="description" content="Verify a Website Risk Check report using its verification code." />
  <meta name="theme-color" content="#0b1220" />

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg?v=1" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">

  <link rel="stylesheet" href="/style.css?v=${escapeHtml(ASSET_VERSION)}" />
</head>

<body>
  <div class="bg" aria-hidden="true"></div>

  <nav class="nav">
    <div class="container navInner">
      <a class="brand" href="/" aria-label="Website Risk Check">
        <img class="brandLogo" src="/favicon.svg?v=1" alt="" />
        <span class="brandText">Website Risk Check</span>
      </a>

      <div class="navCtas">
        <a class="navBtn" href="/#scan">Run a scan</a>
      </div>
    </div>
  </nav>

  <main class="page">
    <section class="container">
      <div class="verifyShell">

        <header class="verifyHead">
          <div>
            <div class="verifyKicker">Public verification</div>
            <h1 class="verifyTitle">${ok ? "Report verified" : "Report not verified"}</h1>
            <p class="verifySub">
              ${
                ok
                  ? "This verification code matches a sealed report stored by Website Risk Check. If the PDF is modified after generation, verification fails."
                  : "This code does not match any sealed report on record, or the link is malformed."
              }
            </p>
          </div>

          <div class="verifyBadge ${ok ? "isOk" : "isBad"}">
            <span class="verifyDot" aria-hidden="true"></span>
            <span>${ok ? "Valid" : "Invalid"}</span>
          </div>
        </header>

        <div class="issueCard">
          <div class="issueTop">
            <div>
              <div class="issueTitle">Verification details</div>
              <div class="issueHint">Verification code</div>
            </div>
          </div>

          <div class="verifyBlock">
            <div class="verifyLabel">Code</div>
            <div class="monoBox">${safeHash || "—"}</div>
          </div>

          ${
            ok
              ? `
          <div class="verifyGrid">
            <div class="verifyItem">
              <div class="verifyItemTop">Domain</div>
              <div class="verifyItemVal">${safeHostname || "—"}</div>
            </div>
            <div class="verifyItem">
              <div class="verifyItemTop">Scan ID</div>
              <div class="verifyItemVal">${safeScanId || "—"}</div>
            </div>
            <div class="verifyItem">
              <div class="verifyItemTop">Scanned at (UTC)</div>
              <div class="verifyItemVal">${safeScannedAt || "—"}</div>
            </div>
            <div class="verifyItem">
              <div class="verifyItemTop">URL</div>
              <div class="verifyItemVal">${safeUrl || "—"}</div>
            </div>
          </div>`
              : `
          <div class="helperNote" style="margin-top:14px;">
            If you received this link from an agency or consultant, ask them to resend the report link, or confirm the verification code printed inside the PDF.
          </div>`
          }

          <div class="dividerLine" style="margin:16px 0;"></div>

          <div class="verifyForm">
            <div class="verifyLabel">Verify another code</div>
            <div class="verifyInputRow">
              <input id="hashInput" type="text" inputmode="text" placeholder="Paste 64-character code…" />
              <button id="hashGo" class="btnPrimary" type="button">Verify</button>
            </div>
            <div class="issueFine">
              Tip: the verification code is printed inside the PDF report.
            </div>
          </div>

          <div class="issueNotes">
            <p>Verification confirms integrity only. It does not certify compliance and is not legal advice.</p>
          </div>
        </div>

      </div>
    </section>
  </main>

  <script>
    (function () {
      const input = document.getElementById("hashInput");
      const btn = document.getElementById("hashGo");
      function go() {
        const v = (input.value || "").trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(v)) return;
        window.location.href = "/verify/" + v;
      }
      btn.addEventListener("click", go);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    })();
  </script>
</body>
</html>`;
}

/* =========================
   SAMPLE REPORT PAGE
========================= */

app.get("/sample-report", (_req, res) => {
  return res.sendFile(path.join(__dirname, "../public", "sample-report.html"));
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
console.log(`Website Risk Check running on port ${PORT}`);
});
