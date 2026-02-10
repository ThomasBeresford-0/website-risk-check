// server/server.js

import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { scanWebsite } from "./scan.js";
import { generateReport } from "./report.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ✅ Render will set PORT automatically
const PORT = process.env.PORT || 3000;

// ✅ BASE_URL should be your canonical domain in production
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ------------------------------------
// FREE PREVIEW SCAN (NO PDF, NO STRIPE)
// ------------------------------------
app.post("/preview-scan", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    const scan = await scanWebsite(url);

    const preview = {
      url: scan.url,
      scannedAt: scan.scannedAt,
      riskLevel: scan.riskLevel,
      findings: [
        scan.hasPrivacyPolicy
          ? "Privacy policy page detected"
          : "No privacy policy page detected",

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
          : "No obvious image alt text issues detected",
      ],
    };

    res.json(preview);
  } catch (err) {
    console.error("❌ Preview scan error:", err);
    res.status(500).json({ error: "Preview scan failed" });
  }
});

// ------------------------------------
// STRIPE CHECKOUT (URL LOCKED IN METADATA)
// ------------------------------------
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
            unit_amount: 7900,
            product_data: {
              name: "Website Risk Check – Compliance Snapshot",
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
    console.error("❌ Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe checkout failed" });
  }
});

// ------------------------------------
// PAID REPORT DOWNLOAD (STRIPE VERIFIED)
// ------------------------------------
app.get("/download-report", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).send("Missing session_id");

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session || session.payment_status !== "paid") {
      return res.status(403).send("Payment not verified");
    }

    const url = session.metadata?.url;
    if (!url) return res.status(400).send("Missing URL in session");

    const scanData = await scanWebsite(url);
    const filePath = await generateReport(scanData);

    res.download(filePath, "website-risk-check-report.pdf");
  } catch (err) {
    console.error("❌ Report generation error:", err);
    res.status(500).send("Failed to generate report");
  }
});

// ------------------------------------
// ✅ IMPORTANT: listen on PORT for Render
// ------------------------------------
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`✅ BASE_URL: ${BASE_URL}`);
});
