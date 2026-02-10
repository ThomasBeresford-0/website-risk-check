// public/app.js
// FULL RAMBO — zero hesitation, locked flow, conversion-biased

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

  if (!form || !input || !payButton) return;

  /* =========================
     FREE PREVIEW SCAN
  ========================= */

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isScanning) return;

    const url = input.value.trim();
    if (!url) return;

    isScanning = true;
    scannedUrl = url;

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

      // Risk
      const level = data.riskLevel.toLowerCase();
      riskEl.textContent = `Risk level: ${data.riskLevel}`;
      riskEl.className = `risk ${level}`;

      // Findings
      data.findings.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        findingsEl.appendChild(li);
      });

      preview.style.display = "block";
      payButton.disabled = false;
    } catch (err) {
      console.error(err);
      riskEl.textContent = "Scan failed. Please try again.";
      riskEl.className = "risk high";
    } finally {
      isScanning = false;
    }
  });

  /* =========================
     STRIPE CHECKOUT
  ========================= */

  payButton.addEventListener("click", async () => {
    if (!scannedUrl || isPaying) return;

    isPaying = true;
    payButton.disabled = true;
    payButton.textContent = "Redirecting to secure checkout…";

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scannedUrl }),
      });

      if (!res.ok) throw new Error("Checkout failed");

      const data = await res.json();
      if (!data.url) throw new Error("No checkout URL");

      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      alert("Checkout failed. Please try again.");
      payButton.disabled = false;
      payButton.textContent = "Download full PDF report";
      isPaying = false;
    }
  });
});
