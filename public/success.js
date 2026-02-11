// public/success.js
// FULL RAMBO — immutable report delivery + share links + upsells (no alerts, calm UX)

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

function toast(msg) {
  if (window.__toast) window.__toast(msg);
}

/* =========================
   INLINE NOTICE (NO ALERTS)
========================= */

function ensureNotice() {
  const anchor =
    document.getElementById("success-card") ||
    document.querySelector("main") ||
    document.body;

  let el = document.getElementById("wrcSuccessNotice");
  if (el) return el;

  el = document.createElement("div");
  el.id = "wrcSuccessNotice";
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
  const el = document.getElementById("wrcSuccessNotice");
  if (!el) return;
  el.style.display = "none";
  el.innerHTML = "";
}

/* =========================
   DOM
========================= */

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session_id");
const isUpsell = params.get("upsell") === "1";

const downloadBtn = document.getElementById("download");
const shareBox = document.getElementById("share-box");
const copyBtn = document.getElementById("copy");
const openBtn = document.getElementById("open");

const upsellBtn = document.getElementById("upsell");
const upsellInput = document.getElementById("upsell-url");
const threepackBtn = document.getElementById("threepack");

let permanentUrl = "";

/* =========================
   TRACK VIEW
========================= */

track(isUpsell ? "upsell_success_view" : "success_view", {
  hasSessionId: Boolean(sessionId),
});

if (!sessionId) {
  showNotice(
    "warn",
    "Missing session reference",
    "We couldn’t find your payment session in the URL. If you’ve just paid, please return to the checkout confirmation page and try again."
  );
}

/* =========================
   HELPERS
========================= */

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function setShareUiReady(url) {
  permanentUrl = url;

  if (shareBox) {
    shareBox.textContent = permanentUrl;
    shareBox.style.display = "block";
  }
  if (copyBtn) copyBtn.style.display = "inline-block";
  if (openBtn) openBtn.style.display = "inline-block";

  track("share_link_shown", {});
}

function setShareUiPending(text) {
  if (!shareBox) return;
  shareBox.textContent = text;
  shareBox.style.display = "block";
  if (copyBtn) copyBtn.style.display = "none";
  if (openBtn) openBtn.style.display = "none";
}

function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {
    try {
      return new URL(`https://${String(input).trim()}`).toString();
    } catch {
      return "";
    }
  }
}

/* =========================
   DOWNLOAD + PERMANENT LINK
========================= */

function downloadOnce() {
  if (!sessionId) return;
  track("report_download_intent", {});
  window.location.href = `/download-report?session_id=${encodeURIComponent(
    sessionId
  )}`;
}

// Attempts to resolve the stable /r/:token URL without triggering a download
async function resolvePermanentLink() {
  if (!sessionId) return false;

  setShareUiPending("Resolving your permanent link…");

  try {
    const res = await fetch(
      `/download-report?session_id=${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
      }
    );

    const loc = res.headers.get("Location") || res.headers.get("location");
    if (loc && loc.startsWith("/r/")) {
      setShareUiReady(`${window.location.origin}${loc}`);
      hideNotice();
      return true;
    }

    setShareUiPending("Permanent link will appear once the report is ready.");
    return false;
  } catch {
    setShareUiPending("Permanent link will appear once the report is ready.");
    return false;
  }
}

if (downloadBtn) downloadBtn.addEventListener("click", downloadOnce);

if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    if (!permanentUrl) {
      showNotice(
        "info",
        "Not ready yet",
        "Your permanent link will appear once the report is ready."
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(permanentUrl);
      toast("Copied");
      track("share_copied", {});
      showNotice("ok", "Copied", "Your permanent link is now on your clipboard.");
      setTimeout(hideNotice, 2400);
    } catch {
      showNotice(
        "err",
        "Copy failed",
        "Please copy the link manually from the box above."
      );
      track("share_copy_failed", {});
    }
  });
}

if (openBtn) {
  openBtn.addEventListener("click", () => {
    if (!permanentUrl) {
      showNotice(
        "info",
        "Not ready yet",
        "Your permanent link will appear once the report is ready."
      );
      return;
    }
    track("share_opened", {});
    window.open(permanentUrl, "_blank", "noopener,noreferrer");
  });
}

/* Auto-run: resolve link first (lighter), then download */
setTimeout(async () => {
  showNotice(
    "info",
    "Preparing your report",
    "Your download will begin automatically. Your permanent share link will appear here once the report is ready."
  );

  // Try to resolve first; if it succeeds, user can download from /r/:token later.
  const resolved = await resolvePermanentLink();

  // Always trigger the download shortly after so expectations are met.
  // If resolved already, this hits the cached session mapping and redirects fast.
  setTimeout(() => downloadOnce(), resolved ? 250 : 700);
}, 450);

/* =========================
   £39 UPSELL CHECKOUT
========================= */

async function startUpsellCheckout() {
  const raw = (upsellInput?.value || "").trim();
  const url = normalizeUrl(raw);

  if (!url) {
    showNotice(
      "warn",
      "Check the URL",
      "Please enter a valid website URL for the additional snapshot."
    );
    return;
  }

  if (!sessionId) {
    showNotice(
      "warn",
      "Missing session",
      "We’re missing your payment session. Please use the Download button first."
    );
    return;
  }

  if (!upsellBtn) return;

  upsellBtn.disabled = true;
  const originalText = upsellBtn.textContent;
  upsellBtn.textContent = "Redirecting to secure checkout…";

  track("upsell_started", {});

  try {
    const res = await fetch("/create-upsell-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, parent_session_id: sessionId }),
    });

    if (!res.ok) {
      showNotice(
        "err",
        "Upsell unavailable",
        "We couldn’t start checkout right now. Please try again in a moment."
      );
      track("upsell_failed", { status: res.status });
      upsellBtn.disabled = false;
      upsellBtn.textContent = originalText;
      return;
    }

    const data = await res.json();
    if (!data.url) {
      showNotice(
        "err",
        "Upsell error",
        "Checkout did not return a redirect URL. Please try again."
      );
      track("upsell_failed", { reason: "no_url" });
      upsellBtn.disabled = false;
      upsellBtn.textContent = originalText;
      return;
    }

    track("upsell_redirected", {});
    window.location.href = data.url;
  } catch (e) {
    console.error(e);
    showNotice(
      "err",
      "Upsell failed",
      "We couldn’t start checkout. Please try again."
    );
    track("upsell_failed", { err: safeStr(e?.message) });
    upsellBtn.disabled = false;
    upsellBtn.textContent = originalText;
  }
}

if (upsellBtn) upsellBtn.addEventListener("click", startUpsellCheckout);

/* =========================
   £99 THREE-PACK CHECKOUT
========================= */

async function startThreepackCheckout() {
  if (!sessionId) {
    showNotice(
      "warn",
      "Missing session",
      "We’re missing your payment session. Please use the Download button first."
    );
    return;
  }

  if (!threepackBtn) return;

  threepackBtn.disabled = true;
  const oldText = threepackBtn.textContent;
  threepackBtn.textContent = "Redirecting to bundle checkout…";

  track("threepack_started", {});

  try {
    const res = await fetch("/create-threepack-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_session_id: sessionId }),
    });

    if (!res.ok) {
      showNotice(
        "err",
        "Bundle unavailable",
        "We couldn’t start bundle checkout right now. Please try again."
      );
      track("threepack_failed", { status: res.status });
      threepackBtn.disabled = false;
      threepackBtn.textContent = oldText;
      return;
    }

    const data = await res.json();
    if (!data.url) {
      showNotice(
        "err",
        "Bundle error",
        "Checkout did not return a redirect URL. Please try again."
      );
      track("threepack_failed", { reason: "no_url" });
      threepackBtn.disabled = false;
      threepackBtn.textContent = oldText;
      return;
    }

    track("threepack_redirected", {});
    window.location.href = data.url;
  } catch (e) {
    console.error(e);
    showNotice(
      "err",
      "Bundle checkout failed",
      "We couldn’t start checkout. Please try again."
    );
    track("threepack_failed", { err: safeStr(e?.message) });
    threepackBtn.disabled = false;
    threepackBtn.textContent = oldText;
  }
}

if (threepackBtn) threepackBtn.addEventListener("click", startThreepackCheckout);
