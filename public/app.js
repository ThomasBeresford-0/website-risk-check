// public/app.js
// FULL RAMBO — elite preview renderer + locked conversion flow (single + 3-pack)
// - Premium preview UI (risk badge + category grid + coverage + inline notices)
// - Calm, non-fear language
// - No new HTML required (injects UI above #findings)
// - Works even if 3-pack button not present
// - Removes alert() (trust-killer) and uses in-card banners instead
// - Hardened URL handling + better UX states

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
  return typeof v === "string" ? v : "";
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function truncate(str, max = 80) {
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

function fmtHttpStatus(st) {
  const n = Number(st);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  return String(n);
}

/* =========================
   INLINE NOTICE (NO ALERTS)
========================= */

function ensureNotice(previewEl) {
  // Banner shown inside the scan card / preview area
  let el = previewEl.querySelector("#wrcNotice");
  if (el) return el;

  el = document.createElement("div");
  el.id = "wrcNotice";
  el.style.display = "none";
  el.style.margin = "12px 0 0";
  el.style.padding = "12px 14px";
  el.style.borderRadius = "14px";
  el.style.border = "1px solid #e5e7eb";
  el.style.background = "#f8fafc";
  el.style.color = "#0f172a";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.45";

  // Put it at the top of preview block for maximum visibility
  previewEl.insertBefore(el, previewEl.firstChild);
  return el;
}

function showNotice(previewEl, tone, title, msg) {
  const el = ensureNotice(previewEl);

  const tones = {
    info: { bg: "#eff6ff", br: "#bfdbfe", fg: "#1d4ed8", dot: "#2563eb" },
    warn: { bg: "#fffbeb", br: "#fde68a", fg: "#92400e", dot: "#d97706" },
    err: { bg: "#fef2f2", br: "#fecaca", fg: "#991b1b", dot: "#dc2626" },
    ok: { bg: "#ecfdf5", br: "#a7f3d0", fg: "#065f46", dot: "#16a34a" },
  };

  const t = tones[tone] || tones.info;

  el.style.display = "block";
  el.style.background = t.bg;
  el.style.borderColor = t.br;
  el.style.color = "#0f172a";

  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start;">
      <span aria-hidden="true" style="width:10px;height:10px;border-radius:999px;background:${t.dot};margin-top:4px;flex:0 0 auto;"></span>
      <div>
        <div style="font-weight:800;color:${t.fg};">${safeStr(title) || "Notice"}</div>
        <div style="margin-top:4px;color:#0f172a;">${safeStr(msg) || ""}</div>
      </div>
    </div>
  `;
}

function hideNotice(previewEl) {
  const el = previewEl.querySelector("#wrcNotice");
  if (!el) return;
  el.style.display = "none";
  el.innerHTML = "";
}

/* =========================
   PREMIUM PREVIEW RENDERER
========================= */

function ensurePreviewShell(previewEl, findingsEl) {
  // Inject a premium preview header + cards area ABOVE the old <ul> (only once).
  if (previewEl.querySelector("[data-wrc-shell='1']")) return;

  const shell = document.createElement("div");
  shell.setAttribute("data-wrc-shell", "1");

  shell.innerHTML = `
    <div class="wrcSummary" style="margin: 10px 0 14px;">
      <div class="wrcSummaryTop" style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          <div class="wrcKicker" style="font-size:12px;color:#64748b;font-weight:700;letter-spacing:0.02em;text-transform:uppercase;">
            Snapshot preview
          </div>
          <div class="wrcTitle" style="margin-top:6px;font-size:16px;font-weight:800;color:#0f172a;">
            Detected signals (point-in-time)
          </div>
          <div class="wrcSub" style="margin-top:6px;font-size:13px;color:#64748b;line-height:1.45;">
            This preview shows a small subset of what’s detectable. The paid report includes coverage notes, plain-English explanations, limitations and verification.
          </div>
        </div>

        <div class="wrcBadges" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <span id="wrcRiskBadge"
            style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;
                   background:#f1f5f9;border:1px solid #e5e7eb;color:#0f172a;font-size:13px;font-weight:800;">
            Risk: —
          </span>
          <span id="wrcScopeBadge"
            style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;
                   background:#ffffff;border:1px solid #e5e7eb;color:#0f172a;font-size:13px;font-weight:700;">
            Coverage: —
          </span>
        </div>
      </div>

      <div id="wrcGrid"
        style="margin-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">
      </div>

      <div id="wrcCoverage"
        style="margin-top:14px;padding:12px 14px;border-radius:14px;border:1px solid #e5e7eb;background:#f8fafc;">
      </div>

      <div id="wrcConfidence"
        style="margin-top:10px;font-size:12.5px;color:#64748b;line-height:1.45;">
      </div>

      <div style="margin-top:14px;border-top:1px solid #e5e7eb;padding-top:14px;"></div>
    </div>
  `;

  // Insert shell before findings list
  findingsEl.parentNode.insertBefore(shell, findingsEl);
}

function setRiskBadge(previewEl, level) {
  const el = previewEl.querySelector("#wrcRiskBadge");
  if (!el) return;

  const v = safeStr(level).toLowerCase();
  let bg = "#f1f5f9";
  let br = "#e5e7eb";
  let fg = "#0f172a";
  let dot = "#94a3b8";
  let label = "—";

  if (v === "low") {
    bg = "#ecfdf5";
    br = "#a7f3d0";
    fg = "#065f46";
    dot = "#16a34a";
    label = "Low";
  } else if (v === "medium") {
    bg = "#fffbeb";
    br = "#fde68a";
    fg = "#92400e";
    dot = "#d97706";
    label = "Medium";
  } else if (v === "high") {
    bg = "#fef2f2";
    br = "#fecaca";
    fg = "#991b1b";
    dot = "#dc2626";
    label = "High";
  }

  el.innerHTML = `<span aria-hidden="true" style="width:8px;height:8px;border-radius:999px;background:${dot};display:inline-block;"></span> Risk: ${label}`;
  el.style.background = bg;
  el.style.borderColor = br;
  el.style.color = fg;
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

function renderGrid(previewEl, scan) {
  const grid = previewEl.querySelector("#wrcGrid");
  if (!grid) return;

  const trackers = safeArr(scan.trackingScriptsDetected);
  const vendors = safeArr(scan.cookieVendorsDetected);

  const cells = [
    {
      title: "Policies",
      lines: [
        `Privacy: ${scan.hasPrivacyPolicy ? "Detected" : "Not detected"}`,
        `Terms: ${scan.hasTerms ? "Detected" : "Not detected"}`,
        `Cookie policy: ${scan.hasCookiePolicy ? "Detected" : "Not detected"}`,
      ],
      good: !!scan.hasPrivacyPolicy && !!scan.hasTerms,
    },
    {
      title: "Consent",
      lines: [
        `Banner indicator: ${scan.hasCookieBanner ? "Detected" : "Not detected"}`,
        vendors.length
          ? `Vendor signals: ${vendors.slice(0, 2).join(", ")}${
              vendors.length > 2 ? "…" : ""
            }`
          : "Vendor signals: None detected",
      ],
      good: !!scan.hasCookieBanner,
    },
    {
      title: "Tracking",
      lines: [
        trackers.length
          ? `Scripts: ${trackers.slice(0, 2).join(", ")}${
              trackers.length > 2 ? "…" : ""
            }`
          : "Scripts: None detected",
        vendors.length ? `Vendors: ${vendors.length}` : "Vendors: 0",
      ],
      good: !trackers.length && !vendors.length,
    },
    {
      title: "Forms",
      lines: [
        `Forms detected: ${Number(scan.formsDetected || 0)}`,
        `Personal-data signals: ${Number(
          scan.formsPersonalDataSignals || 0
        )} (heuristic)`,
      ],
      good: Number(scan.formsDetected || 0) === 0,
    },
    {
      title: "Accessibility",
      lines: [
        `Alt text missing: ${Number(scan.imagesMissingAlt || 0)} of ${Number(
          scan.totalImages || 0
        )}`,
        safeArr(scan.accessibilityNotes).length
          ? `Notes: ${truncate(scan.accessibilityNotes[0], 52)}`
          : "Notes: None recorded",
      ],
      good: Number(scan.imagesMissingAlt || 0) === 0,
    },
    {
      title: "Identity",
      lines: [
        `Contact signals: ${
          scan.contactInfoPresent ? "Detected" : "Not detected"
        }`,
        `HTTPS: ${scan.https ? "Detected" : "Not detected"}`,
      ],
      good: !!scan.contactInfoPresent && !!scan.https,
    },
  ];

  grid.innerHTML = "";

  for (const c of cells) {
    const card = document.createElement("div");
    card.style.border = "1px solid #e5e7eb";
    card.style.borderRadius = "14px";
    card.style.background = "#ffffff";
    card.style.padding = "12px 14px";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "6px";

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.alignItems = "center";
    top.style.justifyContent = "space-between";
    top.style.gap = "10px";

    const title = document.createElement("div");
    title.textContent = c.title;
    title.style.fontWeight = "800";
    title.style.fontSize = "13px";
    title.style.color = "#0f172a";

    const pill = document.createElement("span");
    pill.textContent = c.good ? "OK" : "Review";
    pill.style.fontSize = "12px";
    pill.style.fontWeight = "800";
    pill.style.padding = "6px 10px";
    pill.style.borderRadius = "999px";
    pill.style.border = "1px solid #e5e7eb";
    pill.style.background = c.good ? "#ecfdf5" : "#fffbeb";
    pill.style.color = c.good ? "#065f46" : "#92400e";

    top.appendChild(title);
    top.appendChild(pill);

    const body = document.createElement("div");
    body.style.fontSize = "12.5px";
    body.style.color = "#475569";
    body.style.lineHeight = "1.45";

    for (const line of c.lines) {
      const row = document.createElement("div");
      row.textContent = line;
      body.appendChild(row);
    }

    card.appendChild(top);
    card.appendChild(body);
    grid.appendChild(card);
  }

  // responsive tweak
  const mq = window.matchMedia("(max-width: 560px)");
  const applyCols = () => {
    grid.style.gridTemplateColumns = mq.matches
      ? "1fr"
      : "repeat(2, minmax(0, 1fr))";
  };
  applyCols();
  mq.addEventListener?.("change", applyCols);
}

function renderCoverage(previewEl, scan) {
  const box = previewEl.querySelector("#wrcCoverage");
  if (!box) return;

  const checked = safeArr(scan.checkedPages);
  const failed = safeArr(scan.failedPages);

  const checkedPaths = checked
    .map((p) => {
      try {
        return new URL(p.url).pathname || "/";
      } catch {
        return "/";
      }
    })
    .slice(0, 8);

  const failedPaths = failed
    .map((p) => {
      try {
        const path = new URL(p.url).pathname || "/";
        const st = p.status || 0;
        return `${path} (HTTP ${st || "?"})`;
      } catch {
        return `unknown (HTTP ${p.status || "?"})`;
      }
    })
    .slice(0, 8);

  const domain = hostnameOf(scan.url || "");

  box.innerHTML = `
    <div style="font-weight:800;color:#0f172a;font-size:13px;">Coverage summary</div>
    <div style="margin-top:6px;font-size:12.5px;color:#475569;line-height:1.45;">
      <div><strong>Target:</strong> ${domain}</div>
      <div><strong>Checked:</strong> ${
        checkedPaths.length ? checkedPaths.join(", ") : "—"
      }</div>
      <div><strong>Failed:</strong> ${
        failedPaths.length ? failedPaths.join(", ") : "None"
      }</div>
    </div>
  `;
}

function renderConfidence(previewEl, scan) {
  const el = previewEl.querySelector("#wrcConfidence");
  if (!el) return;

  const ok = scan.fetchOk !== false;
  const checked = safeArr(scan.checkedPages).length;
  const failed = safeArr(scan.failedPages).length;

  let msg = "This preview reflects what was detectable at the time of scanning.";
  if (!ok) {
    msg =
      "We couldn’t retrieve enough HTML to generate a reliable preview. Try again, check the URL, or test a different page.";
  } else if (checked <= 1) {
    msg =
      "Coverage is limited. Some signals may exist elsewhere (e.g., footer policies). The paid report records coverage explicitly and includes verification.";
  } else if (failed) {
    msg =
      "Some standard pages could not be retrieved; this may reduce detection coverage. The paid report records coverage and failures explicitly.";
  }

  el.textContent = msg;
}

function renderLegacyFindingsList(findingsEl, findings) {
  findingsEl.innerHTML = "";
  safeArr(findings).forEach((text) => {
    const li = document.createElement("li");
    li.textContent = safeStr(text);
    findingsEl.appendChild(li);
  });
}

/* =========================
   MAIN
========================= */

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");
  const preview = document.getElementById("preview");
  const findingsEl = document.getElementById("findings");

  const payButton = document.getElementById("pay-button"); // single report
  const threepackButton = document.getElementById("threepack-button"); // optional

  let scannedUrl = null;
  let isScanning = false;
  let isPayingSingle = false;
  let isPayingThreepack = false;

  track("landing_view", { path: location.pathname });

  // Single button is required, 3-pack may not exist on older pages
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
    scanBtn.textContent = isBusy ? "Scanning…" : "Run free scan";
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const url = normalizeInputUrl(input.value);
    if (!url) return;

    isScanning = true;
    scannedUrl = url;

    track("preview_started", {});

    preview.style.display = "none";
    findingsEl.innerHTML = "";
    setPayButtonsEnabled(false);
    resetPayButtonsText();
    setScanningUi(true);
    hideNotice(preview);

    try {
      const res = await fetch("/preview-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (res.status === 429) {
        showNotice(
          preview,
          "warn",
          "You’re scanning too quickly",
          "Please wait a moment and try again."
        );
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

      // Elite shell + rendering (works even if backend is old)
      ensurePreviewShell(preview, findingsEl);

      // If backend returns new fields, use them. Otherwise infer minimal state.
      const scan = {
        url: data.url || url,
        hostname: data.hostname,
        scannedAt: data.scannedAt,
        riskLevel: data.riskLevel,

        https: data.https,
        fetchOk: data.fetchOk,
        fetchStatus: data.fetchStatus,

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

        checkedPages: data.checkedPages,
        failedPages: data.failedPages,
      };

      // Fallbacks if backend still only returns findings[]
      if (typeof scan.https !== "boolean") scan.https = url.startsWith("https://");
      if (typeof scan.fetchOk !== "boolean") scan.fetchOk = true;
      if (!scan.riskLevel) scan.riskLevel = "Medium";

      // If backend indicates fetch failure, show a clear (non-fear) banner
      if (scan.fetchOk === false) {
        showNotice(
          preview,
          "warn",
          "Limited coverage",
          `We couldn’t retrieve enough HTML to run a full preview (HTTP ${fmtHttpStatus(
            scan.fetchStatus
          )}). You can still try again or test a different URL.`
        );
      } else {
        hideNotice(preview);
      }

      // Render premium pieces
      setRiskBadge(preview, scan.riskLevel);
      setScopeBadge(preview, scan.checkedPages, scan.failedPages);
      renderGrid(preview, scan);
      renderCoverage(preview, scan);
      renderConfidence(preview, scan);

      // Keep legacy bullet list as a secondary detail area
      renderLegacyFindingsList(findingsEl, data.findings || []);

      preview.style.display = "block";
      setPayButtonsEnabled(true);

      track("preview_completed", {
        findings_count: safeArr(data.findings).length,
        risk: scan.riskLevel,
      });
    } catch (err) {
      console.error(err);
      showNotice(
        preview,
        "err",
        "Something went wrong",
        "The preview request failed. Please try again in a moment."
      );
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
        showNotice(
          preview,
          "err",
          "Checkout unavailable",
          "We couldn’t start Stripe checkout right now. Please try again."
        );
        track("checkout_failed", { kind: "single", status: res.status });
        setPayButtonsEnabled(true);
        setCheckoutUi("single", false);
        isPayingSingle = false;
        return;
      }

      const data = await res.json();
      if (!data.url) {
        showNotice(
          preview,
          "err",
          "Checkout error",
          "Stripe checkout did not return a redirect URL. Please try again."
        );
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
      showNotice(
        preview,
        "err",
        "Checkout failed",
        "We couldn’t start checkout. Please try again."
      );
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
          showNotice(
            preview,
            "err",
            "Checkout unavailable",
            "We couldn’t start Stripe checkout right now. Please try again."
          );
          track("checkout_failed", { kind: "threepack", status: res.status });
          setPayButtonsEnabled(true);
          setCheckoutUi("threepack", false);
          isPayingThreepack = false;
          return;
        }

        const data = await res.json();
        if (!data.url) {
          showNotice(
            preview,
            "err",
            "Checkout error",
            "Stripe checkout did not return a redirect URL. Please try again."
          );
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
        showNotice(
          preview,
          "err",
          "Checkout failed",
          "We couldn’t start checkout. Please try again."
        );
        setPayButtonsEnabled(true);
        setCheckoutUi("threepack", false);
        isPayingThreepack = false;
        track("checkout_failed", { kind: "threepack", err: safeStr(err?.message) });
      }
    });
  }
});
