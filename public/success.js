const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session_id");

const downloadBtn = document.getElementById("download");
const upsellBtn = document.getElementById("upsell");
const upsellInput = document.getElementById("upsell-url");
const shareBox = document.getElementById("share-box");

const downloadUrl =
  `/download-report?session_id=${encodeURIComponent(sessionId)}`;

function download() {
  if (!sessionId) return;
  window.location.href = downloadUrl;
}

function showShare() {
  shareBox.textContent = window.location.origin + downloadUrl;
  shareBox.style.display = "block";
}

downloadBtn.addEventListener("click", download);

setTimeout(download, 500);
setTimeout(showShare, 1000);

upsellBtn.addEventListener("click", async () => {
  const url = upsellInput.value.trim();
  if (!url) {
    alert("Please enter a website URL");
    return;
  }

  upsellBtn.disabled = true;
  upsellBtn.textContent = "Redirecting…";

  try {
    const res = await fetch("/create-upsell-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!data.url) throw new Error("No checkout URL");

    window.location.href = data.url;
  } catch {
    alert("Upsell checkout failed");
    upsellBtn.disabled = false;
    upsellBtn.textContent = "Run second scan (£39)";
  }
});
