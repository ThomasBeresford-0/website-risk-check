// server/server.js
// FULL RAMBO — hardened payments, abuse resistance, zero ambiguity

import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { scanWebsite } from "./scan.js";
import { generateReport } from "./report.js";

/* =========================
   ENV + BOOT
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
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   SIMPLE IN-MEMORY RATE LIMIT
   (Enough to stop abuse, no Redis)
========================= */

const RATE_LIMIT_WINDOW = 60_000; // 1 min
const RATE_LIMIT_MAX = 15;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const now = Date.now();
  const record = hits.get(ip) || [];
  const recent = record.filter((t) => now - t < RATE_LIMIT_WINDOW);

  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }

  recent.push(now);
  hits.set(ip, recent);
  next();
}

/* =========================
   HEALTH
========================= */

app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "healthy" });
});

/* =========================
   FREE PREVIEW SCAN
========================= */

app.post("/preview-scan", rateLimit, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL required" });
    }

    const scan = await scanWebsite(url);

    const preview = {
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
          : "No obvious alt text issues detected",
      ],
    };

    res.json(preview);
  } catch (err) {
    console.error("❌ Preview scan error:", err);
    res.status(500).json({ error: "Preview scan failed" });
  }
});

/* =========================
   STRIPE CHECKOUT
   URL CRYPTO-LOCKED
========================= */

app.post("/create-checkout", rateLimit, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL required" });
    }

    const urlHash = crypto
      .createHash("sha256")
      .update(url)
      .digest("hex");

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
      metadata: {
        url,
        url_hash: urlHash,
        product: "website-risk-check",
      },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout error:", err);
    res.status(500).json({ error: "Checkout failed" });
  }
});

app.post("/create-upsell-checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: 3900,
            product_data: {
              name: "Additional Website Risk Check",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        url,
        product: "website-risk-check-upsell",
      },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Upsell checkout error:", err);
    res.status(500).json({ error: "Upsell checkout failed" });
  }
});


/* =========================
   PAID REPORT DOWNLOAD
========================= */

app.get("/download-report", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).send("Stripe not configured");
    }

    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).send("Missing session_id");
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session || session.payment_status !== "paid") {
      return res.status(403).send("Payment not verified");
    }

    const url = session.metadata?.url;
    const urlHash = session.metadata?.url_hash;

    if (!url || !urlHash) {
      return res.status(400).send("Invalid session metadata");
    }

    const verifyHash = crypto
      .createHash("sha256")
      .update(url)
      .digest("hex");

    if (verifyHash !== urlHash) {
      return res.status(403).send("URL verification failed");
    }

    const scanData = await scanWebsite(url);
    const filePath = await generateReport(scanData);

    res.download(filePath, "website-risk-check-report.pdf");
  } catch (err) {
    console.error("❌ Report error:", err);
    res.status(500).send("Failed to generate report");
  }
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`✅ Server live on port ${PORT}`);
  console.log(`✅ BASE_URL: ${BASE_URL}`);
  console.log(
    `✅ Stripe: ${STRIPE_SECRET_KEY ? "configured" : "NOT configured"}`
  );
});
