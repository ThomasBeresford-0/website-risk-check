console.log("app.js loaded");

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM loaded");

  const form = document.getElementById("check-form");
  const input = document.getElementById("url-input");

  console.log("Form:", form);
  console.log("Input:", input);

  if (!form || !input) {
    console.error("FORM OR INPUT MISSING");
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("SUBMIT FIRED");

    const url = input.value;
    console.log("URL:", url);

    try {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        console.error("Checkout request failed:", res.status);
        alert("Checkout failed. Check server logs.");
        return;
      }

      const data = await res.json();

      if (!data.url) {
        console.error("No checkout URL returned:", data);
        alert("Stripe did not return a checkout URL. Check server logs.");
        return;
      }

      window.location.href = data.url;
    } catch (err) {
      console.error("Network / JS error:", err);
      alert("Something went wrong. Check console.");
    }
  });
});
