// public/app.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");

  const preview = document.getElementById("preview");
  const riskEl = document.getElementById("risk");
  const findingsEl = document.getElementById("findings");
  const payButton = document.getElementById("pay-button");

  let scannedUrl = null;

  if (!form || !input) {
    console.error("Form or input missing");
    return;
  }

  // ------------------------------------
  // Handle FREE preview scan
  // ------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const url = input.value.trim();
    if (!url) return;

    scannedUrl = url;

    preview.style.display = "none";
    findingsEl.innerHTML = "";
    riskEl.textContent = "Scanning…";
    riskEl.className = "risk";

    try {
      const res = await fetch("/preview-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        alert("Scan failed. Please try again.");
        return;
      }

      const data = await res.json();

      // Risk level
      const level = data.riskLevel.toLowerCase();
      riskEl.textContent = `Risk level: ${data.riskLevel}`;
      riskEl.className = `risk ${level}`;

      // Findings list
      data.findings.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        findingsEl.appendChild(li);
      });

      preview.style.display = "block";
    } catch (err) {
      console.error(err);
      alert("Something went wrong during the scan.");
    }
  });

  // ------------------------------------
  // Handle STRIPE checkout
  // ------------------------------------
  payButton.addEventListener("click", async () => {
    if (!scannedUrl) return;

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scannedUrl }),
      });

      if (!res.ok) {
        alert("Checkout failed.");
        return;
      }

      const data = await res.json();

      if (!data.url) {
        alert("Stripe error. No checkout URL.");
        return;
      }

      window.location.href = data.url;
    } catch (err) {
      console.error(err);
      alert("Checkout error.");
    }
  });
});
