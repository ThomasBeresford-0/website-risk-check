// public/threepack.js
// FULL RAMBO — redeem 3-pack and list generated report links (no alerts, calm UX)

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

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session_id");

const statusPill = document.getElementById("statusPill");
const redeemBtn = document.getElementById("redeem");
const urlInput = document.getElementById("url");
const reportsEl = document.getElementById("reports");

let packToken = "";
let remainingSnapshots = 0;
let isLoading = false;
let isRedeeming = false;

/* =========================
   INLINE NOTICE (NO ALERTS)
========================= */

function ensureNotice() {
  const anchor =
    document.getElementById("threepack-card") ||
    document.querySelector("main") ||
    document.body;

  let el = document.getElementById("wrcThreepackNotice");
  if (el) return el;

  el = document.createElement("div");
  el.id = "wrcThreepackNotice";
  el.style.display = "none";
  el.style.margin = "14px 0";
  el.style.padding = "12px 14px";
  el.style.borderRadius = "14px";
  el.style.border = "1px solid #e5e7eb";
  el.style.background = "#f8fafc";
  el.style.color = "#0f172a";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.45";

  // Safest insertion
  if (typeof anchor.prepend === "function") {
    anchor.prepend(el);
  } else {
    anchor.insertBefore(el, anchor.firstChild || null);
  }

  return el;
}

function showNotice(tone, title, msg) {
  const el = ensureNotice();

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
        <div style="font-weight:800;color:${t.fg};">${String(title || "Notice")}</div>
        <div style="margin-top:4px;color:#0f172a;">${String(msg || "")}</div>
      </div>
    </div>
  `;
}

function hideNotice() {
  const el = document.getElementById("wrcThreepackNotice");
  if (!el) return;
  el.style.display = "none";
  el.innerHTML = "";
}

/* =========================
   UTIL
========================= */

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {}
  try {
    return new URL(`https://${String(input).trim()}`).toString();
  } catch {}
  return "";
}

function setBusy(btn, isBusy, textBusy, textIdle) {
  if (!btn) return;
  btn.disabled = isBusy;
  if (typeof textBusy === "string" && typeof textIdle === "string") {
    btn.textContent = isBusy ? textBusy : textIdle;
  }
}

/* =========================
   RENDER
========================= */

function render(pack) {
  remainingSnapshots = Number(pack.remaining ?? 0);

  if (statusPill) {
    statusPill.textContent = `Remaining snapshots: ${remainingSnapshots} of 3`;
  }

  if (redeemBtn) {
    redeemBtn.disabled = remainingSnapshots <= 0 || isLoading || isRedeeming;
  }

  const reports = pack.reports || [];
  if (!reportsEl) return;

  reportsEl.innerHTML = "";

  if (reports.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="muted">No reports generated yet.</span>`;
    reportsEl.appendChild(li);
    return;
  }

  for (const r of reports) {
    const li = document.createElement("li");
    const fullUrl = `${window.location.origin}${r.reportUrl}`;

    li.innerHTML = `
      <span>${safeStr(r.url).replace(/^https?:\/\//, "")}</span>
      <span><a href="${fullUrl}" target="_blank" rel="noopener noreferrer">Open report</a></span>
    `;

    reportsEl.appendChild(li);
  }
}

/* =========================
   LOAD PACK
========================= */

async function loadPack() {
  if (isLoading) return;
  isLoading = true;

  try {
    if (!sessionId) {
      if (statusPill) statusPill.textContent = "Missing session_id";
      if (redeemBtn) redeemBtn.disabled = true;

      showNotice(
        "warn",
        "Missing session reference",
        "We couldn’t find your bundle session in the URL. Please open the link from your bundle checkout confirmation."
      );

      track("threepack_load_failed", { reason: "missing_session_id" });
      return;
    }

    if (statusPill) statusPill.textContent = "Loading bundle…";
    if (redeemBtn) redeemBtn.disabled = true;

    const res = await fetch(
      `/api/threepack?session_id=${encodeURIComponent(sessionId)}`,
      { cache: "no-store" }
    );

    if (!res.ok) {
      if (statusPill) statusPill.textContent = "Could not load bundle";
      if (redeemBtn) redeemBtn.disabled = true;

      showNotice(
        "err",
        "Couldn’t load your bundle",
        "Please refresh the page. If it continues, return to your confirmation page and try the redemption link again."
      );

      track("threepack_load_failed", { status: res.status });
      return;
    }

    const data = await res.json();

    if (!data.ok) {
      if (statusPill) statusPill.textContent = "Could not load bundle";
      if (redeemBtn) redeemBtn.disabled = true;

      showNotice(
        "err",
        "Bundle unavailable",
        "We couldn’t verify this bundle session. Please try the link from your confirmation page."
      );

      track("threepack_load_failed", {
        reason: safeStr(data.error) || "not_ok",
      });
      return;
    }

    packToken = data.packToken;
    render(data);

    hideNotice();

    track("threepack_success_view", {
      hasPackToken: Boolean(packToken),
      remaining: Number(data.remaining ?? 0),
      reports_count: (data.reports || []).length,
    });
  } catch (e) {
    console.error(e);

    if (statusPill) statusPill.textContent = "Could not load bundle";
    if (redeemBtn) redeemBtn.disabled = true;

    showNotice(
      "err",
      "Network error",
      "We couldn’t load your bundle right now. Please refresh and try again."
    );

    track("threepack_load_failed", { err: safeStr(e?.message) });
  } finally {
    isLoading = false;
    if (redeemBtn) {
      redeemBtn.disabled = remainingSnapshots <= 0 || isRedeeming;
    }
  }
}

/* =========================
   REDEEM
========================= */

async function redeem() {
  if (isRedeeming) return;

  // Don’t allow redeem attempts while pack is still loading
  if (isLoading) {
    showNotice("info", "Loading bundle", "Please wait a moment and try again.");
    return;
  }

  isRedeeming = true;

  const raw = (urlInput?.value || "").trim();
  const url = normalizeUrl(raw);

  if (!url) {
    showNotice("warn", "Check the URL", "Please enter a valid website URL.");
    isRedeeming = false;
    return;
  }

  if (!packToken) {
    showNotice(
      "warn",
      "Bundle not ready yet",
      "We haven’t loaded your bundle token. Please refresh the page and try again."
    );
    track("threepack_redeem_failed", { reason: "missing_pack_token" });
    isRedeeming = false;
    return;
  }

  if (remainingSnapshots <= 0) {
    showNotice(
      "info",
      "No snapshots remaining",
      "This bundle has been fully used."
    );
    track("threepack_redeem_failed", { reason: "no_remaining" });
    isRedeeming = false;
    return;
  }

  const oldText = redeemBtn?.textContent || "Generate report";
  setBusy(redeemBtn, true, "Generating…", oldText);

  hideNotice();
  track("threepack_redeem_started", {});

  try {
    const res = await fetch("/api/threepack/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packToken, url }),
    });

    if (!res.ok) {
      showNotice(
        "err",
        "Couldn’t generate the report",
        "Please try again in a moment."
      );
      track("threepack_redeem_failed", { status: res.status });
      return;
    }

    const data = await res.json();

    if (!data.ok) {
      showNotice(
        "err",
        "Redeem failed",
        safeStr(data.message) ||
          "We couldn’t generate the report. Please try again."
      );
      track("threepack_redeem_failed", {
        reason: safeStr(data.error) || "not_ok",
      });
      return;
    }

    track("threepack_redeem_completed", { already: Boolean(data.already) });

    await loadPack();

    if (urlInput) urlInput.value = "";

    if (data.reportUrl) {
      showNotice(
        "ok",
        "Report ready",
        data.already
          ? "That URL already has a snapshot in this bundle. Opening the existing report."
          : "Your snapshot has been generated. Opening the report."
      );

      window.open(
        `${window.location.origin}${data.reportUrl}`,
        "_blank",
        "noopener,noreferrer"
      );
    } else {
      showNotice(
        "ok",
        "Snapshot created",
        "Your snapshot was generated. You can open it from the list below."
      );
    }
  } catch (e) {
    console.error(e);
    showNotice(
      "err",
      "Network error",
      "We couldn’t generate the report right now. Please try again."
    );
    track("threepack_redeem_failed", { err: safeStr(e?.message) });
  } finally {
    setBusy(redeemBtn, false, "Generating…", oldText);
    if (redeemBtn) redeemBtn.disabled = remainingSnapshots <= 0;
    isRedeeming = false;
  }
}

/* =========================
   INIT
========================= */

if (redeemBtn) redeemBtn.addEventListener("click", redeem);
loadPack();
