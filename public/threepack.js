// public/threepack.js
// FULL RAMBO — redeem 3-pack and list generated report links (cleaned)

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

function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {}
  try {
    return new URL(`https://${String(input).trim()}`).toString();
  } catch {}
  return "";
}

/* =========================
   RENDER
========================= */

function render(pack) {
  remainingSnapshots = Number(pack.remaining ?? 0);
  statusPill.textContent = `Remaining snapshots: ${remainingSnapshots} of 3`;
  redeemBtn.disabled = remainingSnapshots <= 0;

  const reports = pack.reports || [];
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
      <span>${(r.url || "").replace(/^https?:\/\//, "")}</span>
      <span><a href="${fullUrl}" target="_blank" rel="noopener noreferrer">Open report</a></span>
    `;
    reportsEl.appendChild(li);
  }
}

/* =========================
   LOAD PACK
========================= */

async function loadPack() {
  if (!sessionId) {
    statusPill.textContent = "Missing session_id";
    redeemBtn.disabled = true;
    return;
  }

  const res = await fetch(
    `/api/threepack?session_id=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    statusPill.textContent = "Could not load pack";
    redeemBtn.disabled = true;
    return;
  }

  const data = await res.json();
  if (!data.ok) {
    statusPill.textContent = "Could not load pack";
    redeemBtn.disabled = true;
    return;
  }

  packToken = data.packToken;
  render(data);

  track("threepack_success_view", {
    hasPackToken: Boolean(packToken),
  });
}

/* =========================
   REDEEM
========================= */

async function redeem() {
  const url = normalizeUrl(urlInput.value.trim());
  if (!url) {
    alert("Enter a valid website URL.");
    return;
  }

  if (!packToken) {
    alert("Pack not ready. Refresh the page.");
    return;
  }

  if (remainingSnapshots <= 0) {
    alert("No snapshots remaining.");
    return;
  }

  redeemBtn.disabled = true;
  const old = redeemBtn.textContent;
  redeemBtn.textContent = "Generating…";

  track("threepack_redeem_started", {});

  try {
    const res = await fetch("/api/threepack/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packToken, url }),
    });

    if (!res.ok) throw new Error("Redeem failed");

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Redeem failed");

    track("threepack_redeem_completed", {
      already: Boolean(data.already),
    });

    // reload pack state
    await loadPack();
    urlInput.value = "";

    // open report (existing or new)
    if (data.reportUrl) {
      window.open(
        `${window.location.origin}${data.reportUrl}`,
        "_blank",
        "noopener,noreferrer"
      );
    }
  } catch (e) {
    console.error(e);
    alert("Could not generate report. Please try again.");
  } finally {
    redeemBtn.textContent = old;
    redeemBtn.disabled = remainingSnapshots <= 0;
  }
}

/* =========================
   INIT
========================= */

redeemBtn.addEventListener("click", redeem);
loadPack();
