// public/success.js
// FULL RAMBO — immutable report delivery + share links + upsells (cleaned)

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

track(isUpsell ? "upsell_success_view" : "success_view", {
  hasSessionId: Boolean(sessionId),
});

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

async function resolvePermanentLink() {
  if (!sessionId) return;

  try {
    const res = await fetch(
      `/download-report?session_id=${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        redirect: "manual",
      }
    );

    const loc = res.headers.get("Location");
    if (loc && loc.startsWith("/r/")) {
      permanentUrl = `${window.location.origin}${loc}`;
      shareBox.textContent = permanentUrl;
      shareBox.style.display = "block";
      copyBtn.style.display = "inline-block";
      if (openBtn) openBtn.style.display = "inline-block";
      track("share_link_shown", {});
      return;
    }

    shareBox.textContent =
      "Permanent link will appear once the report is ready.";
    shareBox.style.display = "block";
  } catch {
    shareBox.textContent =
      "Permanent link will appear once the report is ready.";
    shareBox.style.display = "block";
  }
}

if (downloadBtn) {
  downloadBtn.addEventListener("click", downloadOnce);
}

if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    if (!permanentUrl) return;
    try {
      await navigator.clipboard.writeText(permanentUrl);
      toast("Copied");
      track("share_copied", {});
    } catch {
      alert("Copy failed.");
    }
  });
}

if (openBtn) {
  openBtn.addEventListener("click", () => {
    if (!permanentUrl) return;
    track("share_opened", {});
    window.open(permanentUrl, "_blank", "noopener,noreferrer");
  });
}

/* auto-run once */
setTimeout(() => {
  downloadOnce();
  resolvePermanentLink();
}, 500);

/* =========================
   £39 UPSELL CHECKOUT
========================= */

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

async function startUpsellCheckout() {
  const raw = (upsellInput?.value || "").trim();
  const url = normalizeUrl(raw);

  if (!url) {
    alert("Please enter a valid website URL.");
    return;
  }

  if (!sessionId) {
    alert("Missing payment session. Please use the Download button.");
    return;
  }

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

    if (!res.ok) throw new Error("Upsell checkout failed");

    const data = await res.json();
    if (!data.url) throw new Error("No checkout URL");

    track("upsell_redirected", {});
    window.location.href = data.url;
  } catch (e) {
    console.error(e);
    alert("Upsell checkout failed. Please try again.");
    upsellBtn.disabled = false;
    upsellBtn.textContent = originalText;
    track("upsell_failed", {});
  }
}

if (upsellBtn) upsellBtn.addEventListener("click", startUpsellCheckout);

/* =========================
   £99 THREE-PACK CHECKOUT
========================= */

async function startThreepackCheckout() {
  if (!sessionId) {
    alert("Missing payment session. Please use the Download button.");
    return;
  }

  if (threepackBtn) {
    threepackBtn.disabled = true;
    var old = threepackBtn.textContent;
    threepackBtn.textContent = "Redirecting to bundle checkout…";
  }

  track("threepack_started", {});

  try {
    const res = await fetch("/create-threepack-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent_session_id: sessionId }),
    });

    if (!res.ok) throw new Error("Threepack checkout failed");

    const data = await res.json();
    if (!data.url) throw new Error("No checkout URL");

    track("threepack_redirected", {});
    window.location.href = data.url;
  } catch (e) {
    console.error(e);
    alert("Bundle checkout failed. Please try again.");
    if (threepackBtn) {
      threepackBtn.disabled = false;
      threepackBtn.textContent = old;
    }
    track("threepack_failed", {});
  }
}

if (threepackBtn) {
  threepackBtn.addEventListener("click", startThreepackCheckout);
}
