// server/scripts/make-sample-report.js
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { scanWebsite } from "../scan.js";
import { generateReport } from "../report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// project root (../.. from server/scripts)
const root = path.join(__dirname, "../..");
const outPdf = path.join(root, "public", "sample-report.pdf");

const url = process.argv[2] || "https://example.com";

(async () => {
  console.log("Generating sample report for:", url);

  const scanData = await scanWebsite(url);

  // This token is ONLY for labeling inside the PDF (not the paid share token)
  const token = "SAMPLE-001";

  const { integrityHash } = await generateReport(
    { ...scanData, shareToken: token },
    outPdf
  );

  const bytes = fs.statSync(outPdf).size;
  console.log("✅ Wrote:", outPdf, `(${bytes} bytes)`);
  console.log("✅ Integrity hash:", integrityHash);
})();
