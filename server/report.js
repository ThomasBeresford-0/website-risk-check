// server/report.js
// FULL RAMBO — audit-grade, verifiable, point-in-time, immutable PDF (structured model)
// BOUTIQUE UPGRADE: consultancy cover + risk register table styling (matches provided references)
// ✅ Uses deterministic structured findings[] (from scan.js) when present
// ✅ Falls back to legacy deterministic register builder if findings[] missing
// ⚠️ Integrity hashing inputs are preserved (NO layout entropy)

import PDFDocument from "pdfkit";
import fs from "fs";
import QRCode from "qrcode";

import { computeRisk } from "./risk.js";
import { computeIntegrityHash } from "./integrity.js";

/* =========================
   PALETTE (from your reference images)
========================= */
const PALETTE = {
  // Cover template vibe
  paper: "#E4EAE7", // light warm grey-green
  tealDark: "#006B61", // deep teal
  tealMid: "#467E6F", // mid teal
  greenLight: "#99CF8D", // light green
  ink: "#111827", // slate-900
  muted: "#6B7280", // gray-500
  body: "#374151", // gray-700
  line: "#D7DEE2", // soft line

  // Risk table vibe
  navy: "#021942", // dark navy header
  navy2: "#0A2A63",
  grid: "#2B57C6", // blue-ish grid line like screenshot
  rowA: "#F3F4F6", // light row
  rowB: "#EEF2F7", // alternate row
  scoreGreen: "#BFD83A", // greenish score fill
  scoreYellow: "#F6BE34", // amber score fill
  scoreOrange: "#F39C12", // orange
  scoreRed: "#E74C3C", // red
};

/* =========================
   HELPERS
========================= */

function iso(ts) {
  try {
    return new Date(ts).toISOString();
  } catch {
    return new Date().toISOString();
  }
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

function clampText(s, max = 220) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toneForRisk(level) {
  if (level === "High") return "red";
  if (level === "Medium") return "amber";
  return "green";
}

function getMeta(data) {
  if (data && typeof data === "object" && data.meta) return data.meta;

  return {
    url: data?.url,
    hostname: data?.hostname,
    scanId: data?.scanId,
    scannedAt: data?.scannedAt,
    https: data?.https,
  };
}

function getCoverage(data) {
  if (data && typeof data === "object" && data.coverage) return data.coverage;

  return {
    checkedPages: safeArr(data?.checkedPages),
    failedPages: safeArr(data?.failedPages),
    notes: safeArr(data?.scanCoverageNotes),
    fetchOk:
      data?.fetchOk === false
        ? false
        : data?.fetchOk === true
          ? true
          : safeArr(data?.checkedPages).length > 0,
    fetchStatus: num(data?.fetchStatus, 0),
  };
}

function getSignals(data) {
  if (data && typeof data === "object" && data.signals) return data.signals;

  // Legacy flatten → structured-ish
  return {
    policies: {
      privacy: !!data?.hasPrivacyPolicy,
      terms: !!data?.hasTerms,
      cookies: !!data?.hasCookiePolicy,
    },
    consent: {
      bannerDetected: !!data?.hasCookieBanner,
      vendors: safeArr(data?.cookieVendorsDetected),
    },
    trackingScripts: safeArr(data?.trackingScriptsDetected),
    forms: {
      detected: num(data?.formsDetected),
      personalDataSignals: num(data?.formsPersonalDataSignals),
    },
    accessibility: {
      notes: safeArr(data?.accessibilityNotes),
      images: {
        total: num(data?.totalImages),
        missingAlt: num(data?.imagesMissingAlt),
      },
    },
    contact: {
      detected: !!data?.contactInfoPresent,
    },
  };
}

/**
 * Integrity hash must be derived from objective, deterministic fields only.
 * We feed a normalized model to integrity.js so hash is stable regardless of storage shape.
 * ⚠️ DO NOT include layout, wording, or cosmetic fields here.
 */
function buildIntegrityInput(data) {
  const meta = getMeta(data);
  const coverage = getCoverage(data);
  const signals = getSignals(data);

  return {
    meta: {
      url: meta?.url || "",
      hostname: meta?.hostname || "",
      scanId: meta?.scanId || "",
      scannedAt: String(meta?.scannedAt || ""),
      https: !!meta?.https,
    },
    coverage: {
      checkedPages: safeArr(coverage?.checkedPages).map((p) => ({
        url: p?.url || "",
        status: num(p?.status, 0),
      })),
      failedPages: safeArr(coverage?.failedPages).map((p) => ({
        url: p?.url || "",
        status: num(p?.status, 0),
      })),
      notes: safeArr(coverage?.notes).map((s) => String(s)),
    },
    signals: {
      policies: {
        privacy: !!signals?.policies?.privacy,
        terms: !!signals?.policies?.terms,
        cookies: !!signals?.policies?.cookies,
      },
      consent: {
        bannerDetected: !!signals?.consent?.bannerDetected,
        vendors: safeArr(signals?.consent?.vendors).map((s) => String(s)),
      },
      trackingScripts: safeArr(signals?.trackingScripts).map((s) => String(s)),
      forms: {
        detected: num(signals?.forms?.detected, 0),
        personalDataSignals: num(signals?.forms?.personalDataSignals, 0),
      },
      accessibility: {
        notes: safeArr(signals?.accessibility?.notes).map((s) => String(s)),
        images: {
          total: num(signals?.accessibility?.images?.total, 0),
          missingAlt: num(signals?.accessibility?.images?.missingAlt, 0),
        },
      },
      contact: {
        detected: !!signals?.contact?.detected,
      },
    },
  };
}

/* =========================
   TYPOGRAPHY / LAYOUT PRIMITIVES
========================= */

function hr(doc, pad = 10) {
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  const y = doc.y;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
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
  ensureSpace(doc, 140);
  doc.font("Helvetica-Bold").fontSize(18).fillColor(PALETTE.ink).text(title);
  doc.moveDown(0.7);
}

function subTitle(doc, title) {
  ensureSpace(doc, 100);
  doc.font("Helvetica-Bold").fontSize(12.5).fillColor(PALETTE.ink).text(title);
  doc.moveDown(0.45);
}

function bodyText(doc, text) {
  doc
    .font("Helvetica")
    .fontSize(10.8)
    .fillColor(PALETTE.body)
    .text(text, { lineGap: 4 });
}

function bulletList(doc, items) {
  const safe = safeArr(items).filter(Boolean);
  if (!safe.length) return;
  doc.font("Helvetica").fontSize(10.8).fillColor(PALETTE.body);
  doc.list(safe, { bulletRadius: 2, lineGap: 4 });
}

/* =========================
   HEADER / FOOTER (STRONGER FRAMING)
========================= */

function addHeader(doc, data) {
  const meta = getMeta(data);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
  doc.moveTo(left, 52).lineTo(right, 52).stroke();
  doc.restore();

  doc.save();
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(PALETTE.ink)
    .text("Website Risk Snapshot", left, 30, { width, align: "left" });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(PALETTE.muted)
    .text(`${meta.hostname || meta.url || ""}`, left, 30, {
      width,
      align: "right",
    });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#9CA3AF")
    .text(`Page ${doc._wrcPageNo || 1}`, left, 42, { width, align: "right" });

  doc.restore();

  // lock content start below header band
  if (doc.y < 72) doc.y = 78;
}

function addFooter(doc, meta, integrityHash) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottomY = doc.page.height - 40;

  const base = process.env.BASE_URL || "";
  const verifyUrl = `${base}/verify/${integrityHash}`;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
  doc.moveTo(left, bottomY - 10).lineTo(right, bottomY - 10).stroke();
  doc.restore();

  doc.save();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(PALETTE.muted)
    .text(
      `WebsiteRiskCheck.com • Report ID: ${meta.scanId} • Timestamp (UTC): ${iso(
        meta.scannedAt
      )}`,
      left,
      bottomY,
      { width, align: "center" }
    )
    .text(`Verify: ${verifyUrl}`, left, bottomY + 10, { width, align: "center" });

  doc.restore();
}

/* =========================
   COVER (CONSULTING TEMPLATE STYLE)
========================= */

function drawCoverBackground(doc) {
  const w = doc.page.width;
  const h = doc.page.height;

  doc.save();
  doc.rect(0, 0, w, h).fill(PALETTE.paper);

  doc
    .moveTo(0, 0)
    .lineTo(w * 0.38, 0)
    .lineTo(0, h * 0.18)
    .closePath()
    .fill(PALETTE.tealMid);

  doc
    .moveTo(w * 0.30, h)
    .lineTo(w, h * 0.62)
    .lineTo(w, h)
    .closePath()
    .fill(PALETTE.tealDark);

  doc
    .moveTo(w * 0.38, h)
    .lineTo(w, h * 0.70)
    .lineTo(w, h * 0.77)
    .lineTo(w * 0.50, h)
    .closePath()
    .fill(PALETTE.greenLight);

  doc
    .moveTo(w * 0.44, h)
    .lineTo(w, h * 0.74)
    .lineTo(w, h * 0.76)
    .lineTo(w * 0.48, h)
    .closePath()
    .fill("#FFFFFF");

  doc.restore();
}

function drawCover(doc, meta, risk, integrityHash) {
  drawCoverBackground(doc);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(PALETTE.tealDark)
    .text("WebsiteRiskCheck.com", left, 86, { width, align: "left" });

  doc
    .font("Helvetica-Bold")
    .fontSize(34)
    .fillColor(PALETTE.tealMid)
    .text("Website Risk\nSnapshot", left, 300, {
      width,
      align: "center",
      lineGap: 2,
    });

  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor(PALETTE.body)
    .text("Point-in-time observable signal assessment", left, 405, {
      width,
      align: "center",
    });

  const tone = toneForRisk(risk.level);
  badge(doc, `Risk level: ${risk.level}`, tone, left + width / 2 - 90, 470);

  const boxY = 560;
  const boxW = Math.min(520, width);
  const boxX = left + (width - boxW) / 2;

  doc.save();
  doc.roundedRect(boxX, boxY, boxW, 140, 14).fill("#FFFFFF").stroke(PALETTE.line);
  doc.restore();

  const labelW = 140;
  const valX = boxX + labelW;

  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(PALETTE.ink)
    .text("Website", boxX + 18, boxY + 18, { width: labelW });

  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor(PALETTE.body)
    .text(meta.hostname || meta.url || "", valX, boxY + 18, {
      width: boxW - labelW - 18,
    });

  doc
    .font("Helvetica-Bold")
    .fillColor(PALETTE.ink)
    .text("Timestamp (UTC)", boxX + 18, boxY + 48, { width: labelW });

  doc
    .font("Helvetica")
    .fillColor(PALETTE.body)
    .text(iso(meta.scannedAt), valX, boxY + 48, {
      width: boxW - labelW - 18,
    });

  doc
    .font("Helvetica-Bold")
    .fillColor(PALETTE.ink)
    .text("Report ID", boxX + 18, boxY + 78, { width: labelW });

  doc
    .font("Helvetica")
    .fillColor(PALETTE.body)
    .text(meta.scanId || "", valX, boxY + 78, {
      width: boxW - labelW - 18,
    });

  doc
    .font("Helvetica-Bold")
    .fillColor(PALETTE.ink)
    .text("Integrity hash", boxX + 18, boxY + 108, { width: labelW });

  doc
    .font("Helvetica")
    .fillColor(PALETTE.body)
    .text(`${integrityHash.slice(0, 28)}…`, valX, boxY + 108, {
      width: boxW - labelW - 18,
    });

  doc
    .font("Helvetica")
    .fontSize(9.8)
    .fillColor(PALETTE.muted)
    .text(
      "Observable signals only. Not legal advice. Not certification. Applies only at the recorded timestamp.",
      left,
      doc.page.height - 120,
      { width, align: "center", lineGap: 3 }
    );
}

/* =========================
   RISK REGISTER TABLE (LIKE YOUR SCREENSHOT)
   Columns: Category | Description | Probability | Impact | Score | Timing | Trigger | Response
========================= */

function scoreBand(score) {
  // score is 1–25 (prob*impact)
  if (score >= 16) return { fill: PALETTE.scoreRed, ink: "#111827" };
  if (score >= 13) return { fill: PALETTE.scoreOrange, ink: "#111827" };
  if (score >= 9) return { fill: PALETTE.scoreYellow, ink: "#111827" };
  if (score >= 5) return { fill: PALETTE.scoreGreen, ink: "#111827" };
  return { fill: "#D1FAE5", ink: "#065F46" };
}

function drawRiskRegister_v2(doc, rows) {
  ensureSpace(doc, 260);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableW = right - left;

  const headerH = 34;
  const rowH = 120;

  const cols = [
    { key: "category", w: 110, label: "Risk\nCategory" },
    { key: "desc", w: 170, label: "Risk\nDescription" },
    { key: "prob", w: 105, label: "Probability" },
    { key: "impact", w: 95, label: "Impact" },
    { key: "score", w: 95, label: "Risk Impact\nScore" },
    { key: "timing", w: 150, label: "Timing of\nRisk" },
    { key: "trigger", w: 150, label: "Risk\nTrigger" },
    {
      key: "response",
      w: tableW - (110 + 170 + 105 + 95 + 95 + 150 + 150),
      label: "Mitigation\nResponse",
    },
  ];

  const startY = doc.y;

  // Header background
  doc.save();
  doc.rect(left, startY, tableW, headerH).fill(PALETTE.navy);
  doc.restore();

  // Header border
  doc.save();
  doc.strokeColor(PALETTE.grid).lineWidth(1.2);
  doc.rect(left, startY, tableW, headerH).stroke();
  doc.restore();

  // Header text
  let x = left;
  doc.save();
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(10);
  cols.forEach((c) => {
    doc.text(c.label, x + 8, startY + 7, { width: c.w - 16, align: "left" });
    x += c.w;
  });
  doc.restore();

  // Header vertical lines
  x = left;
  cols.forEach((c) => {
    doc.save();
    doc.strokeColor(PALETTE.grid).lineWidth(1.2);
    doc.moveTo(x, startY).lineTo(x, startY + headerH).stroke();
    doc.restore();
    x += c.w;
  });
  doc.save();
  doc.strokeColor(PALETTE.grid).lineWidth(1.2);
  doc
    .moveTo(left + tableW, startY)
    .lineTo(left + tableW, startY + headerH)
    .stroke();
  doc.restore();

  // Rows
  let y = startY + headerH;

  rows.forEach((r, idx) => {
    ensureSpace(doc, rowH + 40);

    const bg = idx % 2 === 0 ? PALETTE.rowA : PALETTE.rowB;

    doc.save();
    doc.rect(left, y, tableW, rowH).fill(bg);
    doc.restore();

    // score cell highlight block
    const scoreIndex = cols.findIndex((c) => c.key === "score");
    const scoreX = left + cols.slice(0, scoreIndex).reduce((a, c) => a + c.w, 0);
    const scoreW = cols[scoreIndex].w;

    const scoreBandStyle = scoreBand(num(r.scoreNum, 0));
    doc.save();
    doc.rect(scoreX, y, scoreW, rowH).fill(scoreBandStyle.fill);
    doc.restore();

    // grid border
    doc.save();
    doc.strokeColor(PALETTE.grid).lineWidth(1.0);
    doc.rect(left, y, tableW, rowH).stroke();
    doc.restore();

    // vertical lines
    let vx = left;
    cols.forEach((c) => {
      doc.save();
      doc.strokeColor(PALETTE.grid).lineWidth(1.0);
      doc.moveTo(vx, y).lineTo(vx, y + rowH).stroke();
      doc.restore();
      vx += c.w;
    });
    doc.save();
    doc.strokeColor(PALETTE.grid).lineWidth(1.0);
    doc.moveTo(left + tableW, y).lineTo(left + tableW, y + rowH).stroke();
    doc.restore();

    // cell text
    let cx = left;
    doc.save();
    cols.forEach((c) => {
      const pad = 10;
      const tx = cx + pad;
      const ty = y + 12;
      const tw = c.w - pad * 2;

      if (c.key === "category") {
        doc.font("Helvetica").fontSize(10.5).fillColor(PALETTE.ink);
        doc.text(clampText(r.category, 60), tx, ty, { width: tw });
      } else if (c.key === "prob" || c.key === "impact") {
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor(PALETTE.ink);
        doc.text(clampText(r[c.key], 40), tx, ty + 18, {
          width: tw,
          align: "center",
        });
      } else if (c.key === "score") {
        doc.font("Helvetica-Bold").fontSize(14).fillColor("#111827");
        doc.text(String(r.scoreNum), tx, ty + 32, { width: tw, align: "center" });
      } else {
        doc.font("Helvetica").fontSize(10.2).fillColor(PALETTE.ink);
        doc.text(clampText(r[c.key], 260), tx, ty, { width: tw, lineGap: 3 });
      }

      cx += c.w;
    });
    doc.restore();

    y += rowH;
  });

  doc.y = y + 14;
}

/* =========================
   EXEC / RISK MODEL TEXT
========================= */

function whatThisMeansFor(level) {
  if (level === "High") {
    return "This snapshot shows multiple risk-relevant signals and/or missing indicators that commonly correlate with higher exposure on customer-facing websites. It does not prove non-compliance, but it suggests a review of policies, consent mechanisms, and data-capture touchpoints may be warranted.";
  }
  if (level === "Medium") {
    return "This snapshot shows some risk-relevant signals and/or missing indicators that are commonly expected on customer-facing websites. It does not prove non-compliance, but it suggests potential gaps worth reviewing.";
  }
  return "This snapshot shows relatively few risk-relevant signals based on what was detectable at the time of scanning. It does not guarantee compliance, but fewer obvious gaps were detected on the scanned surface.";
}

/**
 * Preferred: map structured findings[] (from scan.js) into table rows.
 * findings[] are deterministic and evidence-backed; this does not affect integrity hashing.
 */
function rowsFromFindings(findings) {
  const safe = safeArr(findings);
  if (!safe.length) return [];

  return safe.map((f) => {
    const pVal = num(f?.probability?.value, 1);
    const iVal = num(f?.impact?.value, 1);
    const scoreNum = num(f?.score, pVal * iVal);

    const pLabel = f?.probability?.label || "Possible";
    const iLabel = f?.impact?.label || "Moderate";

    return {
      category: clampText(f?.category || "General", 60),
      desc: clampText(f?.description || "", 260),
      prob: clampText(`${pLabel} (${pVal})`, 40),
      impact: clampText(`${iLabel} (${iVal})`, 40),
      scoreNum,
      timing: clampText(f?.timing || "At scan time and during public access.", 260),
      trigger: clampText(f?.trigger || "Detected signals indicate a potential exposure.", 260),
      response: clampText(f?.mitigation || "Review and remediate as appropriate.", 260),
    };
  });
}

/**
 * Fallback: legacy deterministic register (kept so the PDF still works if findings[] missing)
 */
function buildRiskRegister(meta, coverage, signals) {
  const trackers = safeArr(signals?.trackingScripts);
  const vendors = safeArr(signals?.consent?.vendors);

  const totalImages = num(signals?.accessibility?.images?.total);
  const missingAlt = num(signals?.accessibility?.images?.missingAlt);

  const rows = [];

  {
    const missing =
      (!signals?.policies?.privacy ? 1 : 0) +
      (!signals?.policies?.terms ? 1 : 0) +
      (!signals?.policies?.cookies ? 1 : 0);

    const prob = missing === 0 ? 1 : missing === 1 ? 3 : 4;
    const impact = missing >= 2 ? 4 : 3;
    const score = prob * impact;

    rows.push({
      category: "Compliance",
      desc:
        "If required policy pages are missing or not discoverable, the organisation may face increased exposure and customer trust risk.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 4 ? "Major (4)" : "Moderate (3)",
      scoreNum: score,
      timing: "Risk is present throughout the public lifecycle of the site.",
      trigger: "Policies are missing, not linked, or inaccessible on standard public paths.",
      response:
        "Publish and link policy pages from the footer/homepage. Ensure versions are current and match actual data practices.",
    });
  }

  {
    const hasTracking = trackers.length > 0 || vendors.length > 0;
    const prob = hasTracking ? 4 : 2;
    const impact = hasTracking ? 4 : 2;
    const score = prob * impact;

    rows.push({
      category: "Tracking",
      desc:
        "If tracking or cookie vendors are present without appropriate consent controls, regulatory and reputational exposure may increase.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (2)",
      impact: impact >= 4 ? "Major (4)" : "Minor (2)",
      scoreNum: score,
      timing: "Risk is present throughout marketing and tag deployments.",
      trigger: "Third-party scripts or consent vendor markers are detected on scanned pages.",
      response:
        "Review tag inventory. Validate consent flow for target regions. Ensure vendor disclosure matches deployed scripts.",
    });
  }

  {
    const forms = num(signals?.forms?.detected);
    const personalSignals = num(signals?.forms?.personalDataSignals);
    const prob = forms > 0 ? (personalSignals > 0 ? 4 : 3) : 1;
    const impact = forms > 0 ? 4 : 1;
    const score = prob * impact;

    rows.push({
      category: "Data Capture",
      desc:
        "If forms collect personal data, inadequate transparency, retention, or access controls can increase operational and compliance risk.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 4 ? "Major (4)" : "Minor (1)",
      scoreNum: score,
      timing: "Risk is present whenever forms are live and receiving submissions.",
      trigger: "Forms are detected and personal-data field signals are observed (heuristic).",
      response:
        "Audit form fields for minimum necessary data. Confirm storage, access controls, and retention. Align privacy disclosures.",
    });
  }

  {
    const ratio = totalImages > 0 ? missingAlt / totalImages : 0;
    const prob = ratio > 0.3 ? 4 : ratio > 0 ? 3 : 1;
    const impact = ratio > 0.3 ? 3 : ratio > 0 ? 2 : 1;
    const score = prob * impact;

    rows.push({
      category: "Accessibility",
      desc:
        "Missing alt text on meaningful images may reduce accessibility and increase risk for public-facing pages, depending on jurisdiction and audience.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 3 ? "Moderate (3)" : impact === 2 ? "Minor (2)" : "Low (1)",
      scoreNum: score,
      timing: "Risk is present on affected pages where images lack descriptions.",
      trigger: "Alt text is missing for a portion of detected images (heuristic).",
      response:
        "Add alt text to meaningful images on key pages. Prioritise conversion and policy pages first.",
    });
  }

  {
    const prob = signals?.contact?.detected ? 1 : 3;
    const impact = signals?.contact?.detected ? 1 : 2;
    const score = prob * impact;

    rows.push({
      category: "Trust",
      desc:
        "If visitors cannot easily find contact or business identity details, trust and conversion may be negatively affected.",
      prob: prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 2 ? "Minor (2)" : "Low (1)",
      scoreNum: score,
      timing: "Risk is present on landing and checkout journeys.",
      trigger: "Contact/identity markers are not detected on scanned surface (heuristic).",
      response:
        "Ensure a visible Contact page and footer details (email/phone/address where applicable).",
    });
  }

  return rows;
}

/* =========================
   REPORT GENERATION
========================= */

export async function generateReport(data, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const base = process.env.BASE_URL || "";
      const meta = getMeta(data);
      const coverage = getCoverage(data);
      const signals = getSignals(data);

      // Compute integrity hash from normalized objective model
      const integrityInput = buildIntegrityInput(data);
      const integrityHash = computeIntegrityHash(integrityInput);

      // Compute risk from the scan data (supports both shapes)
      const risk = computeRisk(data);

      // Attach in BOTH places for downstream compatibility
      data.integrityHash = integrityHash;
      data.riskLevel = risk.level;
      data.riskScore = risk.score;
      data.riskReasons = safeArr(risk.reasons);

      if (data.meta) {
        data.meta.integrityHash = integrityHash;
      }

      const verifyUrl = `${base}/verify/${integrityHash}`;

      // Precompute shared signal views (avoid scope bugs across pages)
      const trackers = safeArr(signals?.trackingScripts);
      const vendors = safeArr(signals?.consent?.vendors);
      const totalImages = num(signals?.accessibility?.images?.total);
      const imagesMissingAlt = num(signals?.accessibility?.images?.missingAlt);

      // Risk register rows: prefer findings[] if present
      const findings = safeArr(data?.findings || data?.meta?.findings);
      const rowsFromStructured = rowsFromFindings(findings);
      const riskRows =
        rowsFromStructured.length > 0
          ? rowsFromStructured
          : buildRiskRegister(meta, coverage, signals);

      const doc = new PDFDocument({
        margin: 54,
        size: "A4",
        info: {
          Title: "Website Risk Snapshot",
          Author: "WebsiteRiskCheck.com",
          Subject: "Point-in-time website snapshot report (observable signals only).",
        },
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // page number tracking
      doc._wrcPageNo = 1;

      // Safety hook if doc.addPage() happens inside helpers
      doc.on("pageAdded", () => {
        // If we are beyond cover, render header
        if ((doc._wrcPageNo || 1) >= 2) addHeader(doc, data);
      });

      /* ======================================================
         PAGE 1 — COVER (consulting template style)
      ====================================================== */

      drawCover(doc, meta, risk, integrityHash);
      addFooter(doc, meta, integrityHash);

      doc._wrcPageNo += 1;
      doc.addPage();

      /* ======================================================
         PAGE 2 — EXECUTIVE SUMMARY + RISK REGISTER TABLE
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Executive summary");

      const tone = toneForRisk(risk.level);
      badge(doc, `Risk level: ${risk.level}`, tone, doc.page.margins.left, doc.y);
      doc.moveDown(1.2);

      bodyText(doc, whatThisMeansFor(risk.level));
      hr(doc);

      subTitle(doc, "Risk register");
      bodyText(
        doc,
        "A structured view of key detectable risks based on scope-locked signals. Probability/impact are indicative only and not legal conclusions."
      );
      doc.moveDown(0.6);

      drawRiskRegister_v2(doc, riskRows);

      // Small note (keeps it consultancy-grade, not verbose)
      doc
        .font("Helvetica")
        .fontSize(9.2)
        .fillColor(PALETTE.muted)
        .text(
          "Note: Scores reflect probability×impact for the register entries above and are independent of the overall risk score.",
          doc.page.margins.left,
          doc.y,
          {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            lineGap: 2,
          }
        );

      hr(doc);

      subTitle(doc, "Key findings (detectable signals)");

      const keyFindings = [];

      keyFindings.push(`HTTPS: ${meta.https ? "Detected" : "Not detected"}`);
      keyFindings.push(
        `Fetch: ${
          safeArr(coverage?.checkedPages).length ? "Successful" : "Limited/failed"
        }`
      );

      keyFindings.push(
        `Privacy policy: ${signals?.policies?.privacy ? "Detected" : "Not detected"}`
      );
      keyFindings.push(
        `Terms: ${signals?.policies?.terms ? "Detected" : "Not detected"}`
      );
      keyFindings.push(
        `Cookie policy: ${signals?.policies?.cookies ? "Detected" : "Not detected"}`
      );
      keyFindings.push(
        `Consent banner indicator: ${
          signals?.consent?.bannerDetected ? "Detected" : "Not detected"
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

      keyFindings.push(`Forms detected: ${num(signals?.forms?.detected)}`);
      keyFindings.push(
        `Potential personal-data field signals: ${num(
          signals?.forms?.personalDataSignals
        )} (heuristic)`
      );
      keyFindings.push(`Images missing alt text: ${imagesMissingAlt} of ${totalImages}`);
      keyFindings.push(
        `Contact/identity signals: ${
          signals?.contact?.detected ? "Detected" : "Not detected"
        }`
      );

      bulletList(doc, keyFindings.slice(0, 12));

      doc.moveDown(0.8);
      subTitle(doc, "Notable observations");
      bulletList(doc, safeArr(risk.reasons).slice(0, 10));

      addFooter(doc, meta, integrityHash);

      doc._wrcPageNo += 1;
      doc.addPage();

      /* ======================================================
         PAGE 3 — FINDINGS BY CATEGORY
      ====================================================== */

      addHeader(doc, data);
      sectionTitle(doc, "Findings by category");

      subTitle(doc, "Connection");
      bulletList(doc, [`HTTPS: ${meta.https ? "Detected" : "Not detected"}`]);
      bodyText(
        doc,
        "HTTPS reduces interception risk and is commonly expected for customer-facing websites."
      );
      hr(doc);

      subTitle(doc, "Policies (public-path detection)");
      bulletList(doc, [
        `Privacy policy present: ${yesNo(!!signals?.policies?.privacy)}`,
        `Terms present: ${yesNo(!!signals?.policies?.terms)}`,
        `Cookie policy present: ${yesNo(!!signals?.policies?.cookies)}`,
      ]);
      bodyText(
        doc,
        "Policy presence is detected using a scope-locked approach (homepage links and standard public policy paths). Absence of detection is not proof of absence."
      );
      hr(doc);

      subTitle(doc, "Cookies & tracking (HTML detection)");
      bulletList(doc, [
        `Tracking scripts: ${trackers.length ? trackers.join(", ") : "None detected"}`,
        `Cookie vendor signals: ${vendors.length ? vendors.join(", ") : "None detected"}`,
      ]);
      bodyText(
        doc,
        "Detections are based on observable HTML/script references. If trackers load dynamically, they may not be detected."
      );
      hr(doc);

      subTitle(doc, "Consent indicators (heuristic)");
      bulletList(doc, [
        `Cookie/consent banner indicator: ${yesNo(!!signals?.consent?.bannerDetected)}`,
      ]);
      bodyText(
        doc,
        "This is a heuristic signal based on text and DOM patterns and/or the presence of consent vendors. It is not a guarantee."
      );
      hr(doc);

      subTitle(doc, "Forms & data capture (heuristic)");
      bulletList(doc, [
        `Forms detected: ${num(signals?.forms?.detected)}`,
        `Potential personal-data field signals: ${num(
          signals?.forms?.personalDataSignals
        )}`,
      ]);
      bodyText(
        doc,
        "The personal-data signal is a heuristic count based on common field names (e.g., email, phone, name). It is not a legal classification."
      );
      hr(doc);

      subTitle(doc, "Accessibility signals (heuristic)");
      bulletList(doc, [
        `Images missing alt text: ${imagesMissingAlt} of ${totalImages}`,
        ...(safeArr(signals?.accessibility?.notes).length
          ? safeArr(signals?.accessibility?.notes).map((n) => `Note: ${n}`)
          : ["No accessibility notes recorded by this scan."]),
      ]);
      bodyText(
        doc,
        "Accessibility checks are lightweight and indicative only. A full accessibility review typically requires page coverage and manual testing."
      );
      hr(doc);

      subTitle(doc, "Contact & identity signals");
      bulletList(doc, [
        `Contact/business identity signals: ${yesNo(!!signals?.contact?.detected)}`,
      ]);
      bodyText(
        doc,
        "Detected using simple patterns (email/phone/contact link) on the scanned surface only."
      );
      hr(doc);

      addFooter(doc, meta, integrityHash);

      doc._wrcPageNo += 1;
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

      addFooter(doc, meta, integrityHash);

      doc._wrcPageNo += 1;
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

      addFooter(doc, meta, integrityHash);

      doc._wrcPageNo += 1;
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
        .fillColor(PALETTE.ink)
        .text(integrityHash, { lineGap: 2 });

      doc.moveDown(0.8);

      subTitle(doc, "Verify this report");
      doc
        .font("Helvetica")
        .fontSize(10.8)
        .fillColor(PALETTE.body)
        .text(verifyUrl);

      doc.moveDown(0.8);

      subTitle(doc, "What the integrity hash covers");
      bulletList(doc, [
        "Target URL/hostname, scan ID, scan timestamp",
        "Scope-locked coverage notes",
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

      const qx = doc.page.margins.left;
      const qy = doc.y;

      doc.save();
      doc.roundedRect(qx, qy, 170, 170, 14).fill("#FFFFFF").stroke(PALETTE.line);
      doc.restore();

      doc.image(qrDataUrl, qx + 20, qy + 20, { width: 130 });

      addFooter(doc, meta, integrityHash);

      doc.end();

      stream.on("finish", () => resolve({ outputPath, integrityHash }));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
