// server/report.js
// FULL RAMBO — evidence-grade, agency-safe, IMMUTABLE PDF

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function yesNo(v) {
  return v ? "Yes" : "No";
}

function addFooter(doc, data) {
  const bottom = doc.page.height - 40;

  doc
    .fontSize(9)
    .fillColor("#666")
    .text(
      `Website Risk Check • Scan ID: ${data.scanId} • ${new Date(
        data.scannedAt
      ).toLocaleString()} • Point-in-time snapshot`,
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
    .fontSize(50)
    .fillColor("#eeeeee")
    .opacity(0.4)
    .text(text, doc.page.width / -4, doc.page.height / 2, {
      align: "center",
      width: doc.page.width * 2,
    });
  doc.opacity(1).fillColor("#000").restore();
}

function drawBox(doc, title, lines) {
  const startY = doc.y;
  const boxHeight = 18 + lines.length * 16;

  doc
    .roundedRect(50, startY, doc.page.width - 100, boxHeight, 6)
    .stroke("#ddd");

  doc.fontSize(12).text(title, 60, startY + 6);

  let y = startY + 22;
  doc.fontSize(11);
  lines.forEach((l) => {
    doc.text(`• ${l}`, 60, y);
    y += 16;
  });

  doc.moveDown(2);
}

/**
 * generateReport
 * @param {object} data - scan data + metadata
 * @param {string} outputPath - absolute path to write PDF
 */
export async function generateReport(data, outputPath) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      size: "A4",
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const shareUrl = `${process.env.BASE_URL}/r/${data.shareToken}`;

    /* ======================================================
       COVER PAGE
    ====================================================== */

    addWatermark(doc, "WEBSITE RISK CHECK");

    doc.fontSize(30).text("Website Risk Check", { align: "center" });
    doc.moveDown(0.4);

    doc
      .fontSize(14)
      .text("Website compliance & risk snapshot", { align: "center" });

    doc.moveDown(2);

    doc
      .fontSize(22)
      .text(`Overall risk level: ${data.riskLevel}`, { align: "center" });

    doc.moveDown(2);

    doc.fontSize(12).text(
      `Prepared for:\n${data.hostname || data.url}`,
      { align: "center" }
    );

    doc.moveDown(1);

    doc.fontSize(11).text(
      `Website scanned:\n${data.url}`,
      { align: "center" }
    );

    doc.moveDown(1);

    doc.fontSize(11).text(
      `Scan date: ${new Date(data.scannedAt).toLocaleString()}\nScan ID: ${
        data.scanId
      }`,
      { align: "center" }
    );

    doc.moveDown(2);

    doc.fontSize(10).text(
      "Purpose: internal review, agency audit, or client-facing documentation.",
      { align: "center" }
    );

    doc.moveDown(3);

    doc.fontSize(10).text(
      "This report is a factual, point-in-time snapshot of detectable signals only.\nIt does not provide legal advice or certify compliance.",
      { align: "center" }
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       EXECUTIVE SUMMARY
    ====================================================== */

    addWatermark(doc, "POINT-IN-TIME");

    doc.fontSize(18).text("Executive summary");
    doc.moveDown(1);

    doc.fontSize(12).text(
      "This report captures what was objectively detectable on the website at the time of scanning. It is designed to answer a single question:"
    );

    doc.moveDown(0.5);

    doc
      .fontSize(12)
      .text("“What does this website visibly expose right now?”", {
        italics: true,
      });

    doc.moveDown(1);

    doc.fontSize(12).text(
      "The scan focuses on high-signal indicators related to privacy transparency, cookies and tracking, form data collection, accessibility basics, and contact visibility."
    );

    drawBox(doc, "Scan coverage", [
      "Homepage only",
      "Limited set of common policy page paths",
      "No full crawl performed",
      "No authenticated or gated content",
    ]);

    if (data.riskReasons?.length) {
      doc.fontSize(13).text("Key risk indicators detected:");
      doc.moveDown(0.5);
      doc.fontSize(11).list(data.riskReasons, { bulletRadius: 2 });
    }

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       FINDINGS
    ====================================================== */

    addWatermark(doc, "DETECTABLE SIGNALS");

    doc.fontSize(18).text("Detectable findings");
    doc.moveDown(1);

    const rows = [
      ["HTTPS enabled", yesNo(data.https)],
      ["Privacy policy detected", yesNo(data.hasPrivacyPolicy)],
      ["Terms page detected", yesNo(data.hasTerms)],
      ["Cookie banner detected", yesNo(data.hasCookieBanner)],
      ["Cookie policy detected", yesNo(data.hasCookiePolicy)],
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
        "Possible personal-data fields (heuristic)",
        String(data.formsPersonalDataSignals || 0),
      ],
      [
        "Images missing alt text",
        `${data.imagesMissingAlt} of ${data.totalImages}`,
      ],
      ["Contact or business info present", yesNo(data.contactInfoPresent)],
    ];

    let y = doc.y + 10;
    rows.forEach(([label, value]) => {
      doc.fontSize(11).text(label, 50, y, { width: 260 });
      doc.fontSize(11).text(value, 330, y, { width: 210 });
      y += 22;
    });

    if (data.accessibilityNotes?.length) {
      doc.moveDown(2);
      doc.fontSize(14).text("Accessibility notes");
      doc.moveDown(0.5);
      doc.fontSize(11).list(data.accessibilityNotes, { bulletRadius: 2 });
    }

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       NEXT STEPS
    ====================================================== */

    addWatermark(doc, "NEXT STEPS");

    doc.fontSize(18).text("Common next steps");
    doc.moveDown(1);

    doc.fontSize(12).list(
      [
        "Review whether a clear privacy policy is appropriate for this website.",
        "Confirm whether cookie consent is required if tracking tools are in use.",
        "Ensure forms clearly explain how submitted data is handled.",
        "Address basic accessibility issues where relevant.",
        "Seek professional advice if compliance is business-critical.",
      ],
      { bulletRadius: 2 }
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       SHARE / VERIFICATION
    ====================================================== */

    addWatermark(doc, "VERIFICATION");

    doc.fontSize(18).text("Report verification");
    doc.moveDown(1);

    doc.fontSize(12).text(
      "This report can be re-downloaded or shared using the permanent link below."
    );

    doc.moveDown(1);

    const qrDataUrl = await QRCode.toDataURL(shareUrl);
    doc.image(qrDataUrl, 50, doc.y, { width: 120 });

    doc.fontSize(10).text(shareUrl, 180, doc.y + 40, {
      width: doc.page.width - 230,
    });

    doc.moveDown(4);

    doc.fontSize(10).text(
      "Anyone with this link can access the report. No login required.",
      { align: "center" }
    );

    addFooter(doc, data);

    doc.end();

    stream.on("finish", () => resolve(outputPath));
    stream.on("error", reject);
  });
}
