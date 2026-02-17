// server/report.js
// FULL RAMBO — audit-grade, verifiable, point-in-time, immutable PDF (structured model)
// BOUTIQUE UPGRADE (v2.1): consultancy artifact layout (fixed Executive Summary page layout)
// ✅ Premium cover + executive summary cards + clean typography
// ✅ Executive summary now uses proper grid + two-column content (no awkward dead space)
// ✅ Risk register rendered on LANDSCAPE page(s) with repeated header row
// ✅ Verification page with QR + integrity explanation
// ✅ Uses deterministic structured findings[] when present; deterministic legacy fallback otherwise
// ✅ Fixes: NO table overflow, NO footer poisoning doc.y
// ⚠️ Integrity hashing inputs preserved (NO layout entropy in hash inputs)

import PDFDocument from "pdfkit";
import fs from "fs";
import QRCode from "qrcode";

import { computeRisk } from "./risk.js";
import { computeIntegrityHash } from "./integrity.js";

/* =========================
   PALETTE (refined)
========================= */
const PALETTE = {
  paper: "#E4EAE7",
  tealDark: "#006B61",
  tealMid: "#467E6F",
  greenLight: "#99CF8D",
  ink: "#0B1220",
  muted: "#5B6B82",
  body: "#1F2937",
  line: "#D7DEE2",
  soft: "#F7FAFC",

  navy: "#021942",
  grid: "#2B57C6",
  rowA: "#F3F4F6",
  rowB: "#EEF2F7",

  scoreGreen: "#BFD83A",
  scoreYellow: "#F6BE34",
  scoreOrange: "#F39C12",
  scoreRed: "#E74C3C",
};

/* =========================
   LAYOUT CONSTANTS
========================= */
// Header is drawn around y=30..52; content must ALWAYS start below it.
const CONTENT_TOP_Y = 78;
// Footer is drawn near bottom; do not allow it to affect content flow.
const FOOTER_SAFE_PAD = 58;

/* =========================
   HELPERS
========================= */

function iso(ts) {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString();
  } catch {
    return "";
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

function clampText(s, max = 220) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toneForRisk(level) {
  if (level === "High") return "red";
  if (level === "Medium") return "amber";
  return "green";
}

function widthBetweenMargins(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function xLeft(doc) {
  return doc.page.margins.left;
}

function xRight(doc) {
  return doc.page.width - doc.page.margins.right;
}

/**
 * Always keep doc.y in a sane place after page creation.
 * IMPORTANT: This is what fixes mid-page starts & "ghost pages".
 */
function normalizeBodyCursor(doc) {
  if (doc.y < CONTENT_TOP_Y) doc.y = CONTENT_TOP_Y;
  if (doc.x !== doc.page.margins.left) doc.x = doc.page.margins.left;
}

/**
 * Ensure there is enough vertical space for the next block.
 * Adds a page and normalizes cursor.
 */
function ensureSpace(doc, minSpace = 120) {
  const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_SAFE_PAD;
  if (doc.y + minSpace > bottom) {
    doc.addPage();
    normalizeBodyCursor(doc);
  }
}

/* =========================
   SHAPE NORMALIZERS (for hash + consistent rendering)
========================= */

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
 * Integrity hash input MUST be objective + deterministic only.
 * ⚠️ Do not include layout, wording, or any cosmetic fields here.
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
   TYPOGRAPHY / COMPONENTS
========================= */

function hr(doc, pad = 10) {
  const left = xLeft(doc);
  const right = xRight(doc);
  const y = doc.y + pad;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.restore();

  doc.y = y + 10;
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
    .roundedRect(x, y, w, h, 999)
    .fillColor(t.bg)
    .fill()
    .lineWidth(1)
    .strokeColor(t.br)
    .stroke();

  doc.fillColor(t.fg).text(text, x + padX, y + padY - 1);
  doc.restore();

  return { w, h };
}

function sectionTitle(doc, title, subtitle = "") {
  ensureSpace(doc, 180);

  doc.font("Helvetica-Bold").fontSize(20).fillColor(PALETTE.ink).text(title);
  if (subtitle) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(PALETTE.muted)
      .text(subtitle, { lineGap: 2 });
  }
  doc.moveDown(0.7);
}

function subTitle(doc, title) {
  ensureSpace(doc, 120);
  doc.font("Helvetica-Bold").fontSize(12.5).fillColor(PALETTE.ink).text(title);
  doc.moveDown(0.35);
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

function card(doc, x, y, w, h, { title, value, foot } = {}) {
  doc.save();
  doc.roundedRect(x, y, w, h, 14).fillColor("#FFFFFF").fill();
  doc
    .strokeColor(PALETTE.line)
    .lineWidth(1)
    .roundedRect(x, y, w, h, 14)
    .stroke();
  doc.restore();

  const pad = 14;

  if (title) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9.8)
      .fillColor(PALETTE.muted)
      .text(title, x + pad, y + pad, { width: w - pad * 2 });
  }

  if (value) {
    doc
      .font("Helvetica-Bold")
      .fontSize(13.5)
      .fillColor(PALETTE.ink)
      .text(value, x + pad, y + pad + 16, { width: w - pad * 2 });
  }

  if (foot) {
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(PALETTE.muted)
      .text(foot, x + pad, y + h - pad - 10, { width: w - pad * 2 });
  }
}

function panel(doc, x, y, w, h, { title } = {}) {
  doc.save();
  doc.roundedRect(x, y, w, h, 14).fillColor(PALETTE.soft).fill();
  doc.strokeColor(PALETTE.line).lineWidth(1).roundedRect(x, y, w, h, 14).stroke();
  doc.restore();

  if (title) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10.8)
      .fillColor(PALETTE.ink)
      .text(title, x + 14, y + 12, { width: w - 28 });
  }
}

/* =========================
   HEADER / FOOTER
========================= */

function addHeader(doc, data) {
  const meta = getMeta(data);

  const left = xLeft(doc);
  const right = xRight(doc);
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
    .text(`${meta.hostname || meta.url || ""}`, left, 30, { width, align: "right" });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#9CA3AF")
    .text(`Page ${doc._wrcPageNo || 1}`, left, 42, { width, align: "right" });

  doc.restore();
  normalizeBodyCursor(doc);
}

function addFooter(doc, meta, integrityHash) {
  const left = xLeft(doc);
  const right = xRight(doc);
  const width = right - left;
  const bottomY = doc.page.height - 40;

  const base = process.env.BASE_URL || "";
  const verifyUrl = base ? `${base}/verify/${integrityHash}` : `/verify/${integrityHash}`;

  const scanId = meta?.scanId ? String(meta.scanId) : "—";
  const ts = meta?.scannedAt ? iso(meta.scannedAt) : "";

  const prevY = doc.y;
  const prevX = doc.x;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
  doc.moveTo(left, bottomY - 10).lineTo(right, bottomY - 10).stroke();
  doc.restore();

  const line1 = `WebsiteRiskCheck.com • Report ID: ${scanId}${ts ? ` • Timestamp (UTC): ${ts}` : ""}`;
  const line2 = `Verify: ${verifyUrl}`;

  doc.save();
  doc.font("Helvetica").fontSize(8).fillColor(PALETTE.muted);
  doc.text(line1, left, bottomY, { width, align: "center" });
  doc.text(line2, left, bottomY + 10, { width, align: "center" });
  doc.restore();

  doc.y = prevY;
  doc.x = prevX;
}

/* =========================
   COVER
========================= */

function drawCoverBackground(doc) {
  const w = doc.page.width;
  const h = doc.page.height;

  doc.save();
  doc.rect(0, 0, w, h).fill(PALETTE.paper);

  doc
    .moveTo(0, 0)
    .lineTo(w * 0.42, 0)
    .lineTo(0, h * 0.20)
    .closePath()
    .fill(PALETTE.tealMid);

  doc
    .moveTo(w * 0.32, h)
    .lineTo(w, h * 0.58)
    .lineTo(w, h)
    .closePath()
    .fill(PALETTE.tealDark);

  doc
    .moveTo(w * 0.40, h)
    .lineTo(w, h * 0.70)
    .lineTo(w, h * 0.78)
    .lineTo(w * 0.52, h)
    .closePath()
    .fill(PALETTE.greenLight);

  doc
    .moveTo(w * 0.46, h)
    .lineTo(w, h * 0.74)
    .lineTo(w, h * 0.765)
    .lineTo(w * 0.50, h)
    .closePath()
    .fill("#FFFFFF");

  doc.restore();
}

function drawCover(doc, meta, risk, integrityHash) {
  drawCoverBackground(doc);

  const left = xLeft(doc);
  const width = widthBetweenMargins(doc);

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(PALETTE.tealDark)
    .text("WebsiteRiskCheck.com", left, 82, { width, align: "left" });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(PALETTE.muted)
    .text("Immutable point-in-time website snapshot (observable signals)", left, 100, {
      width,
      align: "left",
    });

  doc
    .font("Helvetica-Bold")
    .fontSize(36)
    .fillColor(PALETTE.tealMid)
    .text("Website Risk\nSnapshot", left, 290, { width, align: "center", lineGap: 2 });

  doc
    .font("Helvetica")
    .fontSize(12)
    .fillColor(PALETTE.body)
    .text("Sealed PDF deliverable with public verification", left, 402, {
      width,
      align: "center",
    });

  const tone = toneForRisk(risk.level);
  badge(doc, `Risk level: ${risk.level}`, tone, left + width / 2 - 92, 470);

  const boxY = 552;
  const boxW = Math.min(540, width);
  const boxX = left + (width - boxW) / 2;

  doc.save();
  doc.roundedRect(boxX, boxY, boxW, 150, 16).fill("#FFFFFF").stroke(PALETTE.line);
  doc.restore();

  const labelW = 150;
  const valX = boxX + labelW;

  const rows = [
    ["Website", meta.hostname || meta.url || "—"],
    ["Timestamp (UTC)", meta.scannedAt ? iso(meta.scannedAt) : "—"],
    ["Report ID", meta.scanId || "—"],
    ["Integrity hash", integrityHash.slice(0, 28) + "…"],
  ];

  let ry = boxY + 18;
  rows.forEach(([k, v]) => {
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(PALETTE.ink).text(k, boxX + 18, ry, {
      width: labelW - 18,
    });

    doc.font("Helvetica").fontSize(10.5).fillColor(PALETTE.body).text(v, valX, ry, {
      width: boxW - labelW - 18,
    });

    ry += 32;
  });

  doc
    .font("Helvetica")
    .fontSize(9.6)
    .fillColor(PALETTE.muted)
    .text(
      "Informational snapshot only — not legal advice, certification, or monitoring. Applies only at the recorded timestamp.",
      left,
      doc.page.height - 120,
      { width, align: "center", lineGap: 3 }
    );
}

/* =========================
   EXEC SUMMARY (FIXED LAYOUT)
========================= */

function whatThisMeansFor(level) {
  if (level === "High") {
    return "Multiple risk-relevant signals and/or missing public indicators were detected on the scanned surface. This does not prove non-compliance, but it suggests a structured review of policies, consent controls, and data-capture touchpoints may be warranted.";
  }
  if (level === "Medium") {
    return "Some risk-relevant signals and/or missing public indicators were detected on the scanned surface. This does not prove non-compliance, but it suggests potential gaps worth reviewing.";
  }
  return "Relatively few risk-relevant signals were detected on the scanned surface at the recorded timestamp. This does not guarantee compliance, but fewer obvious gaps were observed in scope.";
}

function renderExecSummary(doc, { meta, coverage, signals, risk, integrityHash, trackers, vendors, totalImages, imagesMissingAlt }) {
  sectionTitle(
    doc,
    "Executive summary",
    "Client-ready snapshot of observable website signals at a fixed timestamp."
  );

  // risk pill
  const tone = toneForRisk(risk.level);
  const pill = badge(doc, `Risk level: ${risk.level}`, tone, xLeft(doc), doc.y);
  doc.y += pill.h + 10;

  // 2×2 cards (full width)
  const left = xLeft(doc);
  const w = widthBetweenMargins(doc);
  const gap = 12;
  const colW = (w - gap) / 2;
  const cardH = 78;

  const idVal = meta.scanId || "—";
  const tsVal = meta.scannedAt ? iso(meta.scannedAt) : "—";
  const scopeVal = `${safeArr(coverage?.checkedPages).length || 0} page(s) checked`;
  const verVal = integrityHash.slice(0, 10) + "…" + integrityHash.slice(-10);

  const yCards = doc.y;

  card(doc, left, yCards, colW, cardH, { title: "Report ID", value: idVal });
  card(doc, left + colW + gap, yCards, colW, cardH, { title: "Timestamp (UTC)", value: tsVal });

  card(doc, left, yCards + cardH + gap, colW, cardH, {
    title: "Coverage",
    value: scopeVal,
    foot: "Scope-locked (public paths)",
  });
  card(doc, left + colW + gap, yCards + cardH + gap, colW, cardH, {
    title: "Verification fingerprint",
    value: verVal,
    foot: "Public integrity check",
  });

  // Move cursor BELOW the card grid
  doc.y = yCards + cardH * 2 + gap * 2 + 16;

  // Two-column content block
  const colGap = 14;
  const colW2 = (w - colGap) / 2;
  const xL = left;
  const xR = left + colW2 + colGap;
  const yTop = doc.y;

  // Build right column "Key findings" list
  const keyFindings = [];
  keyFindings.push(`HTTPS: ${meta.https ? "Detected" : "Not detected"}`);
  keyFindings.push(`Privacy policy: ${signals?.policies?.privacy ? "Detected" : "Not detected"}`);
  keyFindings.push(`Terms: ${signals?.policies?.terms ? "Detected" : "Not detected"}`);
  keyFindings.push(`Cookie policy: ${signals?.policies?.cookies ? "Detected" : "Not detected"}`);
  keyFindings.push(
    `Consent banner indicator: ${signals?.consent?.bannerDetected ? "Detected" : "Not detected"} (heuristic)`
  );
  keyFindings.push(
    `Tracking scripts: ${
      trackers.length
        ? `Detected (${trackers.slice(0, 4).join(", ")}${trackers.length > 4 ? "…" : ""})`
        : "None detected"
    }`
  );
  keyFindings.push(
    `Cookie vendor signals: ${
      vendors.length
        ? `Detected (${vendors.slice(0, 4).join(", ")}${vendors.length > 4 ? "…" : ""})`
        : "None detected"
    }`
  );
  keyFindings.push(`Forms detected: ${num(signals?.forms?.detected)}`);
  keyFindings.push(
    `Potential personal-data field signals: ${num(signals?.forms?.personalDataSignals)} (heuristic)`
  );
  keyFindings.push(`Images missing alt text: ${imagesMissingAlt} of ${totalImages}`);
  keyFindings.push(`Contact/identity signals: ${signals?.contact?.detected ? "Detected" : "Not detected"}`);

  // Estimate height needed so we can page-break cleanly if required
  doc.save();
  doc.font("Helvetica").fontSize(10.2);
  const leftTextH =
    doc.heightOfString(whatThisMeansFor(risk.level), { width: colW2, lineGap: 4 }) +
    18 +
    doc.heightOfString("Notable observations", { width: colW2 }) +
    10 +
    doc.heightOfString(safeArr(risk.reasons).slice(0, 10).join("\n"), { width: colW2, lineGap: 4 });

  const rightListH =
    16 + // panel title
    doc.heightOfString(keyFindings.join("\n"), { width: colW2 - 28, lineGap: 4 }) +
    28;

  doc.restore();

  const blockNeeded = Math.max(leftTextH, rightListH) + 36;
  ensureSpace(doc, Math.max(220, blockNeeded));

  // Re-set anchors after possible page add
  const y0 = doc.y;

  // LEFT COLUMN
  let yL = y0;

  doc.font("Helvetica-Bold").fontSize(12).fillColor(PALETTE.ink).text("What this means", xL, yL, {
    width: colW2,
  });
  yL += 18;

  doc.font("Helvetica").fontSize(10.8).fillColor(PALETTE.body).text(whatThisMeansFor(risk.level), xL, yL, {
    width: colW2,
    lineGap: 4,
  });
  yL += doc.heightOfString(whatThisMeansFor(risk.level), { width: colW2, lineGap: 4 }) + 12;

  doc.font("Helvetica-Bold").fontSize(12).fillColor(PALETTE.ink).text("Notable observations", xL, yL, {
    width: colW2,
  });
  yL += 14;

  doc.font("Helvetica").fontSize(10.8).fillColor(PALETTE.body);
  const obs = safeArr(risk.reasons).slice(0, 10);
  if (obs.length) {
    // manual bullets (more predictable than doc.list for column layouts)
    const bulletX = xL + 10;
    const textX = xL + 22;
    const lineGap = 4;

    obs.forEach((t) => {
      const lineH = doc.heightOfString(clampText(t, 180), { width: colW2 - 22, lineGap });
      doc.circle(bulletX, yL + 6, 1.6).fill(PALETTE.ink);
      doc.fillColor(PALETTE.body).text(clampText(t, 180), textX, yL, { width: colW2 - 22, lineGap });
      yL += lineH + 6;
    });
  } else {
    doc.fillColor(PALETTE.muted).text("No notable observations recorded.", xL, yL, { width: colW2 });
    yL += 18;
  }

  // RIGHT COLUMN (panel)
  let yR = y0;
  const panelPadTop = 34;
  const panelPadInner = 14;

  // compute panel height based on content
  doc.save();
  doc.font("Helvetica").fontSize(10.2);
  const listH = doc.heightOfString(keyFindings.join("\n"), { width: colW2 - 28, lineGap: 4 });
  doc.restore();

  const panelH = Math.max(180, panelPadTop + panelPadInner + listH + 16);
  panel(doc, xR, yR, colW2, panelH, { title: "Key findings (detectable signals)" });

  // list inside panel
  let yList = yR + panelPadTop;
  const bx = xR + 14;
  const bw = colW2 - 28;

  doc.font("Helvetica").fontSize(10.2).fillColor(PALETTE.body);

  // manual bullets inside panel
  keyFindings.slice(0, 12).forEach((t) => {
    const lineH = doc.heightOfString(clampText(t, 220), { width: bw - 16, lineGap: 4 });
    doc.circle(bx + 6, yList + 6, 1.6).fill(PALETTE.ink);
    doc.fillColor(PALETTE.body).text(clampText(t, 220), bx + 16, yList, { width: bw - 16, lineGap: 4 });
    yList += lineH + 6;
  });

  yR = yR + panelH;

  // Set doc.y to the *lowest* point so spacing continues cleanly
  doc.y = Math.max(yL, yR) + 10;

  hr(doc, 6);
}

/* =========================
   RISK REGISTER TABLE (LANDSCAPE)
========================= */

function scoreBand(score) {
  if (score >= 16) return { fill: PALETTE.scoreRed, ink: "#111827" };
  if (score >= 13) return { fill: PALETTE.scoreOrange, ink: "#111827" };
  if (score >= 9) return { fill: PALETTE.scoreYellow, ink: "#111827" };
  if (score >= 5) return { fill: PALETTE.scoreGreen, ink: "#111827" };
  return { fill: "#D1FAE5", ink: "#065F46" };
}

function drawRiskRegister_landscape(doc, rows, { meta, integrityHash }) {
  const left = xLeft(doc);
  const right = xRight(doc);
  const tableW = right - left;

  const headerH = 34;
  const minRowH = 92;

  const cols = [
    { key: "category", w: 110, label: "Risk\nCategory" },
    { key: "desc", w: 190, label: "Risk\nDescription" },
    { key: "prob", w: 90, label: "Probability" },
    { key: "impact", w: 80, label: "Impact" },
    { key: "score", w: 70, label: "Score" },
    { key: "trigger", w: 150, label: "Trigger" },
    { key: "response", w: 0, label: "Mitigation response" },
  ];

  const MIN_LAST = 170;
  const MIN_DESC = 150;
  const MIN_TRIGGER = 120;

  let fixedW = cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
  let remaining = tableW - fixedW;

  if (remaining < MIN_LAST) {
    let need = MIN_LAST - remaining;

    const descCol = cols.find((c) => c.key === "desc");
    const trigCol = cols.find((c) => c.key === "trigger");

    if (descCol) {
      const available = Math.max(0, descCol.w - MIN_DESC);
      const take = Math.min(available, need);
      descCol.w -= take;
      need -= take;
    }

    if (need > 0 && trigCol) {
      const available = Math.max(0, trigCol.w - MIN_TRIGGER);
      const take = Math.min(available, need);
      trigCol.w -= take;
      need -= take;
    }

    fixedW = cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
    remaining = tableW - fixedW;
  }

  cols[cols.length - 1].w = Math.max(90, remaining);

  function drawHeaderRow(y) {
    doc.save();
    doc.rect(left, y, tableW, headerH).fill(PALETTE.navy);
    doc.strokeColor("#94A3B8").lineWidth(0.8);
    doc.rect(left, y, tableW, headerH).stroke();
    doc.restore();

    let x = left;
    doc.save();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(10);
    cols.forEach((c) => {
      doc.text(c.label, x + 8, y + 7, { width: c.w - 16, align: "left" });
      x += c.w;
    });
    doc.restore();

    x = left;
    cols.forEach((c) => {
      doc.save();
      doc.strokeColor("#94A3B8").lineWidth(0.8);
      doc.moveTo(x, y).lineTo(x, y + headerH).stroke();
      doc.restore();
      x += c.w;
    });
    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.8);
    doc.moveTo(left + tableW, y).lineTo(left + tableW, y + headerH).stroke();
    doc.restore();
  }

  function calcRowHeight(r) {
    const padX = 10;
    const yPad = 24;
    const heights = [];

    cols.forEach((c) => {
      const tw = c.w - padX * 2;
      const key = c.key;

      if (key === "prob" || key === "impact") {
        doc.font("Helvetica-Bold").fontSize(10.5);
        heights.push(doc.heightOfString(String(r[key] ?? ""), { width: tw }) + yPad);
      } else if (key === "score") {
        heights.push(14 + yPad + 16);
      } else if (key === "category") {
        doc.font("Helvetica").fontSize(10.5);
        heights.push(doc.heightOfString(String(r.category ?? ""), { width: tw }) + yPad);
      } else {
        doc.font("Helvetica").fontSize(10.2);
        heights.push(doc.heightOfString(String(r[key] ?? ""), { width: tw, lineGap: 3 }) + yPad);
      }
    });

    const h = Math.max(minRowH, ...heights);
    return Math.max(minRowH, h);
  }

  normalizeBodyCursor(doc);
  let y = doc.y;

  drawHeaderRow(y);
  y += headerH;

  const bottom = () => doc.page.height - doc.page.margins.bottom - FOOTER_SAFE_PAD;

  rows.forEach((r, idx) => {
    const rowH = calcRowHeight(r);

    if (y + rowH > bottom()) {
      addFooter(doc, meta, integrityHash);
      doc.addPage({ layout: "landscape" });
      normalizeBodyCursor(doc);
      y = doc.y;

      drawHeaderRow(y);
      y += headerH;
    }

    const bg = idx % 2 === 0 ? PALETTE.rowA : PALETTE.rowB;

    doc.save();
    doc.rect(left, y, tableW, rowH).fill(bg);
    doc.restore();

    const scoreIndex = cols.findIndex((c) => c.key === "score");
    const scoreX = left + cols.slice(0, scoreIndex).reduce((a, c) => a + c.w, 0);
    const scoreW = cols[scoreIndex].w;
    const sb = scoreBand(num(r.scoreNum, 0));

    doc.save();
    doc.rect(scoreX, y, scoreW, rowH).fill(sb.fill);
    doc.restore();

    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.6);
    doc.rect(left, y, tableW, rowH).stroke();
    doc.restore();

    let vx = left;
    cols.forEach((c) => {
      doc.save();
      doc.strokeColor("#94A3B8").lineWidth(0.6);
      doc.moveTo(vx, y).lineTo(vx, y + rowH).stroke();
      doc.restore();
      vx += c.w;
    });
    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.6);
    doc.moveTo(left + tableW, y).lineTo(left + tableW, y + rowH).stroke();
    doc.restore();

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
        doc.text(clampText(r[c.key], 40), tx, ty + 18, { width: tw, align: "center" });
      } else if (c.key === "score") {
        doc.font("Helvetica-Bold").fontSize(14).fillColor("#111827");
        doc.text(String(r.scoreNum), tx, ty + 28, { width: tw, align: "center" });
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
   FINDINGS → ROWS (preferred)
========================= */

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
      trigger: clampText(f?.trigger || "Detected signals indicate potential exposure.", 260),
      response: clampText(f?.mitigation || "Review and remediate as appropriate.", 260),
    };
  });
}

/* =========================
   LEGACY DETERMINISTIC REGISTER (fallback)
========================= */

function buildRiskRegister(meta, coverage, signals) {
  const trackers = safeArr(signals?.trackingScripts);
  const vendors = safeArr(signals?.consent?.vendors);

  const totalImages = num(signals?.accessibility?.images?.total);
  const missingAlt = num(signals?.accessibility?.images?.missingAlt);

  const rows = [];

  // Compliance policy presence
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
        "If required policy pages are missing or not discoverable, regulatory exposure and customer trust risk may increase.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 4 ? "Major (4)" : "Moderate (3)",
      scoreNum: score,
      trigger: "Public policy pages are missing, not linked, or inaccessible on standard paths.",
      response:
        "Publish and link policy pages from the footer/homepage. Ensure versions are current and match actual data practices.",
    });
  }

  // Tracking
  {
    const hasTracking = trackers.length > 0 || vendors.length > 0;
    const prob = hasTracking ? 4 : 2;
    const impact = hasTracking ? 4 : 2;
    const score = prob * impact;

    rows.push({
      category: "Tracking",
      desc:
        "If tracking/cookie vendors are present without appropriate consent controls, regulatory and reputational exposure may increase.",
      prob: prob >= 4 ? "Likely (4)" : "Unlikely (2)",
      impact: impact >= 4 ? "Major (4)" : "Minor (2)",
      scoreNum: score,
      trigger: "Third-party scripts or consent vendor markers detected on scanned pages.",
      response:
        "Review tag inventory. Validate consent flow for target regions. Ensure vendor disclosure matches deployed scripts.",
    });
  }

  // Forms / data capture
  {
    const forms = num(signals?.forms?.detected);
    const personalSignals = num(signals?.forms?.personalDataSignals);
    const prob = forms > 0 ? (personalSignals > 0 ? 4 : 3) : 1;
    const impact = forms > 0 ? 4 : 1;
    const score = prob * impact;

    rows.push({
      category: "Data capture",
      desc:
        "If forms collect personal data, inadequate transparency, retention, or access controls can increase operational and compliance risk.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 4 ? "Major (4)" : "Low (1)",
      scoreNum: score,
      trigger: "Forms detected and personal-data field signals observed (heuristic).",
      response:
        "Audit form fields for minimum necessary data. Confirm storage, access controls, and retention. Align privacy disclosures.",
    });
  }

  // Accessibility
  {
    const ratio = totalImages > 0 ? missingAlt / totalImages : 0;
    const prob = ratio > 0.3 ? 4 : ratio > 0 ? 3 : 1;
    const impact = ratio > 0.3 ? 3 : ratio > 0 ? 2 : 1;
    const score = prob * impact;

    rows.push({
      category: "Accessibility",
      desc:
        "Missing alt text on meaningful images may reduce accessibility and increase risk for public-facing pages depending on audience and jurisdiction.",
      prob: prob >= 4 ? "Likely (4)" : prob >= 3 ? "Possible (3)" : "Unlikely (1)",
      impact: impact >= 3 ? "Moderate (3)" : impact === 2 ? "Minor (2)" : "Low (1)",
      scoreNum: score,
      trigger: "Alt text missing for a portion of detected images (heuristic scan).",
      response:
        "Add alt text to meaningful images on key pages where missing. Prioritise conversion and policy pages first.",
    });
  }

  // Trust / identity
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
      trigger: "Contact/identity markers not detected on scanned surface (heuristic).",
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

      const integrityInput = buildIntegrityInput(data);
      const integrityHash = computeIntegrityHash(integrityInput);

      const risk = computeRisk(data);

      data.integrityHash = integrityHash;
      data.riskLevel = risk.level;
      data.riskScore = risk.score;
      data.riskReasons = safeArr(risk.reasons);
      if (data.meta) data.meta.integrityHash = integrityHash;

      const verifyUrl = base ? `${base}/verify/${integrityHash}` : `/verify/${integrityHash}`;

      const trackers = safeArr(signals?.trackingScripts);
      const vendors = safeArr(signals?.consent?.vendors);
      const totalImages = num(signals?.accessibility?.images?.total);
      const imagesMissingAlt = num(signals?.accessibility?.images?.missingAlt);

      const findings = safeArr(data?.findings || data?.meta?.findings);
      const structuredRows = rowsFromFindings(findings);
      const riskRows = structuredRows.length ? structuredRows : buildRiskRegister(meta, coverage, signals);

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

      doc._wrcPageNo = 1;

      doc.on("pageAdded", () => {
        doc._wrcPageNo = (doc._wrcPageNo || 1) + 1;
        if (doc._wrcPageNo >= 2) addHeader(doc, data);
        normalizeBodyCursor(doc);
      });

      // PAGE 1 — COVER
      drawCover(doc, meta, risk, integrityHash);
      addFooter(doc, meta, integrityHash);

      // PAGE 2 — EXEC SUMMARY
      doc.addPage();
      renderExecSummary(doc, {
        meta,
        coverage,
        signals,
        risk,
        integrityHash,
        trackers,
        vendors,
        totalImages,
        imagesMissingAlt,
      });
      addFooter(doc, meta, integrityHash);

      // PAGE 3+ — RISK REGISTER (LANDSCAPE)
      doc.addPage({ layout: "landscape" });

      sectionTitle(
        doc,
        "Risk register",
        "Indicative probability×impact scoring for detected/derived entries (not legal conclusions)."
      );
      doc.moveDown(0.2);

      drawRiskRegister_landscape(doc, riskRows, { meta, integrityHash });

      doc
        .font("Helvetica")
        .fontSize(9.2)
        .fillColor(PALETTE.muted)
        .text(
          "Note: Register scores reflect probability×impact per entry. The overall risk level is derived separately from the signal model.",
          xLeft(doc),
          doc.y,
          { width: widthBetweenMargins(doc), lineGap: 2 }
        );

      addFooter(doc, meta, integrityHash);

      // NEXT — FINDINGS BY CATEGORY
      doc.addPage();

      sectionTitle(doc, "Findings by category", "What was detected on the scanned surface (scope-locked).");

      subTitle(doc, "Connection");
      bulletList(doc, [`HTTPS: ${meta.https ? "Detected" : "Not detected"}`]);
      bodyText(doc, "HTTPS reduces interception risk and is commonly expected for customer-facing websites.");
      hr(doc);

      subTitle(doc, "Policies (public-path detection)");
      bulletList(doc, [
        `Privacy policy present: ${yesNo(!!signals?.policies?.privacy)}`,
        `Terms present: ${yesNo(!!signals?.policies?.terms)}`,
        `Cookie policy present: ${yesNo(!!signals?.policies?.cookies)}`,
      ]);
      bodyText(
        doc,
        "Policy presence is detected using scope-locked discovery (homepage links and standard public paths). Absence of detection is not proof of absence."
      );
      hr(doc);

      subTitle(doc, "Cookies & tracking (HTML detection)");
      bulletList(doc, [
        `Tracking scripts: ${trackers.length ? trackers.join(", ") : "None detected"}`,
        `Cookie vendor signals: ${vendors.length ? vendors.join(", ") : "None detected"}`,
      ]);
      bodyText(
        doc,
        "Detections are based on observable HTML/script references. Interaction-gated or dynamically loaded tags may not be detected."
      );
      hr(doc);

      subTitle(doc, "Consent indicators (heuristic)");
      bulletList(doc, [`Cookie/consent banner indicator: ${yesNo(!!signals?.consent?.bannerDetected)}`]);
      bodyText(doc, "Heuristic signal based on text/DOM patterns and consent vendor markers. Not a guarantee.");
      hr(doc);

      subTitle(doc, "Forms & data capture (heuristic)");
      bulletList(doc, [
        `Forms detected: ${num(signals?.forms?.detected)}`,
        `Potential personal-data field signals: ${num(signals?.forms?.personalDataSignals)}`,
      ]);
      bodyText(doc, "Personal-data signals are heuristic counts based on common field names. They are not legal classifications.");
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
        "Accessibility checks are lightweight and indicative only. A full audit typically requires broader coverage and manual testing."
      );
      hr(doc);

      subTitle(doc, "Contact & identity signals");
      bulletList(doc, [`Contact/business identity signals: ${yesNo(!!signals?.contact?.detected)}`]);
      bodyText(doc, "Detected using simple patterns (email/phone/contact link) on the scanned surface only.");

      addFooter(doc, meta, integrityHash);

      // COMMON NEXT STEPS
      doc.addPage();

      sectionTitle(doc, "Common next steps", "General orientation only — not legal advice.");

      bodyText(
        doc,
        "The items below are commonly reviewed when these signals appear. They’re presented as practical next steps and are not prescriptive requirements."
      );
      doc.moveDown(0.6);

      bulletList(doc, [
        "Ensure privacy and terms pages are public and linked from the site footer and/or homepage.",
        "If third-party tracking/cookies are used, review whether consent mechanisms are appropriate for your target regions.",
        "Review forms for minimum necessary fields; confirm storage, access controls, and retention practices.",
        "Add alt text to meaningful images on key pages where missing.",
        "Ensure visitors can easily find contact/business identity information.",
        "Re-run a snapshot after major changes (redesigns, marketing tags, new forms, new third-party embeds).",
      ]);

      addFooter(doc, meta, integrityHash);

      // METHODOLOGY & LIMITATIONS
      doc.addPage();

      sectionTitle(doc, "Methodology & limitations", "How this snapshot is produced, and what it does not do.");

      subTitle(doc, "Methodology (this scan)");
      bulletList(doc, [
        "Fetches public HTML from the homepage and standard public policy/contact paths (scope-locked).",
        "Detects common tracking scripts by known HTML/script patterns.",
        "Detects common consent vendors by known markers.",
        "Detects policy presence via links and standard paths (scope-locked).",
        "Detects consent banner indicators via DOM/text heuristics (heuristic).",
        "Detects forms and likely personal-data field signals via field-name heuristics.",
        "Runs lightweight accessibility checks (alt text counts, basic notes).",
      ]);

      doc.moveDown(0.6);

      subTitle(doc, "Scope and exclusions");
      bulletList(doc, [
        "No full-site crawling.",
        "Public, unauthenticated HTML only (no logins).",
        "No behavioural simulation (no clicking banners, no region toggles).",
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

      // VERIFICATION
      doc.addPage();

      sectionTitle(doc, "Report verification", "Public integrity check for this sealed snapshot.");

      bodyText(
        doc,
        "This report can be independently verified using its cryptographic fingerprint. The integrity hash is derived from objective fields only, allowing verification that the recorded facts have not been altered."
      );
      doc.moveDown(0.8);

      subTitle(doc, "Integrity hash (SHA-256)");
      doc.font("Helvetica").fontSize(9.8).fillColor(PALETTE.ink).text(integrityHash, { lineGap: 2 });
      doc.moveDown(0.8);

      subTitle(doc, "Verification link");
      doc.font("Helvetica").fontSize(10.8).fillColor(PALETTE.body).text(verifyUrl);
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
      ensureSpace(doc, 240);

      const qx = xLeft(doc);
      const qy = doc.y;

      doc.save();
      doc.roundedRect(qx, qy, 180, 180, 16).fill("#FFFFFF").stroke(PALETTE.line);
      doc.restore();

      doc.image(qrDataUrl, qx + 22, qy + 22, { width: 136 });

      doc
        .font("Helvetica")
        .fontSize(9.6)
        .fillColor(PALETTE.muted)
        .text("Scan to verify", qx + 0, qy + 190, { width: 180, align: "center" });

      addFooter(doc, meta, integrityHash);

      doc.end();

      stream.on("finish", () => resolve({ outputPath, integrityHash }));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
