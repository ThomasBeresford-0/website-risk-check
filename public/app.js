// public/app.js
// FULL RAMBO — conversion analytics + locked flow

function getSid() {
  const key = "wrc_sid";
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid = (crypto?.randomUUID?.() || String(Math.random()).slice(2)) + "-" + Date.now();
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

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");

  const preview = document.getElementById("preview");
  const riskEl = document.getElementById("risk");
  const findingsEl = document.getElementById("findings");
  const payButton = document.getElementById("pay-button");

  let scannedUrl = null;
  let isScanning = false;
  let isPaying = false;

  // fire landing view once
  track("landing_view", { path: location.pathname });

  if (!form || !input || !payButton) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const url = input.value.trim();
    if (!url) return;

    isScanning = true;
    scannedUrl = url;

    track("preview_started", { url });

    preview.style.display = "none";
    findingsEl.innerHTML = "";
    riskEl.textContent = "Scanning website…";
    riskEl.className = "risk";
    payButton.disabled = true;

    try {
      const res = await fetch("/preview-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) throw new Error("Preview failed");

      const data = await res.json();

      const level = (data.riskLevel || "LOW").toLowerCase();
      riskEl.textContent = `Risk level: ${data.riskLevel}`;
      riskEl.className = `risk ${level}`;

      (data.findings || []).forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        findingsEl.appendChild(li);
      });

      preview.style.display = "block";
      payButton.disabled = false;

      track("preview_completed", { riskLevel: data.riskLevel });
    } catch (err) {
      console.error(err);
      riskEl.textContent = "Scan failed. Please try again.";
      riskEl.className = "risk high";
      track("preview_failed", {});
    } finally {
      isScanning = false;
    }
  });

  payButton.addEventListener("click", async () => {
    if (!scannedUrl || isPaying) return;

    isPaying = true;
    payButton.disabled = true;
    payButton.textContent = "Redirecting to secure checkout…";

    track("checkout_started", {});

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scannedUrl }),
      });

      if (!res.ok) throw new Error("Checkout failed");

      const data = await res.json();
      if (!data.url) throw new Error("No checkout URL");

      track("checkout_redirected", {});
      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      alert("Checkout failed. Please try again.");
      payButton.disabled = false;
      payButton.textContent = "Download full PDF report (£79)";
      isPaying = false;
      track("checkout_failed", {});
    }
  });
});
