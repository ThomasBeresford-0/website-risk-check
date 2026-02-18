// public/app.js
// FULL RAMBO — elite audit-style preview renderer + locked conversion flow (single + 3-pack)
// ✅ Consumes structured /preview-scan payload { ok, meta, coverage, signals, risk }
// ✅ Backwards-compatible with legacy flat payloads.
// ✅ No inline styles — relies on index.css classes.
// ✅ Renders: FREE PREVIEW banner + paywall box + risk badge + drivers + evidence cards + coverage log + limitations.
// ✅ Findings: highlights only (max 5) + collapsible technical details (no more ugly dump).

function getSid() {
  const key = "wrc_sid";
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid =
      (crypto?.randomUUID?.() || String(Math.random()).slice(2)) +
      "-" +
      Date.now();
    localStorage.setItem(key, sid);
  }
  return sid;
}

async function track(name, props = {}) {
  try {
    await fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ name, props, sid: getSid() }),
    });
  } catch {}
}

/* =========================
   UTIL
========================= */

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function truncate(str, max = 90) {
  const s = safeStr(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function normalizeInputUrl(raw) {
  const v = safeStr(raw).trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return safeStr(url);
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return safeStr(url) || "/";
  }
}

function bool(v) {
  return v === true;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatUtc(tsLike) {
  // Accept ISO string, seconds, or ms. Render: "18 Feb 2026, 20:04 UTC"
  const raw = safeStr(tsLike).trim();
  if (!raw) return "—";

  const n = Number(raw);
  let d = null;

  if (Number.isFinite(n) && raw.length >= 9) {
    const ms = n < 1e12 ? n * 1000 : n;
    d = new Date(ms);
  } else {
    const dd = new Date(raw);
    if (!Number.isNaN(dd.getTime())) d = dd;
  }

  if (!d || Number.isNaN(d.getTime())) return raw;

  try {
    return (
      d.toLocaleString("en-GB", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    );
  } catch {
    return d.toISOString();
  }
}

/* =========================
   INLINE NOTICE (NO ALERTS)
========================= */

function ensureNotice(previewEl) {
  let el = previewEl.querySelector("#wrcNotice");
  if (el) return el;

  el = document.createElement("div");
  el.id = "wrcNotice";
  el.className = "wrcNotice isHidden";
  previewEl.insertBefore(el, previewEl.firstChild);
  return el;
}

function showNotice(previewEl, tone, title, msg) {
  const el = ensureNotice(previewEl);
  el.classList.remove("isHidden");

  const t = safeStr(tone || "info").toLowerCase();
  el.classList.remove("isInfo", "isWarn", "isErr", "isOk");
  if (t === "warn") el.classList.add("isWarn");
  else if (t === "err") el.classList.add("isErr");
  else if (t === "ok") el.classList.add("isOk");
  else el.classList.add("isInfo");

  el.innerHTML = `
    <div class="wrcNoticeInner">
      <span class="wrcNoticeDot" aria-hidden="true"></span>
      <div class="wrcNoticeBody">
        <div class="wrcNoticeTitle">${escapeHtml(title || "Notice")}</div>
        <div class="wrcNoticeText">${escapeHtml(msg || "")}</div>
      </div>
    </div>
  `;
}

function hideNotice(previewEl) {
  const el = previewEl.querySelector("#wrcNotice");
  if (!el) return;
  el.classList.add("isHidden");
  el.innerHTML = "";
  el.classList.remove("isInfo", "isWarn", "isErr", "isOk");
}

/* =========================
   NORMALIZE BACKEND PAYLOAD
========================= */

function normalizePreviewPayload(data, fallbackUrl) {
  // Structured response (new)
  if (data && data.ok === true && data.meta && data.signals) {
    const meta = data.meta || {};
    const cov = data.coverage || {};
    const sig = data.signals || {};
    const risk = data.risk || {};

    return {
      // meta
      url: safeStr(meta.url) || safeStr(fallbackUrl),
      hostname:
        safeStr(meta.hostname) ||
        hostnameOf(safeStr(meta.url) || safeStr(fallbackUrl)),
      scannedAt: safeStr(meta.scannedAt),
      scanId: safeStr(meta.scanId),
      https: bool(meta.https),

      // risk
      riskLevel: safeStr(risk.level) || "Medium",
      riskScore: num(risk.score, 0),
      riskReasons: safeArr(risk.reasons)
        .map((s) => safeStr(s))
        .filter(Boolean),

      // coverage
      checkedPages: safeArr(cov.checkedPages),
      failedPages: safeArr(cov.failedPages),
      scanCoverageNotes: safeArr(cov.notes)
        .map((s) => safeStr(s))
        .filter(Boolean),
      fetchOk: safeArr(cov.checkedPages).length > 0,
      fetchStatus: num(cov.fetchStatus, 0),

      // signals (compat fields)
      hasPrivacyPolicy: bool(sig?.policies?.privacy),
      hasTerms: bool(sig?.policies?.terms),
      hasCookiePolicy: bool(sig?.policies?.cookies),
      hasCookieBanner: bool(sig?.consent?.bannerDetected),

      trackingScriptsDetected: safeArr(sig?.trackingScripts),
      cookieVendorsDetected: safeArr(sig?.consent?.vendors),

      formsDetected: num(sig?.forms?.detected, 0),
      formsPersonalDataSignals: num(sig?.forms?.personalDataSignals, 0),

      totalImages: num(sig?.accessibility?.images?.total, 0),
      imagesMissingAlt: num(sig?.accessibility?.images?.missingAlt, 0),

      accessibilityNotes: safeArr(sig?.accessibility?.notes),
      contactInfoPresent: bool(sig?.contact?.detected),

      _structured: true,
    };
  }

  // Legacy response (old)
  const url = safeStr(data?.url) || safeStr(fallbackUrl);
  return {
    url,
    hostname: safeStr(data?.hostname) || hostnameOf(url),
    scannedAt: safeStr(data?.scannedAt),
    scanId: safeStr(data?.scanId),
    https:
      typeof data?.https === "boolean" ? data.https : url.startsWith("https://"),

    riskLevel: safeStr(data?.riskLevel) || "Medium",
    riskScore: num(data?.riskScore, 0),
    riskReasons: safeArr(data?.riskReasons)
      .map((s) => safeStr(s))
      .filter(Boolean),

    fetchOk: typeof data?.fetchOk === "boolean" ? data.fetchOk : true,
    fetchStatus: num(data?.fetchStatus, 0),

    hasPrivacyPolicy: bool(data?.hasPrivacyPolicy),
    hasTerms: bool(data?.hasTerms),
    hasCookiePolicy: bool(data?.hasCookiePolicy),
    hasCookieBanner: bool(data?.hasCookieBanner),

    trackingScriptsDetected: safeArr(data?.trackingScriptsDetected),
    cookieVendorsDetected: safeArr(data?.cookieVendorsDetected),

    formsDetected: num(data?.formsDetected, 0),
    formsPersonalDataSignals: num(data?.formsPersonalDataSignals, 0),

    totalImages: num(data?.totalImages, 0),
    imagesMissingAlt: num(data?.imagesMissingAlt, 0),

    accessibilityNotes: safeArr(data?.accessibilityNotes),
    contactInfoPresent: bool(data?.contactInfoPresent),

    checkedPages: safeArr(data?.checkedPages),
    failedPages: safeArr(data?.failedPages),

    scanCoverageNotes: safeArr(data?.scanCoverageNotes),

    _structured: false,
  };
}

/* =========================
   CLIENT-FACING HIGHLIGHTS (FREE PREVIEW)
========================= */

function buildHighlightsFromScan(scan) {
  const highlights = [];

  const level = safeStr(scan.riskLevel || "").toLowerCase();
  if (level === "high")
    highlights.push(
      "Overall risk is HIGH based on detectable signals and coverage."
    );
  else if (level === "medium")
    highlights.push(
      "Overall risk is MEDIUM based on detectable signals and coverage."
    );
  else if (level === "low")
    highlights.push("Overall risk is LOW based on detectable signals and coverage.");

  const checked = safeArr(scan.checkedPages).length;
  const failed = safeArr(scan.failedPages).length;

  if (checked === 0) {
    highlights.push("We couldn’t retrieve enough public HTML to generate a reliable preview.");
  } else {
    highlights.push(
      `Coverage: ${checked} page${checked === 1 ? "" : "s"} checked${
        failed ? ` • ${failed} failed` : ""
      }.`
    );
  }

  if (!scan.hasPrivacyPolicy) highlights.push("Privacy policy not detected on scanned surface.");
  if (!scan.hasTerms) highlights.push("Terms not detected on scanned surface.");

  if (scan.hasCookieBanner) highlights.push("Consent banner indicator detected (heuristic).");
  else highlights.push("No consent banner indicator detected on scanned surface (heuristic).");

  const trackers = safeArr(scan.trackingScriptsDetected)
    .map((s) => safeStr(s))
    .filter(Boolean);
  if (trackers.length)
    highlights.push(
      `Tracking scripts detected: ${trackers.slice(0, 2).join(", ")}${
        trackers.length > 2 ? "…" : ""
      }.`
    );
  else highlights.push("No tracking scripts detected on scanned surface.");

  return highlights.slice(0, 5);
}

function renderFindingsFreePreview(findingsEl, scan, rawData) {
  // IMPORTANT: findingsEl is a <ul>. Only <li> children are valid.
  findingsEl.innerHTML = "";
  findingsEl.classList.add("wrcFindingsTight");

  const highlights = buildHighlightsFromScan(scan);

  // LI: Header (title + hint) — NO INLINE STYLES
  const liHead = document.createElement("li");
  liHead.className = "wrcFindingsHeadItem";
  liHead.innerHTML = `
    <div class="wrcFindingsHead">
      <div class="wrcFindingsTitle">Preview highlights</div>
      <div class="wrcFindingsHint">Client-safe summary. The sealed PDF contains full register, evidence, and verification.</div>
    </div>
  `;
  findingsEl.appendChild(liHead);

  // LI: Each highlight
  highlights.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = safeStr(t);
    findingsEl.appendChild(li);
  });

  // Technical details (collapsed) – inserted AFTER the list as a sibling block (not inside UL)
  const checked = safeArr(scan.checkedPages);
  const failed = safeArr(scan.failedPages);
  const notes = safeArr(scan.scanCoverageNotes);

  const checkedPaths = checked
    .map((p) => pathOf(p?.url))
    .filter(Boolean)
    .slice(0, 12);

  const failedPaths = failed
    .map((p) => {
      const pth = pathOf(p?.url);
      const st = num(p?.status, 0);
      return `${pth} (HTTP ${st || "?"})`;
    })
    .filter(Boolean)
    .slice(0, 12);

  const reasons = safeArr(rawData?.risk?.reasons)
    .map((s) => safeStr(s))
    .filter(Boolean);
  const fallbackReasons = safeArr(scan.riskReasons);
  const driverList = reasons.length ? reasons : fallbackReasons;

  const details = document.createElement("details");
  details.className = "wrcDetails";
  details.innerHTML = `
    <summary class="wrcDetailsSummary">
      Technical details (coverage + drivers)
      <span class="wrcDetailsChevron" aria-hidden="true"></span>
    </summary>
    <div class="wrcDetailsBody">
      <div class="wrcDetailsGrid">
        <div class="wrcDetailsBlock">
          <div class="wrcDetailsK">Checked</div>
          <div class="wrcDetailsV mono">${
            checkedPaths.length ? escapeHtml(checkedPaths.join(", ")) : "—"
          }</div>
        </div>
        <div class="wrcDetailsBlock">
          <div class="wrcDetailsK">Failed</div>
          <div class="wrcDetailsV mono">${
            failedPaths.length ? escapeHtml(failedPaths.join(", ")) : "None"
          }</div>
        </div>
        <div class="wrcDetailsBlock">
          <div class="wrcDetailsK">Drivers</div>
          <div class="wrcDetailsV">
            ${
              driverList.length
                ? `<ul class="wrcList">${driverList
                    .slice(0, 8)
                    .map((x) => `<li>${escapeHtml(x)}</li>`)
                    .join("")}</ul>`
                : `<div class="wrcEmpty">No explicit drivers returned for this scan.</div>`
            }
          </div>
        </div>
        <div class="wrcDetailsBlock">
          <div class="wrcDetailsK">Notes</div>
          <div class="wrcDetailsV">
            ${
              notes.length
                ? `<ul class="wrcList">${notes
                    .slice(0, 6)
                    .map((x) => `<li>${escapeHtml(x)}</li>`)
                    .join("")}</ul>`
                : `<div class="wrcEmpty">No additional coverage notes recorded.</div>`
            }
          </div>
        </div>
      </div>
    </div>
  `;

  findingsEl.insertAdjacentElement("afterend", details);
}

/* =========================
   PREMIUM AUDIT PREVIEW SHELL
========================= */

function ensurePreviewShell(previewEl, findingsEl) {
  if (previewEl.querySelector("[data-wrc-shell='1']")) return;

  const shell = document.createElement("div");
  shell.setAttribute("data-wrc-shell", "1");
  shell.className = "wrcShell";

  shell.innerHTML = `
    <section class="wrcPreviewHead" aria-label="Preview summary">
      <div class="wrcPreviewTop">
        <div class="wrcPreviewLeft">
          <div class="wrcKicker">Free preview</div>
          <div class="wrcTitle">What’s detectable right now (scope-locked)</div>
          <div class="wrcSub">
            This is a limited, client-safe preview. The paid report generates a sealed PDF, a permanent share link, and a public verification page.
          </div>
        </div>

        <div class="wrcPreviewRight" aria-label="Preview badges">
          <div class="wrcBadgePill isPreview">FREE PREVIEW</div>
          <div id="wrcRiskBadge" class="wrcBadgePill">Risk: —</div>
          <div id="wrcScopeBadge" class="wrcBadgePill isSoft">Coverage: —</div>
        </div>
      </div>

      <div class="wrcMetaRow" aria-label="Scan metadata">
        <div class="wrcMetaItem">
          <div class="wrcMetaK">Target</div>
          <div id="wrcMetaTarget" class="wrcMetaV mono">—</div>
        </div>
        <div class="wrcMetaItem">
          <div class="wrcMetaK">Captured (UTC)</div>
          <div id="wrcMetaTime" class="wrcMetaV mono">—</div>
        </div>
      </div>

      <div class="wrcPaywall" aria-label="Paywall message">
        <div class="wrcPaywallTitle">Unlock the sealed report (£99)</div>
        <ul class="wrcPaywallList">
          <li>Immutable timestamped PDF (client deliverable)</li>
          <li>Full risk register + scoring rationale</li>
          <li>Permanent share link <span class="mono">/r/:token</span></li>
          <li>Public verification <span class="mono">/verify/:hash</span></li>
        </ul>
      </div>
    </section>

    <section class="wrcSection" aria-label="Risk drivers">
      <div class="wrcSectionTop">
        <div class="wrcSectionTitle">Primary drivers</div>
        <div class="wrcSectionHint">Plain-English reasons behind the overall risk level.</div>
      </div>
      <div id="wrcDrivers" class="wrcDrivers"></div>
    </section>

    <section class="wrcSection" aria-label="Evidence snapshot">
      <div class="wrcSectionTop">
        <div class="wrcSectionTitle">Evidence snapshot</div>
        <div class="wrcSectionHint">Selected detectable signals from the scanned surface.</div>
      </div>

      <div id="wrcGrid" class="wrcGrid" aria-label="Evidence cards"></div>
      <div id="wrcCoverage" class="wrcCoverage" aria-label="Coverage summary"></div>
      <div id="wrcConfidence" class="wrcConfidence" aria-label="Limitations"></div>
    </section>

    <div class="wrcDivider"></div>
  `;

  findingsEl.parentNode.insertBefore(shell, findingsEl);
}

function setRiskBadge(previewEl, level) {
  const el = previewEl.querySelector("#wrcRiskBadge");
  if (!el) return;

  const v = safeStr(level).toLowerCase();
  el.classList.remove("isLow", "isMedium", "isHigh");
  let label = "—";

  if (v === "low") {
    el.classList.add("isLow");
    label = "Low";
  } else if (v === "medium") {
    el.classList.add("isMedium");
    label = "Medium";
  } else if (v === "high") {
    el.classList.add("isHigh");
    label = "High";
  }

  el.textContent = `Risk: ${label}`;
}

function setScopeBadge(previewEl, checkedPages, failedPages) {
  const el = previewEl.querySelector("#wrcScopeBadge");
  if (!el) return;

  const checked = safeArr(checkedPages).length;
  const failed = safeArr(failedPages).length;

  const parts = [];
  if (checked) parts.push(`${checked} page${checked === 1 ? "" : "s"} checked`);
  if (failed) parts.push(`${failed} failed`);

  el.textContent = `Coverage: ${parts.join(" • ") || "—"}`;
}

function setMeta(previewEl, scan) {
  const t = previewEl.querySelector("#wrcMetaTarget");
  const time = previewEl.querySelector("#wrcMetaTime");
  if (t) t.textContent = hostnameOf(scan.url || "");
  if (time) time.textContent = formatUtc(scan.scannedAt);
}

function renderDrivers(previewEl, scan, rawData) {
  const el = previewEl.querySelector("#wrcDrivers");
  if (!el) return;

  const structuredReasons = safeArr(rawData?.risk?.reasons)
    .map((s) => safeStr(s))
    .filter(Boolean);

  const reasons = structuredReasons.length ? structuredReasons : safeArr(scan.riskReasons);

  el.innerHTML = "";

  if (!reasons.length) {
    const empty = document.createElement("div");
    empty.className = "wrcEmpty";
    empty.textContent =
      "No explicit drivers were returned for this scan. The paid report still records coverage and detectable signals at the captured timestamp.";
    el.appendChild(empty);
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "wrcList";
  reasons.slice(0, 6).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

function renderGrid(previewEl, scan) {
  const grid = previewEl.querySelector("#wrcGrid");
  if (!grid) return;

  const trackers = safeArr(scan.trackingScriptsDetected)
    .map((s) => safeStr(s))
    .filter(Boolean);

  const vendors = safeArr(scan.cookieVendorsDetected)
    .map((s) => safeStr(s))
    .filter(Boolean);

  const totalImages = num(scan.totalImages, 0);
  const missingAlt = num(scan.imagesMissingAlt, 0);

  const policiesOk = scan.hasPrivacyPolicy && scan.hasTerms;
  const identityOk = scan.contactInfoPresent && scan.https;

  const cells = [
    {
      title: "Policies",
      status: policiesOk ? "OK" : "Review",
      tone: policiesOk ? "ok" : "warn",
      lines: [
        `Privacy: ${scan.hasPrivacyPolicy ? "Detected" : "Not detected"}`,
        `Terms: ${scan.hasTerms ? "Detected" : "Not detected"}`,
        `Cookie policy: ${scan.hasCookiePolicy ? "Detected" : "Not detected"}`,
      ],
    },
    {
      title: "Consent signals",
      status: scan.hasCookieBanner ? "OK" : "Review",
      tone: scan.hasCookieBanner ? "ok" : "warn",
      lines: [
        `Banner indicator: ${scan.hasCookieBanner ? "Detected" : "Not detected"} (heuristic)`,
        vendors.length
          ? `Vendors: ${vendors.slice(0, 3).join(", ")}${vendors.length > 3 ? "…" : ""}`
          : "Vendors: none detected",
      ],
    },
    {
      title: "Tracking",
      status: trackers.length || vendors.length ? "Review" : "OK",
      tone: trackers.length || vendors.length ? "warn" : "ok",
      lines: [
        trackers.length
          ? `Scripts: ${trackers.slice(0, 3).join(", ")}${trackers.length > 3 ? "…" : ""}`
          : "Scripts: none detected",
        vendors.length ? `Vendor signals: ${vendors.length}` : "Vendor signals: 0",
      ],
    },
    {
      title: "Forms & data capture",
      status: num(scan.formsDetected, 0) > 0 ? "Review" : "OK",
      tone: num(scan.formsDetected, 0) > 0 ? "warn" : "ok",
      lines: [
        `Forms detected: ${num(scan.formsDetected, 0)}`,
        `Personal-data signals: ${num(scan.formsPersonalDataSignals, 0)} (heuristic)`,
      ],
    },
    {
      title: "Accessibility",
      status: missingAlt > 0 ? "Review" : "OK",
      tone: missingAlt > 0 ? "warn" : "ok",
      lines: [
        totalImages > 0
          ? `Alt text missing: ${missingAlt} of ${totalImages}`
          : "Images: none detected on scanned pages",
        safeArr(scan.accessibilityNotes).length
          ? `Note: ${truncate(scan.accessibilityNotes[0], 80)}`
          : "Notes: none recorded",
      ],
    },
    {
      title: "Identity & transport",
      status: identityOk ? "OK" : "Review",
      tone: identityOk ? "ok" : "warn",
      lines: [
        `Contact signals: ${scan.contactInfoPresent ? "Detected" : "Not detected"}`,
        `HTTPS: ${scan.https ? "Detected" : "Not detected"}`,
      ],
    },
  ];

  grid.innerHTML = "";

  for (const c of cells) {
    const card = document.createElement("div");
    card.className = `wrcCard wrcCard--${c.tone}`;

    card.innerHTML = `
      <div class="wrcCardTop">
        <div class="wrcCardTitle">${escapeHtml(c.title)}</div>
        <div class="wrcCardPill">${escapeHtml(c.status)}</div>
      </div>
      <div class="wrcCardBody">
        ${c.lines.map((ln) => `<div class="wrcCardLine">${escapeHtml(ln)}</div>`).join("")}
      </div>
    `;

    grid.appendChild(card);
  }
}

function renderCoverage(previewEl, scan) {
  const box = previewEl.querySelector("#wrcCoverage");
  if (!box) return;

  const checked = safeArr(scan.checkedPages);
  const failed = safeArr(scan.failedPages);
  const notes = safeArr(scan.scanCoverageNotes);

  const checkedPaths = checked
    .map((p) => pathOf(p?.url))
    .filter(Boolean)
    .slice(0, 10);

  const failedPaths = failed
    .map((p) => {
      const pth = pathOf(p?.url);
      const st = num(p?.status, 0);
      return `${pth} (HTTP ${st || "?"})`;
    })
    .filter(Boolean)
    .slice(0, 10);

  const noteItems = notes
    .map((n) => safeStr(n))
    .filter(Boolean)
    .slice(0, 6);

  box.innerHTML = `
    <div class="wrcCoverageTop">
      <div class="wrcCoverageTitle">Coverage log (preview)</div>
      <div class="wrcCoverageHint">Scope-locked, same-origin, public HTML only.</div>
    </div>

    <div class="wrcCoverageGrid">
      <div class="wrcCoverageBlock">
        <div class="wrcCoverageK">Checked</div>
        <div class="wrcCoverageV mono">${
          checkedPaths.length ? escapeHtml(checkedPaths.join(", ")) : "—"
        }</div>
      </div>

      <div class="wrcCoverageBlock">
        <div class="wrcCoverageK">Failed</div>
        <div class="wrcCoverageV mono">${
          failedPaths.length ? escapeHtml(failedPaths.join(", ")) : "None"
        }</div>
      </div>

      <div class="wrcCoverageBlock">
        <div class="wrcCoverageK">Coverage notes</div>
        <div class="wrcCoverageV">
          ${
            noteItems.length
              ? `<ul class="wrcList">${noteItems
                  .map((x) => `<li>${escapeHtml(x)}</li>`)
                  .join("")}</ul>`
              : `<div class="wrcEmpty">No additional coverage notes were recorded for this scan.</div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderConfidence(previewEl, scan) {
  const el = previewEl.querySelector("#wrcConfidence");
  if (!el) return;

  const ok = scan.fetchOk !== false;
  const checked = safeArr(scan.checkedPages).length;
  const failed = safeArr(scan.failedPages).length;

  let msg =
    "Limitations: This preview reflects what was detectable at capture time. It is not a legal opinion, certification, or monitoring.";

  if (!ok || checked === 0) {
    msg =
      "Limitations: We couldn’t retrieve enough HTML to generate a reliable preview. Try again, check the URL, or test a different page. Paid reports require sufficient coverage to seal the snapshot.";
  } else if (checked <= 1) {
    msg =
      "Limitations: Coverage is limited. Some signals may exist elsewhere (e.g., footer policies). The paid report records coverage explicitly and includes verification.";
  } else if (failed) {
    msg =
      "Limitations: Some standard pages could not be retrieved; this may reduce detection coverage. The paid report records coverage and failures explicitly.";
  }

  el.textContent = msg;
}

/* =========================
   MAIN
========================= */

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");
  const preview = document.getElementById("preview");
  const findingsEl = document.getElementById("findings");
  const resultsSection = document.getElementById("results");
  const resultsEmpty = document.getElementById("resultsEmpty");

  const payButton = document.getElementById("pay-button");
  const threepackButton = document.getElementById("threepack-button");

  let scannedUrl = null;
  let isScanning = false;
  let isPayingSingle = false;
  let isPayingThreepack = false;

  track("landing_view", { path: location.pathname });

  if (!form || !input || !preview || !findingsEl || !payButton) return;

  function setPayButtonsEnabled(enabled) {
    payButton.disabled = !enabled;
    if (threepackButton) threepackButton.disabled = !enabled;
  }

  function resetPayButtonsText() {
    payButton.textContent = "Download full PDF report (£99)";
    if (threepackButton) threepackButton.textContent = "Best value: 3 reports (£199)";
  }

  function setScanningUi(isBusy) {
    const scanBtn = document.getElementById("scanBtn");
    if (!scanBtn) return;
    scanBtn.disabled = isBusy;
    scanBtn.textContent = isBusy ? "Scanning… (up to ~10s)" : "Run free scan";
  }

  function setCheckoutUi(kind, isBusy) {
    if (kind === "single") {
      payButton.textContent = isBusy
        ? "Redirecting to secure checkout…"
        : "Download full PDF report (£99)";
    }
    if (kind === "threepack" && threepackButton) {
      threepackButton.textContent = isBusy
        ? "Redirecting to secure checkout…"
        : "Best value: 3 reports (£199)";
    }
  }

  // Initial state
  setPayButtonsEnabled(false);
  resetPayButtonsText();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const url = normalizeInputUrl(input.value);
    if (!url) {
      showNotice(preview, "warn", "Enter a website URL", "Type a domain (e.g. example.com) and run the free scan.");
      try { (resultsSection || preview).scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}
      return;
    }

    isScanning = true;
    scannedUrl = url;

    track("preview_started", {});

    if (resultsEmpty) resultsEmpty.style.display = "none";
    showNotice(preview, "ok", "Scan started", "Fetching public pages and assembling your preview…");
    preview.style.display = "block";
    try { (resultsSection || preview).scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}

    preview.style.display = "none";
    findingsEl.innerHTML = "";
    setPayButtonsEnabled(false);
    resetPayButtonsText();
    setScanningUi(true);
    hideNotice(preview);

    // Clear any previous sibling technical details
    const staleDetails = findingsEl.parentNode?.querySelector(".wrcDetails");
    if (staleDetails) staleDetails.remove();

    try {
      const res = await fetch("/preview-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (res.status === 429) {
        showNotice(preview, "warn", "You’re scanning too quickly", "Please wait a moment and try again.");
        track("preview_rate_limited", {});
        return;
      }

      if (!res.ok) {
        showNotice(
          preview,
          "err",
          "Preview unavailable",
          "We couldn’t generate a preview for that URL. Please double-check the address and try again."
        );
        track("preview_failed", { status: res.status });
        return;
      }

      const data = await res.json();

      ensurePreviewShell(preview, findingsEl);

      const scan = normalizePreviewPayload(data, url);

      if (scan.fetchOk === false || safeArr(scan.checkedPages).length === 0) {
        showNotice(
          preview,
          "warn",
          "Limited coverage",
          "We couldn’t retrieve enough public HTML to run a reliable preview. Try again, verify the URL, or test a different page."
        );
      } else {
        hideNotice(preview);
      }

      setMeta(preview, scan);
      setRiskBadge(preview, scan.riskLevel);
      setScopeBadge(preview, scan.checkedPages, scan.failedPages);
      renderDrivers(preview, scan, data);
      renderGrid(preview, scan);
      renderCoverage(preview, scan);
      renderConfidence(preview, scan);

      // Remove old details again (in case shell exists already)
      const oldDetails = findingsEl.parentNode?.querySelector(".wrcDetails");
      if (oldDetails) oldDetails.remove();

      renderFindingsFreePreview(findingsEl, scan, data);

      if (resultsEmpty) resultsEmpty.style.display = "none";

      preview.style.display = "block";
      setPayButtonsEnabled(true);

      try {
        (resultsSection || preview).scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {}

      track("preview_completed", {
        risk: scan.riskLevel,
        checked_pages: safeArr(scan.checkedPages).length,
        failed_pages: safeArr(scan.failedPages).length,
      });
    } catch (err) {
      console.error(err);
      showNotice(preview, "err", "Something went wrong", "The preview request failed. Please try again in a moment.");
      track("preview_failed", { err: safeStr(err?.message) });
    } finally {
      isScanning = false;
      setScanningUi(false);
    }
  });

  payButton.addEventListener("click", async () => {
    if (!scannedUrl || isPayingSingle || isPayingThreepack) return;

    isPayingSingle = true;
    setPayButtonsEnabled(false);
    setCheckoutUi("single", true);
    hideNotice(preview);

    track("checkout_started", { kind: "single" });

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scannedUrl }),
      });

      if (!res.ok) {
        showNotice(preview, "err", "Checkout unavailable", "We couldn’t start Stripe checkout right now. Please try again.");
        track("checkout_failed", { kind: "single", status: res.status });
        setPayButtonsEnabled(true);
        setCheckoutUi("single", false);
        isPayingSingle = false;
        return;
      }

      const data = await res.json();
      if (!data.url) {
        showNotice(preview, "err", "Checkout error", "Stripe checkout did not return a redirect URL. Please try again.");
        track("checkout_failed", { kind: "single", reason: "no_url" });
        setPayButtonsEnabled(true);
        setCheckoutUi("single", false);
        isPayingSingle = false;
        return;
      }

      track("checkout_redirected", { kind: "single" });
      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      showNotice(preview, "err", "Checkout failed", "We couldn’t start checkout. Please try again.");
      setPayButtonsEnabled(true);
      setCheckoutUi("single", false);
      isPayingSingle = false;
      track("checkout_failed", { kind: "single", err: safeStr(err?.message) });
    }
  });

  if (threepackButton) {
    threepackButton.addEventListener("click", async () => {
      if (!scannedUrl || isPayingThreepack || isPayingSingle) return;

      isPayingThreepack = true;
      setPayButtonsEnabled(false);
      setCheckoutUi("threepack", true);
      hideNotice(preview);

      track("checkout_started", { kind: "threepack" });

      try {
        const res = await fetch("/create-threepack-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: scannedUrl }),
        });

        if (!res.ok) {
          showNotice(preview, "err", "Checkout unavailable", "We couldn’t start Stripe checkout right now. Please try again.");
          track("checkout_failed", { kind: "threepack", status: res.status });
          setPayButtonsEnabled(true);
          setCheckoutUi("threepack", false);
          isPayingThreepack = false;
          return;
        }

        const data = await res.json();
        if (!data.url) {
          showNotice(preview, "err", "Checkout error", "Stripe checkout did not return a redirect URL. Please try again.");
          track("checkout_failed", { kind: "threepack", reason: "no_url" });
          setPayButtonsEnabled(true);
          setCheckoutUi("threepack", false);
          isPayingThreepack = false;
          return;
        }

        track("checkout_redirected", { kind: "threepack" });
        window.location.href = data.url;
      } catch (err) {
        console.error(err);
        showNotice(preview, "err", "Checkout failed", "We couldn’t start checkout. Please try again.");
        setPayButtonsEnabled(true);
        setCheckoutUi("threepack", false);
        isPayingThreepack = false;
        track("checkout_failed", { kind: "threepack", err: safeStr(err?.message) });
      }
    });
  }
});
