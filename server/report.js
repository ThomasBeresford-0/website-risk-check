// server/report.js
// FULL RAMBO — audit-grade, verifiable, point-in-time, immutable PDF

import PDFDocument from "pdfkit";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);

/* =========================
   HELPERS
========================= */

function yesNo(v) {
  return v ? "Detected" : "Not detected";
}

function iso(ts) {
  return new Date(ts).toISOString();
}

function addFooter(doc, meta) {
  const bottom = doc.page.height - 42;
  const verifyUrl = `${process.env.BASE_URL}/verify/${meta.integrityHash}`;

  doc
    .fontSize(8)
    .fillColor("#666")
    .text(
      `WebsiteRiskCheck.com • Report ID: ${meta.scanId} • Generated: ${iso(
        meta.scannedAt
      )}`,
      50,
      bottom - 10,
      { align: "center", width: doc.page.width - 100 }
    )
    .text(
      `Verify this report: ${verifyUrl}`,
      50,
      bottom,
      { align: "center", width: doc.page.width - 100 }
    )
    .fillColor("#000");
}

function addWatermark(doc, text) {
  doc.save();
  doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc
    .fontSize(48)
    .fillColor("#eeeeee")
    .opacity(0.35)
    .text(text, doc.page.width / -4, doc.page.height / 2, {
      align: "center",
      width: doc.page.width * 2,
    });
  doc.opacity(1).fillColor("#000").restore();
}

function section(doc, title) {
  doc.fontSize(16).text(title);
  doc.moveDown(0.5);
}

/* =========================
   REPORT GENERATION
========================= */

export async function generateReport(data, outputPath) {
  return new Promise(async (resolve, reject) => {
    /* ======================================================
       INTEGRITY HASH (OBJECTIVE FACTS ONLY)
    ====================================================== */

    const integrityPayload = {
      url: data.url,
      hostname: data.hostname,
      scanId: data.scanId,
      scannedAt: data.scannedAt,
      https: data.https,
      hasPrivacyPolicy: data.hasPrivacyPolicy,
      hasTerms: data.hasTerms,
      hasCookiePolicy: data.hasCookiePolicy,
      hasCookieBanner: data.hasCookieBanner,
      trackingScriptsDetected: data.trackingScriptsDetected,
      cookieVendorsDetected: data.cookieVendorsDetected,
      formsDetected: data.formsDetected,
      formsPersonalDataSignals: data.formsPersonalDataSignals,
      totalImages: data.totalImages,
      imagesMissingAlt: data.imagesMissingAlt,
      accessibilityNotes: data.accessibilityNotes,
      contactInfoPresent: data.contactInfoPresent,
    };

    const integrityHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(integrityPayload))
      .digest("hex");

    data.integrityHash = integrityHash;

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const verifyUrl = `${process.env.BASE_URL}/verify/${integrityHash}`;

    /* ======================================================
       COVER
    ====================================================== */

    addWatermark(doc, "COMPLIANCE SNAPSHOT");

    doc.fontSize(28).text("Website Compliance & Risk Snapshot", {
      align: "center",
    });

    doc.moveDown(1);

    doc.fontSize(12).text(
      "Publicly observable signals recorded at the time of scan",
      { align: "center" }
    );

    doc.moveDown(3);

    doc.fontSize(12).text(`Scanned domain:\n${data.hostname || data.url}`, {
      align: "center",
    });

    doc.moveDown(1);

    doc.fontSize(11).text(
      `Generated: ${iso(data.scannedAt)}\nReport ID: ${
        data.scanId
      }\nIntegrity hash: ${integrityHash.slice(0, 20)}…`,
      { align: "center" }
    );

    doc.moveDown(3);

    doc.fontSize(9).text(
      "This document records observable facts only. It does not certify compliance and does not constitute legal advice.",
      { align: "center" }
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       EXECUTIVE SUMMARY
    ====================================================== */

    addWatermark(doc, "SUMMARY");

    section(doc, "Executive summary");

    doc.fontSize(11).text(
      "This report provides a factual, point-in-time snapshot of compliance-relevant signals detected on the target website."
    );

    doc.moveDown(1);

    doc.fontSize(11).text("Scan scope:");
    doc.list(
      [
        "Homepage inspection",
        "Common public policy paths",
        "Unauthenticated, public-facing content only",
        "No crawling, no behavioural simulation",
      ],
      { bulletRadius: 2 }
    );

    if (data.riskReasons?.length) {
      doc.moveDown(1);
      doc.fontSize(11).text("Notable observations:");
      doc.list(data.riskReasons, { bulletRadius: 2 });
    }

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       OBSERVED FINDINGS
    ====================================================== */

    addWatermark(doc, "OBSERVED SIGNALS");

    section(doc, "Observed findings");

    const findings = [
      ["HTTPS enabled", yesNo(data.https)],
      ["Privacy policy present", yesNo(data.hasPrivacyPolicy)],
      ["Terms page present", yesNo(data.hasTerms)],
      ["Cookie banner present", yesNo(data.hasCookieBanner)],
      ["Cookie policy present", yesNo(data.hasCookiePolicy)],
      [
        "Tracking scripts detected",
        data.trackingScriptsDetected.length
          ? data.trackingScriptsDetected.join(", ")
          : "None detected",
      ],
      [
        "Cookie vendors detected",
        data.cookieVendorsDetected.length
          ? data.cookieVendorsDetected.join(", ")
          : "None detected",
      ],
      ["Forms detected", String(data.formsDetected)],
      [
        "Potential personal-data fields (heuristic)",
        String(data.formsPersonalDataSignals || 0),
      ],
      [
        "Images missing alt text",
        `${data.imagesMissingAlt} of ${data.totalImages}`,
      ],
      ["Contact information present", yesNo(data.contactInfoPresent)],
    ];

    let y = doc.y + 10;
    findings.forEach(([label, value]) => {
      doc.fontSize(11).text(label, 50, y, { width: 260 });
      doc.fontSize(11).text(value, 330, y, { width: 210 });
      y += 20;
    });

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       LIMITATIONS
    ====================================================== */

    addWatermark(doc, "LIMITATIONS");

    section(doc, "Assessment limitations");

    doc.fontSize(11).list(
      [
        "Results apply only at the recorded timestamp.",
        "No claim of completeness or compliance is made.",
        "Site content may change without notice.",
        "Hidden or dynamically loaded content may not be detected.",
      ],
      { bulletRadius: 2 }
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       VERIFICATION
    ====================================================== */

    addWatermark(doc, "VERIFICATION");

    section(doc, "Report verification");

    doc.fontSize(11).text(
      "This report can be independently verified using its cryptographic fingerprint."
    );

    doc.moveDown(1);

    doc.fontSize(10).text(`Integrity hash (SHA-256):\n${integrityHash}`);

    doc.moveDown(1);

    doc.fontSize(10).text(`Verify this report:\n${verifyUrl}`);

    doc.moveDown(1);

    const qrDataUrl = await QRCode.toDataURL(verifyUrl);
    doc.image(qrDataUrl, 50, doc.y, { width: 120 });

    addFooter(doc, data);

    doc.end();

    stream.on("finish", () => resolve(outputPath));
    stream.on("error", reject);
  });
}
