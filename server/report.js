// server/report.js

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

export function generateReport(data) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "../public/report.pdf");

    const doc = new PDFDocument({
      margin: 50,
      size: "A4",
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    /* ======================================================
       COVER PAGE
    ====================================================== */

    addWatermark(doc, "WEBSITE RISK CHECK");

    doc
      .fontSize(30)
      .text("Website Risk Check", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(14)
      .text("One-time website compliance snapshot", {
        align: "center",
      })
      .moveDown(2);

    doc
      .fontSize(22)
      .text(`Risk level: ${data.riskLevel}`, {
        align: "center",
      })
      .moveDown(2);

    doc
      .fontSize(12)
      .text(`Website scanned:\n${data.url}`, {
        align: "center",
      })
      .moveDown(1.5);

    doc
      .fontSize(11)
      .text(
        `Scan date: ${new Date(data.scannedAt).toLocaleString()}\nScan ID: ${
          data.scanId
        }`,
        { align: "center" }
      );

    doc
      .moveDown(3)
      .fontSize(10)
      .text(
        "This document is a factual, point-in-time snapshot based on detectable signals only.\nIt does not provide legal advice, certify compliance, or guarantee regulatory status.",
        { align: "center" }
      );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       EXECUTIVE SUMMARY
    ====================================================== */

    addWatermark(doc, "CONFIDENTIAL SNAPSHOT");

    doc.fontSize(18).text("Executive summary").moveDown(0.8);

    doc.fontSize(12).text(
      "This report provides a surface-level assessment of detectable compliance and risk-related signals present on the website listed above. It is designed to give clarity on the current observable state of the site."
    );

    doc.moveDown();

    doc.text(
      "The scan focuses on high-signal indicators such as privacy disclosures, cookie consent mechanisms, tracking technologies, accessibility basics, and transparency signals commonly expected on modern websites."
    );

    doc.moveDown();

    if (data.riskReasons && data.riskReasons.length) {
      doc
        .fontSize(13)
        .text("Key factors influencing the risk level:")
        .moveDown(0.5);

      doc.fontSize(12).list(data.riskReasons, { bulletRadius: 2 });
    } else {
      doc.fontSize(12).text(
        "The assigned risk level reflects the overall presence or absence of common high-signal indicators."
      );
    }

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       FINDINGS
    ====================================================== */

    addWatermark(doc, "DETECTABLE SIGNALS");

    doc.fontSize(18).text("Findings").moveDown(1);

    const rows = [
      ["HTTPS enabled", yesNo(data.https)],
      ["Privacy policy detected", yesNo(data.hasPrivacyPolicy)],
      ["Terms & conditions detected", yesNo(data.hasTerms)],
      ["Cookie banner detected", yesNo(data.hasCookieBanner)],
      ["Cookie policy page detected", yesNo(data.hasCookiePolicy)],
      [
        "Tracking scripts detected",
        data.trackingScriptsDetected.length
          ? data.trackingScriptsDetected.join(", ")
          : "None detected",
      ],
      [
        "Cookie vendor detected",
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
      ["Contact / business info present", yesNo(data.contactInfoPresent)],
    ];

    let y = doc.y + 10;

    rows.forEach(([label, value]) => {
      doc
        .fontSize(11)
        .text(label, 50, y, { width: 260 })
        .text(value, 330, y, { width: 210 });
      y += 22;
    });

    doc.moveDown(2);

    if (data.accessibilityNotes && data.accessibilityNotes.length) {
      doc.fontSize(14).text("Accessibility notes").moveDown(0.5);
      doc.fontSize(11).list(data.accessibilityNotes, { bulletRadius: 2 });
    }

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       WHAT THIS MEANS
    ====================================================== */

    addWatermark(doc, "INTERPRETATION");

    doc.fontSize(18).text("What this means").moveDown(0.8);

    doc.fontSize(12).text(
      "The findings above represent detectable signals at the time of scanning. Missing elements may indicate incomplete implementation, outdated practices, or areas that warrant further review."
    );

    doc.moveDown();

    doc.text(
      "The presence of analytics or tracking technologies without a visible consent mechanism, or the collection of personal data without a clearly accessible privacy policy, are common indicators of elevated risk."
    );

    doc.moveDown();

    doc.text(
      "This report does not imply wrongdoing. It is intended to support informed decision-making and provide a factual record that can be shared internally or with third parties."
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       COMMON NEXT STEPS
    ====================================================== */

    addWatermark(doc, "NEXT STEPS");

    doc.fontSize(18).text("Common next steps").moveDown(0.8);

    doc.fontSize(12).list(
      [
        "Ensure an accessible and up-to-date privacy policy is linked from the website.",
        "If tracking tools are used, confirm cookie consent is implemented appropriately.",
        "Review forms to ensure users are informed how personal data is handled.",
        "Address basic accessibility issues such as missing alt text or page language.",
        "Seek professional advice if regulatory compliance is business-critical.",
      ],
      { bulletRadius: 2 }
    );

    addFooter(doc, data);
    doc.addPage();

    /* ======================================================
       SCOPE & LIMITATIONS
    ====================================================== */

    addWatermark(doc, "LIMITATIONS");

    doc.fontSize(18).text("Scope & limitations").moveDown(0.8);

    doc.fontSize(12).list(
      [
        "The scan checks the homepage and a limited set of common policy page paths.",
        "It does not perform a full crawl of the website.",
        "Dynamic content or pages behind logins may not be detected.",
        "This report does not provide legal advice or compliance certification.",
        "Results reflect the website only at the specific time shown.",
      ],
      { bulletRadius: 2 }
    );

    doc.moveDown(2);

    doc
      .fontSize(10)
      .text(
        "Website Risk Check • Confidential diagnostic snapshot • No monitoring performed",
        { align: "center" }
      );

    addFooter(doc, data);

    doc.end();

    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}
