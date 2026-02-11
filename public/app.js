// public/app.js
// FULL RAMBO — signal-only preview + locked conversion flow (single + 3-pack)

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

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");
  const preview = document.getElementById("preview");
  const findingsEl = document.getElementById("findings");

  const payButton = document.getElementById("pay-button"); // single report
  const threepackButton = document.getElementById("threepack-button"); // 3-pack best value (optional on page)

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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const url = input.value.trim();
    if (!url) return;

    isScanning = true;
    scannedUrl = url;

    track("preview_started", {});

    preview.style.display = "none";
    findingsEl.innerHTML = "";
    setPayButtonsEnabled(false);
    resetPayButtonsText();

    try {
      const res = await fetch("/preview-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) throw new Error("Preview failed");

      const data = await res.json();

      (data.findings || []).forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        findingsEl.appendChild(li);
      });

      preview.style.display = "block";
      setPayButtonsEnabled(true);

      track("preview_completed", {
        findings_count: (data.findings || []).length,
      });
    } catch (err) {
      console.error(err);
      alert("Preview scan failed. Please try again.");
      track("preview_failed", {});
    } finally {
      isScanning = false;
    }
  });

  payButton.addEventListener("click", async () => {
    if (!scannedUrl || isPayingSingle || isPayingThreepack) return;

    isPayingSingle = true;
    setPayButtonsEnabled(false);
    payButton.textContent = "Redirecting to secure checkout…";

    track("checkout_started", { kind: "single" });

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scannedUrl }),
      });

      if (!res.ok) throw new Error("Checkout failed");

      const data = await res.json();
      if (!data.url) throw new Error("No checkout URL");

      track("checkout_redirected", { kind: "single" });
      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      alert("Checkout failed. Please try again.");
      setPayButtonsEnabled(true);
      resetPayButtonsText();
      isPayingSingle = false;
      track("checkout_failed", { kind: "single" });
    }
  });

  if (threepackButton) {
    threepackButton.addEventListener("click", async () => {
      if (!scannedUrl || isPayingThreepack || isPayingSingle) return;

      isPayingThreepack = true;
      setPayButtonsEnabled(false);
      threepackButton.textContent = "Redirecting to secure checkout…";

      track("checkout_started", { kind: "threepack" });

      try {
        const res = await fetch("/create-threepack-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: scannedUrl }),
        });

        if (!res.ok) throw new Error("Threepack checkout failed");

        const data = await res.json();
        if (!data.url) throw new Error("No checkout URL");

        track("checkout_redirected", { kind: "threepack" });
        window.location.href = data.url;
      } catch (err) {
        console.error(err);
        alert("Checkout failed. Please try again.");
        setPayButtonsEnabled(true);
        resetPayButtonsText();
        isPayingThreepack = false;
        track("checkout_failed", { kind: "threepack" });
      }
    });
  }
});
