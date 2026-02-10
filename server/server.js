// server/server.js
// FULL RAMBO — immutable reports + permanent share links + first-party analytics

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

// Optional admin key to view analytics: set in Render env (recommended)
const ANALYTICS_ADMIN_KEY = process.env.ANALYTICS_ADMIN_KEY || "";

/* =========================
   STORAGE
========================= */

const DATA_DIR = path.join(__dirname, "data");
const REPORT_DIR = path.join(DATA_DIR, "reports");
const SESSION_DIR = path.join(DATA_DIR, "sessions");
const ANALYTICS_DIR = path.join(DATA_DIR, "analytics");
const ANALYTICS_EVENTS_FILE = path.join(ANALYTICS_DIR, "events.ndjson");

[DATA_DIR, REPORT_DIR, SESSION_DIR, ANALYTICS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function generateToken() {
  return crypto.randomBytes(6).toString("base64url");
}

function isValidToken(token) {
  return /^[a-zA-Z0-9_-]{8,16}$/.test(token);
}

/* =========================
   ANALYTICS (FIRST-PARTY)
========================= */

function safeStr(v, max = 200) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

function hashIp(ip) {
  if (!ip) return "";
  const salt = process.env.IP_HASH_SALT || "wrc_salt";
  return crypto.createHash("sha256").update(String(ip) + salt).digest("hex");
}

function appendEvent(event) {
  try {
    fs.appendFileSync(ANALYTICS_EVENTS_FILE, JSON.stringify(event) + "\n");
  } catch (e) {
    // Do not break revenue flow for analytics
    console.error("❌ Analytics append failed:", e);
  }
}

// Client sends minimal data; server enriches + stores
app.post("/api/track", (req, res) => {
  try {
    const { name, props, sid } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ ok: false });

    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip;
    const ua = req.headers["user-agent"] || "";
    const ref = req.headers["referer"] || "";

    const event = {
      ts: Date.now(),
      name: safeStr(name, 60),
      sid: safeStr(sid || "", 64),
      props: props && typeof props === "object" ? props : {},
      // privacy-respecting: hashed IP, truncated UA/ref
      ip_hash: hashIp(ip),
      ua: safeStr(ua, 200),
      ref: safeStr(ref, 200),
    };

    appendEvent(event);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/track error:", e);
    res.status(500).json({ ok: false });
  }
});

// Admin view: simple aggregate counts by day + funnel
app.get("/admin/analytics", (req, res) => {
  try {
    const key = req.query.key || "";
    if (!ANALYTICS_ADMIN_KEY || key !== ANALYTICS_ADMIN_KEY) {
      return res.status(403).send("Forbidden");
    }

    if (!fs.existsSync(ANALYTICS_EVENTS_FILE)) {
      return res.json({ ok: true, totals: {}, days: {}, funnel: {} });
    }

    const lines = fs.readFileSync(ANALYTICS_EVENTS_FILE, "utf8").trim().split("\n").filter(Boolean);

    const totals = {};
    const days = {};
    const funnelBySid = new Map();

    function dayKey(ts) {
      const d = new Date(ts);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      const name = ev.name || "unknown";
      totals[name] = (totals[name] || 0) + 1;

      const dk = dayKey(ev.ts || Date.now());
      days[dk] = days[dk] || {};
      days[dk][name] = (days[dk][name] || 0) + 1;

      const sid = ev.sid || "";
      if (sid) {
        const set = funnelBySid.get(sid) || new Set();
        set.add(name);
        funnelBySid.set(sid, set);
      }
    }

    // Funnel: count unique sessions that reached each step
    const funnelSteps = [
      "landing_view",
      "preview_started",
      "preview_completed",
      "checkout_started",
      "checkout_redirected",
      "success_view",
      "report_generated",
      "report_downloaded",
    ];

    const funnel = {};
    for (const step of funnelSteps) funnel[step] = 0;

    for (const [, set] of funnelBySid) {
      for (const step of funnelSteps) {
        if (set.has(step)) funnel[step] += 1;
      }
    }

    res.json({ ok: true, totals, days, funnel, unique_sessions: funnelBySid.size });
  } catch (e) {
    console.error("❌ /admin/analytics error:", e);
    res.status(500).send("Error");
  }
});

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   HEALTH
========================= */

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* =========================
   PREVIEW SCAN (LIGHT RATE LIMIT)
========================= */

const previewHits = new Map();

app.post("/preview-scan", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip;
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
      riskLevel: scan.riskLevel,
      findings: [
        scan.hasPrivacyPolicy
          ? "Privacy policy detected"
          : "No privacy policy detected",
        scan.hasCookieBanner
          ? "Cookie consent banner detected"
          : "No cookie consent banner detected",
        scan.trackingScriptsDetected.length
          ? `Tracking scripts detected (${scan.trackingScriptsDetected.join(", ")})`
          : "No tracking scripts detected",
        scan.formsDetected > 0
          ? `Forms detected (${scan.formsDetected})`
          : "No forms detected",
        scan.imagesMissingAlt > 0
          ? `Images missing alt text (${scan.imagesMissingAlt})`
          : "No obvious image alt issues detected",
      ],
    });
  } catch (err) {
    console.error("❌ Preview scan error:", err);
    res.status(500).json({ error: "Preview failed" });
  }
});

/* =========================
   STRIPE CHECKOUT (£79)
========================= */

app.post("/create-checkout", async (req, res) => {
  try {
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
            unit_amount: 7900,
            product_data: {
              name: "Website Risk Check — Compliance Snapshot",
            },
          },
          quantity: 1,
        },
      ],
      metadata: { url },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

/* =========================
   PAID → IMMUTABLE REPORT (IDEMPOTENT PER SESSION)
========================= */

app.get("/download-report", async (req, res) => {
  try {
    if (!stripe) return res.status(500).send("Stripe not configured");

    const { session_id } = req.query;
    if (!session_id) return res.status(400).send("Missing session_id");

    const sessionFile = path.join(SESSION_DIR, `${session_id}.json`);

    // ✅ If already processed, reuse existing token
    if (fs.existsSync(sessionFile)) {
      const { token } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      appendEvent({ ts: Date.now(), name: "report_downloaded", sid: "", props: { via: "session_reuse" } });
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
      JSON.stringify({ token, createdAt: Date.now(), scanData }, null, 2)
    );

    await generateReport(
      { ...scanData, shareToken: token },
      pdfPath
    );

    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ token, createdAt: Date.now() })
    );

    appendEvent({ ts: Date.now(), name: "report_generated", sid: "", props: { token } });

    res.redirect(`/r/${token}`);
  } catch (err) {
    console.error("❌ Report generation error:", err);
    res.status(500).send("Failed to generate report");
  }
});

/* =========================
   PERMANENT SHARE LINK
========================= */

app.get("/r/:token", (req, res) => {
  const { token } = req.params;

  if (!isValidToken(token)) {
    return res.status(400).send("Invalid report reference");
  }

  const pdfPath = path.join(REPORT_DIR, `${token}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).send("Report not found");
  }

  appendEvent({ ts: Date.now(), name: "report_downloaded", sid: "", props: { via: "share_link" } });

  res.download(pdfPath, "website-risk-check-report.pdf");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`✅ Website Risk Check running on port ${PORT}`);
});
