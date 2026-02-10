// report.js
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function generateReport(data) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, "../public/report.pdf");

    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // Header
    doc
      .fontSize(22)
      .text("Website Risk Check", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(12)
      .text("One-time website compliance snapshot", { align: "center" })
      .moveDown(2);

    // Meta
    doc.fontSize(12);
    doc.text(`Website scanned: ${data.url}`);
    doc.text(`Scan date: ${new Date(data.scannedAt).toLocaleString()}`);
    doc.moveDown();

    // Summary
    doc.fontSize(16).text("Summary").moveDown(0.5);
    doc.fontSize(12);

    doc.text(`HTTPS enabled: ${data.https ? "Yes" : "No"}`);
    doc.text(`Privacy policy detected: ${data.hasPrivacyPolicy ? "Yes" : "No"}`);
    doc.text(`Terms & conditions detected: ${data.hasTerms ? "Yes" : "No"}`);
    doc.text(`Cookie banner detected: ${data.hasCookieBanner ? "Yes" : "No"}`);
    doc.text(`Forms collecting personal data: ${data.formsDetected}`);
    doc.text(`Images missing alt text: ${data.imagesMissingAlt}`);
    doc.text(
      `Tracking scripts detected: ${
        data.trackingScriptsDetected.length || "None detected"
      }`
    );

    doc.moveDown();

    // Explanation
    doc.fontSize(16).text("What this means").moveDown(0.5);
    doc.fontSize(12).text(
      "This report identifies detectable website features and potential risk indicators based on a surface-level scan. It does not provide legal advice, certify compliance, or guarantee regulatory status."
    );

    doc.moveDown();

    // Next steps
    doc.fontSize(16).text("Common next steps").moveDown(0.5);
    doc.fontSize(12);
    doc.list(
      [
        "Review whether your website displays clear privacy and cookie information",
        "Check whether forms clearly explain how personal data is used",
        "Ensure basic accessibility practices are followed",
        "Consult a qualified professional if compliance is critical",
      ],
      { bulletRadius: 2 }
    );

    doc.moveDown();

    // Footer
    doc
      .fontSize(10)
      .text(
        "Website Risk Check provides a point-in-time snapshot only. No monitoring is performed.",
        { align: "center" }
      );

    doc.end();

    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}
