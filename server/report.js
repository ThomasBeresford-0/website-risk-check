// server/report.js
// FULL RAMBO — audit-grade, verifiable, point-in-time, immutable PDF (structured model)
// BOUTIQUE UPGRADE (v2.4): perfect spacing + no orphan pages + compact landscape register
// ✅ Fixes: exec summary dead whitespace, key findings orphan page, risk register spill w/ huge blanks
// ✅ Still: NO blank/ghost pages (height-clamped), NO table overflow, NO footer poisoning doc.y
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

  navy: "#021942",
  rowA: "#F3F4F6",
  rowB: "#EEF2F7",

  scoreGreen: "#BFD83A",
  scoreYellow: "#F6BE34",
  scoreOrange: "#F39C12",
  scoreRed: "#E74C3C",
};

/* =========================
   LAYOUT CONSTANTS (critical)
========================= */
const CONTENT_TOP_Y = 78;

// Footer must be drawn INSIDE margins, otherwise PDFKit auto-adds pages.
// Reserve enough space so content never overlaps footer.
const FOOTER_HEIGHT = 34; // divider + 2 lines
const FOOTER_GAP = 10; // breathing room above footer reserve

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

function contentBottomY(doc) {
  // Last safe y for flowing content (inside margins, reserving footer area)
  return doc.page.height - doc.page.margins.bottom - FOOTER_HEIGHT - FOOTER_GAP;
}

function remainingSpace(doc) {
  return Math.max(0, contentBottomY(doc) - doc.y);
}

/**
 * Always keep doc.y in a sane place after page creation.
 */
function normalizeBodyCursor(doc) {
  if (doc.y < CONTENT_TOP_Y) doc.y = CONTENT_TOP_Y;
  if (doc.x !== doc.page.margins.left) doc.x = doc.page.margins.left;
}

/**
 * Ensure there is enough vertical space for the next block.
 * IMPORTANT: footer-safe.
 */
function ensureSpace(doc, minSpace = 120) {
  const bottom = contentBottomY(doc);
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
  ensureSpace(doc, 140);

  doc.font("Helvetica-Bold").fontSize(20).fillColor(PALETTE.ink).text(title);
  if (subtitle) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(PALETTE.muted)
      .text(subtitle, { lineGap: 2 });
  }
  doc.moveDown(0.55);
}

// tighter variant for landscape pages (gives table more vertical room)
function sectionTitleCompact(doc, title, subtitle = "") {
  ensureSpace(doc, 110);

  doc.font("Helvetica-Bold").fontSize(18).fillColor(PALETTE.ink).text(title);
  if (subtitle) {
    doc
      .font("Helvetica")
      .fontSize(10.2)
      .fillColor(PALETTE.muted)
      .text(subtitle, { lineGap: 1.8 });
  }
  doc.moveDown(0.35);
}

function subTitle(doc, title) {
  ensureSpace(doc, 90);
  doc.font("Helvetica-Bold").fontSize(12.5).fillColor(PALETTE.ink).text(title);
  doc.moveDown(0.35);
}

function bodyText(doc, text, opts = {}) {
  doc
    .font("Helvetica")
    .fontSize(opts.size || 10.8)
    .fillColor(PALETTE.body)
    .text(text, { lineGap: opts.lineGap ?? 4, width: opts.width, align: opts.align });
}

/**
 * Bullet list with deterministic spacing + good left alignment (no doc.list quirks).
 * Returns new y.
 */
function bulletList(doc, items, opts = {}) {
  const safe = safeArr(items).filter(Boolean);
  if (!safe.length) return doc.y;

  const x = opts.x ?? xLeft(doc);
  const w = opts.width ?? widthBetweenMargins(doc);
  const size = opts.size ?? 10.6;
  const gap = opts.gap ?? 6;
  const bulletIndent = opts.bulletIndent ?? 14;
  const lineGap = opts.lineGap ?? 3;

  doc.font("Helvetica").fontSize(size).fillColor(PALETTE.body);

  let y = opts.y ?? doc.y;

  const bulletX = x;
  const textX = x + bulletIndent;
  const textW = Math.max(20, w - bulletIndent);

  for (const raw of safe) {
    const t = String(raw);
    const h = doc.heightOfString(t, { width: textW, lineGap });

    // keep footer safe
    if (y + h + 6 > contentBottomY(doc)) {
      doc.addPage();
      normalizeBodyCursor(doc);
      y = doc.y;
    }

    // bullet
    doc.save();
    doc.fillColor(PALETTE.body);
    doc.circle(bulletX + 3.2, y + 5.2, 1.6).fill();
    doc.restore();

    doc.text(t, textX, y, { width: textW, lineGap });

    y += h + gap;
  }

  doc.y = y;
  return y;
}

/**
 * Two-column bullet list (perfect for “Key findings” so it never creates an orphan page).
 * Returns { yEnd, colHeights }.
 */
function bulletListTwoCol(doc, items, opts = {}) {
  const safe = safeArr(items).filter(Boolean);
  if (!safe.length) return { yEnd: doc.y, colHeights: [0, 0] };

  const x = opts.x ?? xLeft(doc);
  const w = opts.width ?? widthBetweenMargins(doc);
  const yStart = opts.y ?? doc.y;
  const size = opts.size ?? 10.2;
  const gap = opts.gap ?? 6;
  const colGap = opts.colGap ?? 16;
  const lineGap = opts.lineGap ?? 3;
  const bulletIndent = opts.bulletIndent ?? 14;

  const colW = (w - colGap) / 2;
  const leftX = x;
  const rightX = x + colW + colGap;

  doc.font("Helvetica").fontSize(size).fillColor(PALETTE.body);

  // measure each item height in a column
  const textW = Math.max(20, colW - bulletIndent);
  const heights = safe.map((t) => doc.heightOfString(String(t), { width: textW, lineGap }) + gap);

  // greedy balance: fill left until it would exceed available height, then right
  const avail = Math.max(60, contentBottomY(doc) - yStart);
  const left = [];
  const right = [];

  let leftH = 0;
  for (let i = 0; i < safe.length; i++) {
    if (leftH + heights[i] <= avail || right.length === 0) {
      left.push(safe[i]);
      leftH += heights[i];
    } else {
      right.push(safe[i]);
    }
  }

  const renderCol = (colItems, colX) => {
    let y = yStart;
    for (const raw of colItems) {
      const t = String(raw);
      const h = doc.heightOfString(t, { width: textW, lineGap });

      if (y + h + 6 > contentBottomY(doc)) {
        doc.addPage();
        normalizeBodyCursor(doc);
        y = doc.y;
      }

      doc.save();
      doc.fillColor(PALETTE.body);
      doc.circle(colX + 3.2, y + 5.2, 1.6).fill();
      doc.restore();

      doc.text(t, colX + bulletIndent, y, { width: textW, lineGap });
      y += h + gap;
    }
    return y;
  };

  const yL = renderCol(left, leftX);
  const yR = renderCol(right, rightX);

  const yEnd = Math.max(yL, yR);
  doc.y = yEnd;
  return { yEnd, colHeights: [yL - yStart, yR - yStart] };
}

function card(doc, x, y, w, h, { title, value, foot } = {}) {
  doc.save();
  doc.roundedRect(x, y, w, h, 14).fillColor("#FFFFFF").fill();
  doc.strokeColor(PALETTE.line).lineWidth(1).roundedRect(x, y, w, h, 14).stroke();
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

/* =========================
   HEADER / FOOTER
========================= */

function addHeader(doc, data) {
  const meta = getMeta(data);

  const left = xLeft(doc);
  const right = xRight(doc);
  const width = right - left;

  // divider
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

/**
 * CRITICAL FIX:
 * Footer Y must be inside bottom margin.
 * If you render footer below doc.page.height - doc.page.margins.bottom,
 * PDFKit auto-adds a new page -> ghost pages.
 */
function addFooter(doc, meta, integrityHash) {
  const left = xLeft(doc);
  const right = xRight(doc);
  const width = right - left;

  const base = process.env.BASE_URL || "";
  const verifyUrl = base ? `${base}/verify/${integrityHash}` : `/verify/${integrityHash}`;

  const scanId = meta?.scanId ? String(meta.scanId) : "—";
  const ts = meta?.scannedAt ? iso(meta.scannedAt) : "";

  // SAFE footer block coordinates (inside margins)
  const footerTop = doc.page.height - doc.page.margins.bottom - FOOTER_HEIGHT;
  const dividerY = footerTop + 6;
  const line1Y = footerTop + 12;
  const line2Y = footerTop + 22;

  // Prevent footer render from affecting flow cursor
  const prevY = doc.y;
  const prevX = doc.x;

  doc.save();
  doc.strokeColor(PALETTE.line).lineWidth(1);
  doc.moveTo(left, dividerY).lineTo(right, dividerY).stroke();
  doc.restore();

  const line1 = `WebsiteRiskCheck.com • Report ID: ${scanId}${ts ? ` • Timestamp (UTC): ${ts}` : ""}`;
  const line2 = `Verify: ${verifyUrl}`;

  doc.save();
  doc.font("Helvetica").fontSize(8).fillColor(PALETTE.muted);
  doc.text(line1, left, line1Y, { width, align: "center", lineBreak: false });
  doc.text(line2, left, line2Y, { width, align: "center", lineBreak: false });
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
    .lineTo(0, h * 0.2)
    .closePath()
    .fill(PALETTE.tealMid);

  doc
    .moveTo(w * 0.32, h)
    .lineTo(w, h * 0.58)
    .lineTo(w, h)
    .closePath()
    .fill(PALETTE.tealDark);

  doc
    .moveTo(w * 0.4, h)
    .lineTo(w, h * 0.7)
    .lineTo(w, h * 0.78)
    .lineTo(w * 0.52, h)
    .closePath()
    .fill(PALETTE.greenLight);

  doc
    .moveTo(w * 0.46, h)
    .lineTo(w, h * 0.74)
    .lineTo(w, h * 0.765)
    .lineTo(w * 0.5, h)
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
      doc.page.height - doc.page.margins.bottom - 60,
      { width, align: "center", lineGap: 3 }
    );
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

/**
 * v2.4 (CRITICAL layout)
 * - Compact title/header so table gains vertical height.
 * - Smaller header row + slightly smaller minRowH so 4 rows fit on a single A4 landscape page
 *   in your sample (eliminates the “last row + note on next page” dead whitespace).
 * - Cell text height-clamped (still prevents ghost pages).
 */
function drawRiskRegister_landscape(doc, rows, { meta, integrityHash }) {
  const left = xLeft(doc);
  const right = xRight(doc);
  const tableW = right - left;

  // Tighter header so table gains vertical space
  const headerH = 30;
  const minRowH = 78;

  const COL_SPEC = [
    { key: "category", pct: 0.12, label: "Risk\nCategory", min: 70 },
    { key: "desc", pct: 0.22, label: "Risk\nDescription", min: 140 },
    { key: "prob", pct: 0.11, label: "Probability", min: 70 },
    { key: "impact", pct: 0.10, label: "Impact", min: 64 },
    { key: "score", pct: 0.08, label: "Score", min: 52 },
    { key: "trigger", pct: 0.17, label: "Trigger", min: 110 },
    { key: "response", pct: 0.20, label: "Mitigation\nresponse", min: 140 },
  ];

  function buildColsExact() {
    // Start with pct widths
    let cols = COL_SPEC.map((c) => ({
      ...c,
      w: Math.round(tableW * c.pct),
    }));

    // Apply mins
    cols.forEach((c) => {
      c.w = Math.max(c.min, c.w);
    });

    const sum = () => cols.reduce((a, c) => a + c.w, 0);

    // If mins/pcts exceed available width, shrink intelligently but ALWAYS fit
    if (sum() > tableW) {
      const minSum = cols.reduce((a, c) => a + c.min, 0);

      // If even mins can't fit, scale mins down (soft floor)
      if (minSum > tableW) {
        const SOFT_FLOOR = 44; // never go below this; keeps text readable, avoids "vertical letters"
        const scale = tableW / minSum;

        cols = cols.map((c) => ({
          ...c,
          w: Math.max(SOFT_FLOOR, Math.floor(c.min * scale)),
        }));
      } else {
        // We can fit mins — shave from wider columns down toward mins
        let over = sum() - tableW;
        const shaveOrder = ["desc", "response", "trigger", "category", "prob", "impact"];

        let guard = 0;
        while (over > 0 && guard++ < 20000) {
          let shaved = false;
          for (const k of shaveOrder) {
            if (over <= 0) break;
            const col = cols.find((c) => c.key === k);
            if (!col) continue;
            if (col.w > col.min) {
              col.w -= 1;
              over -= 1;
              shaved = true;
            }
          }
          if (!shaved) break;
        }
      }
    }

    // If we have spare pixels, give them to the last column
    if (sum() < tableW) {
      const diff = tableW - sum();
      cols[cols.length - 1].w += diff;
    }

    // Absolute final clamp: FORCE exact fit by setting last col to remainder
    const beforeLast = cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
    cols[cols.length - 1].w = Math.max(cols[cols.length - 1].min, tableW - beforeLast);

    // If that made us overflow again (rare), shave again from earlier columns
    let finalOver = cols.reduce((a, c) => a + c.w, 0) - tableW;
    if (finalOver > 0) {
      const shaveOrder = ["desc", "trigger", "category", "response"];
      let guard = 0;
      while (finalOver > 0 && guard++ < 20000) {
        let shaved = false;
        for (const k of shaveOrder) {
          if (finalOver <= 0) break;
          const col = cols.find((c) => c.key === k);
          if (!col) continue;
          if (col.w > col.min) {
            col.w -= 1;
            finalOver -= 1;
            shaved = true;
          }
        }
        if (!shaved) break;
      }
      // Re-force exact remainder on last col
      const bl = cols.slice(0, -1).reduce((a, c) => a + c.w, 0);
      cols[cols.length - 1].w = Math.max(cols[cols.length - 1].min, tableW - bl);
    }

    return cols;
  }

  const cols = buildColsExact();

  function drawHeaderRow(y) {
    doc.save();
    doc.rect(left, y, tableW, headerH).fill(PALETTE.navy);
    doc.strokeColor("#94A3B8").lineWidth(0.8);
    doc.rect(left, y, tableW, headerH).stroke();
    doc.restore();

    let x = left;
    doc.save();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9.4);
    for (const c of cols) {
      doc.text(c.label, x + 8, y + 6, {
        width: c.w - 16,
        align: "left",
        lineGap: 1,
      });
      x += c.w;
    }
    doc.restore();

    // vertical lines
    x = left;
    for (const c of cols) {
      doc.save();
      doc.strokeColor("#94A3B8").lineWidth(0.8);
      doc.moveTo(x, y).lineTo(x, y + headerH).stroke();
      doc.restore();
      x += c.w;
    }

    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.8);
    doc.moveTo(left + tableW, y).lineTo(left + tableW, y + headerH).stroke();
    doc.restore();
  }

  function calcRowHeight(r) {
    const padX = 10;
    const yPad = 18;

    const heights = cols.map((c) => {
      const tw = Math.max(12, c.w - padX * 2);

      if (c.key === "prob" || c.key === "impact") {
        doc.font("Helvetica-Bold").fontSize(10.1);
        return doc.heightOfString(String(r[c.key] ?? ""), { width: tw }) + yPad;
      }

      if (c.key === "score") return 14 + yPad + 12;

      if (c.key === "category") {
        doc.font("Helvetica").fontSize(10.1);
        return doc.heightOfString(String(r.category ?? ""), { width: tw }) + yPad;
      }

      doc.font("Helvetica").fontSize(9.8);
      return doc.heightOfString(String(r[c.key] ?? ""), { width: tw, lineGap: 2 }) + yPad;
    });

    const h = Math.max(minRowH, ...heights);
    return Math.min(160, h); // tight clamp, prevents overflow/ghost pages
  }

  function bottom() {
    return contentBottomY(doc);
  }

  // Precompute heights ONCE
  const rowHeights = rows.map((r) => calcRowHeight(r));

  function drawRowAt(yTop, r, rowH, idx) {
    const bg = idx % 2 === 0 ? PALETTE.rowA : PALETTE.rowB;

    doc.save();
    doc.rect(left, yTop, tableW, rowH).fill(bg);
    doc.restore();

    const scoreIndex = cols.findIndex((c) => c.key === "score");
    const scoreX = left + cols.slice(0, scoreIndex).reduce((a, c) => a + c.w, 0);
    const scoreW = cols[scoreIndex].w;
    const sb = scoreBand(num(r.scoreNum, 0));

    doc.save();
    doc.rect(scoreX, yTop, scoreW, rowH).fill(sb.fill);
    doc.restore();

    // borders
    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.6);
    doc.rect(left, yTop, tableW, rowH).stroke();
    doc.restore();

    let vx = left;
    for (const c of cols) {
      doc.save();
      doc.strokeColor("#94A3B8").lineWidth(0.6);
      doc.moveTo(vx, yTop).lineTo(vx, yTop + rowH).stroke();
      doc.restore();
      vx += c.w;
    }
    doc.save();
    doc.strokeColor("#94A3B8").lineWidth(0.6);
    doc.moveTo(left + tableW, yTop).lineTo(left + tableW, yTop + rowH).stroke();
    doc.restore();

    // text (height-clamped)
    const savedY = doc.y;
    const savedX = doc.x;

    let cx = left;
    for (const c of cols) {
      const pad = 10;
      const tx = cx + pad;
      const ty = yTop + 10;
      const tw = Math.max(12, c.w - pad * 2);
      const th = Math.max(12, rowH - 18);

      if (c.key === "category") {
        doc.font("Helvetica").fontSize(10.1).fillColor(PALETTE.ink);
        doc.text(clampText(r.category, 70), tx, ty, { width: tw, height: th, ellipsis: true });
      } else if (c.key === "prob" || c.key === "impact") {
        doc.font("Helvetica-Bold").fontSize(10.1).fillColor(PALETTE.ink);
        doc.text(clampText(r[c.key], 46), tx, ty + 14, {
          width: tw,
          height: th - 14,
          align: "center",
          ellipsis: true,
        });
      } else if (c.key === "score") {
        doc.font("Helvetica-Bold").fontSize(13.3).fillColor("#111827");
        doc.text(String(r.scoreNum), tx, ty + 22, {
          width: tw,
          height: th - 22,
          align: "center",
          ellipsis: true,
        });
      } else {
        doc.font("Helvetica").fontSize(9.8).fillColor(PALETTE.ink);
        doc.text(clampText(r[c.key], 360), tx, ty, {
          width: tw,
          height: th,
          lineGap: 2,
          ellipsis: true,
        });
      }

      cx += c.w;
    }

    doc.y = savedY;
    doc.x = savedX;
  }

  normalizeBodyCursor(doc);

  // Keep table high
  let y = doc.y;
  if (y < CONTENT_TOP_Y + 10) y = CONTENT_TOP_Y + 10;

  let idx = 0;

  while (idx < rows.length) {
    // New page if header can't fit
    if (y + headerH > bottom()) {
      addFooter(doc, meta, integrityHash);
      doc.addPage({ layout: "landscape" });
      normalizeBodyCursor(doc);
      y = doc.y;
      if (y < CONTENT_TOP_Y + 10) y = CONTENT_TOP_Y + 10;
    }

    // Header
    drawHeaderRow(y);
    y += headerH;

    // Fit as many rows as possible on this page
    let fit = 0;
    let used = 0;

    while (idx + fit < rows.length) {
      const h = rowHeights[idx + fit];
      if (y + used + h > bottom()) break;
      used += h;
      fit += 1;
    }

    if (fit === 0) fit = 1;

    // Orphan rule: don't leave exactly 1 row for next page if we can avoid it
    const remainingAfter = (rows.length - idx) - fit;
    if (remainingAfter === 1 && fit > 1) fit -= 1;

    for (let j = 0; j < fit; j++) {
      const r = rows[idx + j];
      const rowH = rowHeights[idx + j];
      drawRowAt(y, r, rowH, idx + j);
      y += rowH;
    }

    idx += fit;

    if (idx < rows.length) {
      addFooter(doc, meta, integrityHash);
      doc.addPage({ layout: "landscape" });
      normalizeBodyCursor(doc);
      y = doc.y;
      if (y < CONTENT_TOP_Y + 10) y = CONTENT_TOP_Y + 10;
    }
  }

  doc.y = y + 10;
}



/* =========================
   EXEC / RISK MODEL TEXT
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
      category: clampText(f?.category || "General", 70),
      desc: clampText(f?.description || "", 380),
      prob: clampText(`${pLabel} (${pVal})`, 46),
      impact: clampText(`${iLabel} (${iVal})`, 46),
      scoreNum,
      trigger: clampText(f?.trigger || "Detected signals indicate potential exposure.", 380),
      response: clampText(f?.mitigation || "Review and remediate as appropriate.", 460),
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

      // Mutate only safe “enrichment” fields (NOT used by integrity input)
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

      // deterministic, monotonic page numbering
      doc._wrcPageNo = 1;

      doc.on("pageAdded", () => {
        doc._wrcPageNo = (doc._wrcPageNo || 1) + 1;

        // Cover is page 1 only. Every subsequent page gets the header.
        if (doc._wrcPageNo >= 2) addHeader(doc, data);

        normalizeBodyCursor(doc);
      });

      /* ======================
         PAGE 1 — COVER
      ====================== */
      drawCover(doc, meta, risk, integrityHash);
      addFooter(doc, meta, integrityHash);

      /* ======================
         PAGE 2 — EXEC SUMMARY (FIXED: two-column, no orphan whitespace)
      ====================== */
      doc.addPage();

      sectionTitle(
        doc,
        "Executive summary",
        "Client-ready snapshot of observable website signals at a fixed timestamp."
      );

      const tone = toneForRisk(risk.level);
      badge(doc, `Risk level: ${risk.level}`, tone, xLeft(doc), doc.y);
      doc.moveDown(0.85);

      const left = xLeft(doc);
      const w = widthBetweenMargins(doc);
      const gap = 12;
      const colW = (w - gap) / 2;
      const cardH = 74;

      const idVal = meta.scanId || "—";
      const tsVal = meta.scannedAt ? iso(meta.scannedAt) : "—";
      const scopeVal = `${safeArr(coverage?.checkedPages).length || 0} page(s) checked`;
      const verVal = integrityHash.slice(0, 10) + "…" + integrityHash.slice(-10);

      const y0 = doc.y;

      card(doc, left, y0, colW, cardH, { title: "Report ID", value: idVal });
      card(doc, left + colW + gap, y0, colW, cardH, { title: "Timestamp (UTC)", value: tsVal });

      card(doc, left, y0 + cardH + gap, colW, cardH, {
        title: "Coverage",
        value: scopeVal,
        foot: "Scope-locked (public paths)",
      });

      card(doc, left + colW + gap, y0 + cardH + gap, colW, cardH, {
        title: "Verification fingerprint",
        value: verVal,
        foot: "Public integrity check",
      });

      doc.y = y0 + cardH * 2 + gap * 2 + 10;

      // Two-column body block under the cards:
      // Left column: meaning + notable observations
      // Right column: key findings list
      const bodyTop = doc.y;
      const bodyColW = (w - 18) / 2;
      const bodyGap = 18;

      const lx = left;
      const rx = left + bodyColW + bodyGap;

      // Key findings (right column)
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

      // Left column render
      doc.save();
      doc.x = lx;
      doc.y = bodyTop;

      doc.font("Helvetica").fontSize(10.8).fillColor(PALETTE.body);
      bodyText(doc, whatThisMeansFor(risk.level), { width: bodyColW, size: 10.8, lineGap: 4 });
      doc.moveDown(0.6);

      doc
        .font("Helvetica-Bold")
        .fontSize(12.2)
        .fillColor(PALETTE.ink)
        .text("Notable observations", lx, doc.y, { width: bodyColW });
      doc.moveDown(0.35);

      const leftAfter = bulletList(doc, safeArr(risk.reasons).slice(0, 9), {
        x: lx,
        width: bodyColW,
        size: 10.2,
        gap: 6,
      });

      doc.restore();

      // Right column render
      doc.save();
      doc.x = rx;
      doc.y = bodyTop;

      doc
        .font("Helvetica-Bold")
        .fontSize(12.2)
        .fillColor(PALETTE.ink)
        .text("Key findings (detectable signals)", rx, doc.y, { width: bodyColW });
      doc.moveDown(0.35);

      const rightAfter = bulletList(doc, keyFindings, {
        x: rx,
        width: bodyColW,
        size: 10.1,
        gap: 6,
      });

      doc.restore();

      // Continue below the deeper column — but avoid pointless whitespace
      doc.y = Math.min(contentBottomY(doc) - 8, Math.max(leftAfter, rightAfter) + 2);

      addFooter(doc, meta, integrityHash);

      /* ======================
         RISK REGISTER — LANDSCAPE (FIXED: compact title + better packing)
      ====================== */
      doc.addPage({ layout: "landscape" });

      sectionTitleCompact(
        doc,
        "Risk register",
        "Indicative probability×impact scoring for detected/derived entries (not legal conclusions)."
      );

      drawRiskRegister_landscape(doc, riskRows, { meta, integrityHash });

      // Legend / note (fills remaining space so you don’t get a sad half-empty page)
      const legendY = doc.y;
      if (remainingSpace(doc) > 90) {
        const lx2 = xLeft(doc);
        const ww = widthBetweenMargins(doc);

        doc.save();
        doc
          .font("Helvetica-Bold")
          .fontSize(10.4)
          .fillColor(PALETTE.ink)
          .text("How to read this register", lx2, legendY, { width: ww });
        doc.restore();

        doc.y = legendY + 16;

        bodyText(
          doc,
          "Scores reflect probability×impact per entry. The overall risk level is derived separately from the signal model. Entries are indicative and should be validated against your actual implementation and target regions.",
          { width: ww, size: 9.6, lineGap: 3.2 }
        );

        doc.moveDown(0.4);

        // Color key row
        const key = [
          { label: "16+", c: PALETTE.scoreRed },
          { label: "13–15", c: PALETTE.scoreOrange },
          { label: "9–12", c: PALETTE.scoreYellow },
          { label: "5–8", c: PALETTE.scoreGreen },
        ];

        let kx = lx2;
        const ky = doc.y + 6;

        key.forEach((it) => {
          doc.save();
          doc.rect(kx, ky, 18, 12).fill(it.c);
          doc.strokeColor(PALETTE.line).lineWidth(0.8).rect(kx, ky, 18, 12).stroke();
          doc.restore();

          doc
            .font("Helvetica")
            .fontSize(9.4)
            .fillColor(PALETTE.muted)
            .text(it.label, kx + 24, ky - 1, { width: 60 });

          kx += 90;
        });

        doc.y = ky + 22;
      }

      addFooter(doc, meta, integrityHash);

      /* ======================
         FINDINGS BY CATEGORY
      ====================== */
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
      bodyText(
        doc,
        "Personal-data signals are heuristic counts based on common field names. They are not legal classifications."
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
        "Accessibility checks are lightweight and indicative only. A full audit typically requires broader coverage and manual testing."
      );
      hr(doc);

      subTitle(doc, "Contact & identity signals");
      bulletList(doc, [`Contact/business identity signals: ${yesNo(!!signals?.contact?.detected)}`]);
      bodyText(doc, "Detected using simple patterns (email/phone/contact link) on the scanned surface only.");

      addFooter(doc, meta, integrityHash);

      /* ======================
         COMMON NEXT STEPS
      ====================== */
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

      /* ======================
         METHODOLOGY & LIMITATIONS
      ====================== */
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

      /* ======================
         VERIFICATION
      ====================== */
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
