// server.js
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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ------------------------------------
// Stripe checkout
// ------------------------------------
app.post("/create-checkout", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }

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
      success_url: `http://localhost:3000/success.html?url=${encodeURIComponent(
        url
      )}`,
      cancel_url: "http://localhost:3000",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe checkout failed" });
  }
});

// ------------------------------------
// Success page
// ------------------------------------
app.get("/success.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/success.html"));
});

// ------------------------------------
// Generate + download report (SAFE)
// ------------------------------------
app.get("/download-report", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).send("Missing URL");
    }

    const scanData = await scanWebsite(url);
    const filePath = await generateReport(scanData);

    res.download(filePath, "website-risk-check-report.pdf");
  } catch (err) {
    console.error("❌ Report generation error:", err);
    res.status(500).send("Failed to generate report");
  }
});

// ------------------------------------
app.listen(3000, () => {
  console.log("✅ Server running on http://localhost:3000");
});
