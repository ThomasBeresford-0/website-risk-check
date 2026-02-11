// server/report.js
// FULL RAMBO — audit-grade, verifiable, point-in-time, immutable PDF (final structure)

import PDFDocument from "pdfkit";
import fs from "fs";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

import { computeRisk } from "./risk.js";
import { computeIntegrityHash } from "./integrity.js";

const __filename = fileURLToPath(import.meta.url);

/* =========================
   HELPERS
========================= */

function iso(ts) {
  return new Date(ts).toISOString();
}

function yesNo(v) {
  return v ? "Detected" : "Not detected";
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ensureSpace(doc, minSpace = 120) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + minSpace > bottom) doc.addPage();
}

function addHeader(doc, data) {
  const topY = 22;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  doc.save();
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#111827")
    .text("Website Risk Snapshot", left, topY, {
      width: right - left,
      align: "left",
    });

  doc
    .font("Helvetica")
    .fillColor("#6B7280")
    .text(`${data.hostname || data.url}`, left, topY, {
      width: right - left,
      align: "right",
    });

  doc.restore();
}

function addFooter(doc, meta) {
  const bottom = doc.page.height - 38;
  const left = doc.page.margins.left;
  const width =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const verifyUrl = `${process.env.BASE_URL}/verify/${meta.integrityHash}`;

  doc.save();
  doc
    .fontSize(8)
    .fillColor("#6B7280")
    .text(
      `WebsiteRiskCheck.com • Report ID: ${meta.scanId} • Timestamp (UTC): ${iso(
        meta.scannedAt
      )}`,
      left,
      bottom - 10,
      { width, align: "center" }
    )
    .text(`Verify: ${verifyUrl}`, left, bottom, { width, align: "center" });

  doc.restore();
}

function hr(doc, pad = 10) {
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  const y = doc.y;

  doc.save();
  doc.strokeColor("#E5E7EB").lineWidth(1);
  doc.moveTo(x1, y + pad).lineTo(x2, y + pad).stroke();
  doc.restore();

  doc.moveDown(1);
}

function badge(doc, text, tone = "gray", x, y) {
  const tones = {
    green: { bg: "#ECFDF5", fg: "#065F46", br: "#A7F3D0" },
    amber: { bg: "#FFFBEB", fg: "#92400E", br: "#FDE68A" },
    red: { bg: "#FEF2F2", fg: "#991B1B", br: "#FECACA" },
    gray: { bg: "#F3F4F6", fg: "#111827", br: "#E5E7EB" },
    blue: { bg: "#EFF6FF", fg: "#1D4ED8", br: "#BFDBFE" },
  };
  const t = tones[tone] || tones.gray;

  const padX = 10;
  const padY = 6;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(10);
  const w = doc.widthOfString(text) + padX * 2;
  const h = 10 + padY * 2;

  doc
    .roundedRect(x, y, w, h, 10)
    .fillColor(t.bg)
    .fill()
    .lineWidth(1)
    .strokeColor(t.br)
    .stroke();

  doc.fillColor(t.fg).text(text, x + padX, y + padY - 1);
  doc.restore();

  return { w, h };
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 120);
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#111827")
    .text(title);
  doc.moveDown(0.6);
}

function subTitle(doc, title) {
  ensureSpace(doc, 90);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#111827")
    .text(title);
  doc.moveDown(0.4);
}

function bodyText(doc, text) {
  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor("#374151")
    .text(text, { lineGap: 3 });
}

function bulletList(doc, items) {
  const safe = safeArr(items).filter(Boolean);
  if (!safe.length) return;
  doc.font("Helvetica").fontSize(10.5).fillColor("#374151");
  doc.list(safe, { bulletRadius: 2, lineGap: 3 });
}

function whatThisMeansFor(level) {
  if (level === "High") {
    return "This snapshot shows multiple risk-relevant signals and/or missing indicators that commonly correlate with higher exposure on customer-facing websites. It does not prove non-compliance, but it suggests a review of policies, consent mechanisms, and data-capture touchpoints may be warranted.";
  }
  if (level === "Medium") {
    return "This snapshot shows some risk-relevant signals and/or missing indicators that are commonly expected on customer-facing websites. It does not prove non-compliance, but it suggests potential gaps worth reviewing.";
  }
  return "This snapshot shows relatively few risk-relevant signals based on what was detectable at the time of scanning. It does not guarantee compliance, but fewer obvious gaps were detected on the scanned surface.";
}

/* =========================
   REPORT GENERATION
========================= */

export async function generateReport(data, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Source-of-truth integrity hash (objective fields only)
      const integrityHash = computeIntegrityHash(data);
      data.integrityHash = integrityHash;

      // Source-of-truth risk model (signal-based)
      const risk = computeRisk(data);
      data.riskLevel = risk.level;
      data.riskScore = risk.score;

      const verifyUrl = `${process.env.BASE_URL}/verify/${integrityHash}`;

      const doc = new PDFDocument({
        margin: 54,
        size: "A4",
        info: {
          Title: "Website Risk Snapshot",
          Author: "WebsiteRiskCheck.com",
          Subject:
            "Point-in-time website snapshot report (observable signals only).",
        },
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // Header on subsequent pages
      doc.on("pageAdded", () => addHeader(doc, data));

      /* ======================================================
         PAGE 1 — COVER
      ====================================================== */

      const left = doc.page.margins.left;
      const width =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;

      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#111827")
        .text("WebsiteRiskCheck.com", left, 60, { width, align: "left" });

      doc
        .font("Helvetica-Bold")
        .fontSize(28)
        .fillColor("#111827")
        .text("Website Risk Snapshot", left, 110, {
          width,
          align: "left",
        });

      doc
        .font("Helvetica")
        .fontSize(12)
        .fillColor("#374151")
        .text("Point-in-time observable signal assessment", {
          width,
          align: "left",
        });

      const tone =
        risk.level === "Low" ? "green" : risk.level === "Medium" ? "amber" : "red";

      badge(doc, `Risk level: ${risk.level}`, tone, left, 200);

      doc.y = 250;

      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#111827")
        .text("Website", left, doc.y, { width: 100 });
      doc
        .font("Helvetica")
        .fillColor("#374151")
        .text(`${data.hostname || data.url}`, left + 100, doc.y, {
          width: width - 100,
        });

      doc.moveDown(0.8);

      doc
        .font("Helvetica-Bold")
        .fillColor("#111827")
        .text("Timestamp (UTC)", left, doc.y, { width: 120 });
      doc
        .font("Helvetica")
        .fillColor("#374151")
        .text(`${iso(data.scannedAt)}`, left + 120, doc.y, {
          width: width - 120,
        });

      doc.moveDown(0.8);

      doc
        .font("Helvetica-Bold")
        .fillColor("#111827")
        .text("Report ID", left, doc.y, { width: 120 });
      doc
        .font("Helvetica")
        .fillColor("#374151")
        .text(`${data.scanId}`, left + 120, doc.y, { width: width - 120 });

      doc.moveDown(0.8);

      doc
        .font("Helvetica-Bold")
        .fillColor("#111827")
        .text("Integrity hash", left, doc.y, { width: 120 });
      doc
        .font("Helvetica")
        .fillColor("#374151")
        .text(`${integrityHash.slice(0, 24)}…`, left + 120, doc.y, {
          width: width - 120,
        });

      doc.moveDown(1.4);

      subTitle(doc, "Scan scope (coverage)");
      bulletList(
        doc,
        safeArr(data.scanCoverageNotes).length
          ? data.scanCoverageNotes
          : [
              "Homepage only.",
              "Public, unauthenticated HTML.",
              "No full crawl or behavioural simulation.",
            ]
      );

      doc.moveDown(1.2);

      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#6B7280")
        .text(
          "This document records observable signals only. It does not certify compliance and does not constitute legal advice. Results apply only at the recorded timestamp.",
          { width, lineGap: 3 }
        );

      addFooter(doc, data);
      doc.addPage();

      /* ======================================================
         PAGE 2 — EXECUTIVE SUMMARY
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Executive summary");

      badge(doc, `Risk level: ${risk.level}`, tone, left, doc.y);
      doc.moveDown(1.4);

      bodyText(doc, whatThisMeansFor(risk.level));
      hr(doc);

      subTitle(doc, "Key findings (detectable signals)");

      const trackers = safeArr(data.trackingScriptsDetected);
      const vendors = safeArr(data.cookieVendorsDetected);

      const totalImages = num(data.totalImages);
      const imagesMissingAlt = num(data.imagesMissingAlt);

      const keyFindings = [];

      keyFindings.push(`HTTPS: ${data.https ? "Detected" : "Not detected"}`);
      keyFindings.push(
        `Fetch status: ${
          data.fetchOk === false
            ? `Failed (HTTP ${data.fetchStatus || "unknown"})`
            : "Successful"
        }`
      );

      keyFindings.push(
        `Privacy policy: ${data.hasPrivacyPolicy ? "Detected" : "Not detected"}`
      );
      keyFindings.push(`Terms: ${data.hasTerms ? "Detected" : "Not detected"}`);
      keyFindings.push(
        `Cookie policy: ${data.hasCookiePolicy ? "Detected" : "Not detected"}`
      );
      keyFindings.push(
        `Consent banner indicator: ${
          data.hasCookieBanner ? "Detected" : "Not detected"
        } (heuristic)`
      );

      keyFindings.push(
        `Tracking scripts: ${
          trackers.length
            ? `Detected (${trackers.slice(0, 4).join(", ")}${
                trackers.length > 4 ? "…" : ""
              })`
            : "None detected"
        }`
      );
      keyFindings.push(
        `Cookie vendor signals: ${
          vendors.length
            ? `Detected (${vendors.slice(0, 4).join(", ")}${
                vendors.length > 4 ? "…" : ""
              })`
            : "None detected"
        }`
      );

      keyFindings.push(`Forms detected: ${num(data.formsDetected)}`);
      keyFindings.push(
        `Potential personal-data field signals: ${num(
          data.formsPersonalDataSignals
        )} (heuristic)`
      );
      keyFindings.push(
        `Images missing alt text: ${imagesMissingAlt} of ${totalImages}`
      );
      keyFindings.push(
        `Contact/identity signals: ${
          data.contactInfoPresent ? "Detected" : "Not detected"
        }`
      );

      bulletList(doc, keyFindings.slice(0, 12));

      doc.moveDown(0.8);
      subTitle(doc, "Notable observations");
      bulletList(doc, safeArr(data.riskReasons).length ? data.riskReasons.slice(0, 10) : risk.reasons.slice(0, 10));

      addFooter(doc, data);
      doc.addPage();

      /* ======================================================
         PAGE 3+ — FINDINGS BY CATEGORY
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Findings by category");

      subTitle(doc, "Connection");
      bulletList(doc, [`HTTPS: ${data.https ? "Detected" : "Not detected"}`]);
      bodyText(
        doc,
        "HTTPS reduces interception risk and is commonly expected for customer-facing websites."
      );
      hr(doc);

      subTitle(doc, "Policies (public-path detection)");
      bulletList(doc, [
        `Privacy policy present: ${yesNo(data.hasPrivacyPolicy)}`,
        `Terms present: ${yesNo(data.hasTerms)}`,
        `Cookie policy present: ${yesNo(data.hasCookiePolicy)}`,
      ]);
      bodyText(
        doc,
        "Policy presence is detected using a scope-locked approach (homepage links and standard public policy paths). Absence of detection is not proof of absence."
      );
      hr(doc);

      subTitle(doc, "Cookies & tracking (HTML detection)");
      bulletList(doc, [
        `Tracking scripts: ${
          trackers.length ? trackers.join(", ") : "None detected"
        }`,
        `Cookie vendor signals: ${
          vendors.length ? vendors.join(", ") : "None detected"
        }`,
      ]);
      bodyText(
        doc,
        "Detections are based on observable HTML/script references. If trackers load dynamically, they may not be detected."
      );
      hr(doc);

      subTitle(doc, "Consent indicators (heuristic)");
      bulletList(doc, [`Cookie/consent banner indicator: ${yesNo(data.hasCookieBanner)}`]);
      bodyText(
        doc,
        "This is a heuristic signal based on text and DOM patterns and/or the presence of consent vendors. It is not a guarantee."
      );
      hr(doc);

      subTitle(doc, "Forms & data capture (heuristic)");
      bulletList(doc, [
        `Forms detected: ${num(data.formsDetected)}`,
        `Potential personal-data field signals: ${num(data.formsPersonalDataSignals)}`,
      ]);
      bodyText(
        doc,
        "The personal-data signal is a heuristic count based on common field names (e.g., email, phone, name). It is not a legal classification."
      );
      hr(doc);

      subTitle(doc, "Accessibility signals (heuristic)");
      bulletList(doc, [
        `Images missing alt text: ${imagesMissingAlt} of ${totalImages}`,
        ...(safeArr(data.accessibilityNotes).length
          ? safeArr(data.accessibilityNotes).map((n) => `Note: ${n}`)
          : ["No accessibility notes recorded by this scan."]),
      ]);
      bodyText(
        doc,
        "Accessibility checks are lightweight and indicative only. A full accessibility review typically requires page coverage and manual testing."
      );
      hr(doc);

      subTitle(doc, "Contact & identity signals");
      bulletList(doc, [
        `Contact/business identity signals: ${yesNo(data.contactInfoPresent)}`,
      ]);
      bodyText(
        doc,
        "Detected using simple patterns (email/phone/contact link) on the scanned surface only."
      );
      hr(doc);

      addFooter(doc, data);
      doc.addPage();

      /* ======================================================
         COMMON NEXT STEPS (NON-PRESCRIPTIVE)
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Common next steps (non-prescriptive)");

      bodyText(
        doc,
        "The items below are commonly reviewed when these signals appear. They are provided for general orientation only and are not legal advice."
      );
      doc.moveDown(0.6);

      bulletList(doc, [
        "Ensure privacy and terms pages are public and linked from the site footer and/or homepage.",
        "If third-party tracking or cookies are used, review whether consent mechanisms are appropriate for your target regions and audiences.",
        "Review forms for minimum necessary fields and confirm where submissions are stored and who can access them.",
        "Add alt text to meaningful images on key pages where missing.",
        "Ensure visitors can easily find contact or business identity information.",
        "Re-run a snapshot after major changes (redesign, marketing tag updates, new forms, new third-party embeds).",
      ]);

      addFooter(doc, data);
      doc.addPage();

      /* ======================================================
         METHODOLOGY & LIMITATIONS
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Methodology & limitations");

      subTitle(doc, "Methodology (this scan)");
      bulletList(doc, [
        "Fetches public HTML from the homepage and standard public policy/contact paths (scope-locked).",
        "Detects common tracking scripts by known patterns in HTML.",
        "Detects common consent vendors by known patterns in HTML.",
        "Detects policy presence via homepage links and standard paths (scope-locked).",
        "Detects banner indicators via DOM/text heuristics (heuristic).",
        "Detects forms and likely personal-data field signals via field-name heuristics.",
        "Runs lightweight accessibility checks (e.g., <html lang>, H1 presence, alt text counts).",
      ]);

      doc.moveDown(0.6);

      subTitle(doc, "Scope and exclusions");
      bulletList(doc, [
        "No full-site crawling.",
        "Public, unauthenticated HTML only (no logins).",
        "No JavaScript execution or behavioural simulation (no clicking banners, no region toggles).",
        "No legal judgement, certification, or guarantee of compliance.",
        "No monitoring over time; this is a single timestamped snapshot.",
      ]);

      doc.moveDown(0.6);

      subTitle(doc, "Limitations (important)");
      bulletList(doc, [
        "Results apply only at the recorded timestamp; websites can change without notice.",
        "Dynamically loaded or interaction-gated content may not be detected.",
        "Heuristic signals may produce false positives/negatives depending on implementation.",
        "Absence of detection is not proof of absence.",
      ]);

      addFooter(doc, data);
      doc.addPage();

      /* ======================================================
         VERIFICATION
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Report verification");

      bodyText(
        doc,
        "This report can be independently verified using its cryptographic fingerprint. The integrity hash is derived from objective fields only, allowing verification that the recorded facts have not been altered."
      );

      doc.moveDown(0.8);

      subTitle(doc, "Integrity hash (SHA-256)");
      doc
        .font("Helvetica")
        .fontSize(9.8)
        .fillColor("#111827")
        .text(integrityHash, { lineGap: 2 });

      doc.moveDown(0.8);

      subTitle(doc, "Verify this report");
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .fillColor("#1F2937")
        .text(verifyUrl);

      doc.moveDown(0.8);

      subTitle(doc, "What the integrity hash covers");
      bulletList(doc, [
        "Target URL/hostname, scan ID, scan timestamp",
        "Fetch status (success/failure) and scope-locked coverage notes",
        "HTTPS signal",
        "Policy presence signals (privacy/terms/cookie policy)",
        "Consent indicator signal (cookie banner heuristic)",
        "Tracking scripts and cookie vendor detections",
        "Forms detected and personal-data field signals (heuristic counts)",
        "Accessibility signals (alt text counts, notes)",
        "Contact/identity signal presence",
        "Per-page coverage (checked/failed paths where available)",
      ]);

      doc.moveDown(0.8);

      const qrDataUrl = await QRCode.toDataURL(verifyUrl);
      ensureSpace(doc, 220);
      doc.image(qrDataUrl, doc.page.margins.left, doc.y, { width: 130 });

      addFooter(doc, data);

      doc.end();

      stream.on("finish", () => resolve({ outputPath, integrityHash }));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
