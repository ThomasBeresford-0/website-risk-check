// public/sample-report.js
// Boutique showcase: progressive PDF preview.
// Baseline: native iframe preview (always works).
// Enhancement: PDF.js flipbook on top (if worker + CSP allow).
// Uses LOCAL PDF.js + LOCAL worker to avoid CSP/worker blocking.

(() => {
  /* =========================
     CONFIG
  ========================= */

  const SAMPLE_PDF_URL = "/sample-report.pdf";
  const SAMPLE_VERIFY_PATH =
    "/verify/c7eb98c339a3aa9785668b1735f5d685da13c22caabbfe470679e2452ef8db8c";
  const REPORT_ID = "SAMPLE-001";

  const TURN_MS = 610;

  const SCALE_DEFAULT = 1.1;
  const SCALE_MIN = 0.85;
  const SCALE_MAX = 1.85;
  const SCALE_STEP = 0.1;

  const DPR_MAX = 2;

  /* =========================
     DOM
  ========================= */

  const openPdfBtn = document.getElementById("openPdfBtn");
  const openPdfBtn2 = document.getElementById("openPdfBtn2");
  const openVerifyBtn = document.getElementById("openVerifyBtn");
  const openVerifyBtn2 = document.getElementById("openVerifyBtn2");

  const verifyPathEl = document.getElementById("verifyPath");
  const reportIdEl = document.getElementById("reportId");

  const copyVerifyBtn = document.getElementById("copyVerifyBtn");
  const copyReportIdBtn = document.getElementById("copyReportIdBtn");

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const pageNumEl = document.getElementById("pageNum");
  const pageCountEl = document.getElementById("pageCount");

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");

  const flipStage = document.getElementById("flipStage");
  const frontCanvas = document.getElementById("frontCanvas");
  const backCanvas = document.getElementById("backCanvas");

  const frontPage = document.getElementById("frontPage");
  const backPage = document.getElementById("backPage");

  const loadingState = document.getElementById("loadingState");
  const errorState = document.getElementById("errorState");
  const directPdfLink = document.getElementById("directPdfLink");

  const nativePdfFrame = document.getElementById("nativePdfFrame");

  // If the page doesn’t have the flipbook section for any reason, just wire the links and bail.
  const required = [flipStage, frontCanvas, backCanvas, prevBtn, nextBtn, pageNumEl, pageCountEl];
  const hasFlipbook = !required.some((el) => !el);

  /* =========================
     Wire static links (CTA + proof)
  ========================= */

  if (verifyPathEl) verifyPathEl.textContent = SAMPLE_VERIFY_PATH;
  if (reportIdEl) reportIdEl.textContent = REPORT_ID;

  function bindLink(a, url) {
    if (!a) return;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
  }

  bindLink(openPdfBtn, SAMPLE_PDF_URL);
  bindLink(openPdfBtn2, SAMPLE_PDF_URL);
  bindLink(openVerifyBtn, SAMPLE_VERIFY_PATH);
  bindLink(openVerifyBtn2, SAMPLE_VERIFY_PATH);
  bindLink(directPdfLink, SAMPLE_PDF_URL);

  // Ensure iframe points at the right PDF (in case HTML is cached / older)
  if (nativePdfFrame && nativePdfFrame.tagName === "IFRAME") {
    nativePdfFrame.setAttribute("src", `${SAMPLE_PDF_URL}#view=FitH`);
  }

  /* =========================
     Copy helpers
  ========================= */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }
  }

  function flashBtn(btn, okText, failText) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = okText;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original || failText;
      btn.disabled = false;
    }, 900);
  }

  if (copyVerifyBtn) {
    copyVerifyBtn.addEventListener("click", async () => {
      const full = `${location.origin}${SAMPLE_VERIFY_PATH}`;
      const ok = await copyText(full);
      flashBtn(copyVerifyBtn, ok ? "Copied" : "Copy failed", "Copy");
    });
  }

  if (copyReportIdBtn) {
    copyReportIdBtn.addEventListener("click", async () => {
      const ok = await copyText(REPORT_ID);
      flashBtn(copyReportIdBtn, ok ? "Copied" : "Copy failed", "Copy");
    });
  }

  // If no flipbook exists, we’re done.
  if (!hasFlipbook) return;

  /* =========================
     PDF.js bootstrap (LOCAL)
  ========================= */

  const pdfjsLib = window.pdfjsLib;

  // Baseline is iframe; only attempt enhancement if PDF.js exists.
  if (!pdfjsLib) {
    // Don’t blow up the UI — just show the small interactive unavailable note
    if (loadingState) loadingState.hidden = true;
    if (errorState) errorState.hidden = false;
    return;
  }

  // Worker must exist at /public/vendor/pdfjs/pdf.worker.min.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js?v=1";

  /* =========================
     State
  ========================= */

  let pdfDoc = null;
  let pageNum = 1;
  let totalPages = 0;
  let scale = SCALE_DEFAULT;

  let frontIsA = true;
  let isTurning = false;
  let enhancementReady = false;

  /* =========================
     Helpers
  ========================= */

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function setReadout() {
    if (pageNumEl) pageNumEl.textContent = String(pageNum);
    if (pageCountEl) pageCountEl.textContent = String(totalPages || "–");
  }

  function lockButtons() {
    prevBtn.disabled = pageNum <= 1 || isTurning || !enhancementReady;
    nextBtn.disabled = pageNum >= totalPages || isTurning || !enhancementReady;
    if (zoomInBtn) zoomInBtn.disabled = isTurning || !enhancementReady;
    if (zoomOutBtn) zoomOutBtn.disabled = isTurning || !enhancementReady;
  }

  function getFrontCanvas() {
    return frontIsA ? frontCanvas : backCanvas;
  }
  function getBackCanvas() {
    return frontIsA ? backCanvas : frontCanvas;
  }

  function fitCanvas(canvas, viewport) {
    const dpr = clamp(window.devicePixelRatio || 1, 1, DPR_MAX);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    return dpr;
  }

  async function renderPageToCanvas(n, canvas) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });
    const dpr = fitCanvas(canvas, viewport);

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const renderViewport = page.getViewport({ scale: scale * dpr });

    await page.render({
      canvasContext: ctx,
      viewport: renderViewport,
      intent: "display",
    }).promise;
  }

  function showEnhancementError() {
    // Keep iframe as the real preview. This error is only about the flipbook.
    if (loadingState) loadingState.hidden = true;
    if (errorState) errorState.hidden = false;

    enhancementReady = false;
    lockButtons();
  }

  function enableFlipbookUI() {
    // Hide iframe overlay via CSS
    document.body.classList.add("isFlipReady");

    // Unhide canvas pages (we hid them with aria-hidden in HTML)
    if (frontPage) frontPage.removeAttribute("aria-hidden");
    if (backPage) backPage.removeAttribute("aria-hidden");

    enhancementReady = true;
    if (errorState) errorState.hidden = true;
    if (loadingState) loadingState.hidden = true;

    setReadout();
    lockButtons();
  }

  /* =========================
     Navigation / flip logic
  ========================= */

  async function goTo(n, { animate = true } = {}) {
    if (!pdfDoc || isTurning || !enhancementReady) return;

    const to = clamp(n, 1, totalPages);
    if (to === pageNum) return;

    const back = getBackCanvas();

    try {
      isTurning = true;
      lockButtons();

      await renderPageToCanvas(to, back);

      if (animate) {
        flipStage.classList.add("isTurning");
        window.setTimeout(() => {
          flipStage.classList.remove("isTurning");
          frontIsA = !frontIsA;
          pageNum = to;
          isTurning = false;
          setReadout();
          lockButtons();
        }, TURN_MS);
      } else {
        await renderPageToCanvas(to, getFrontCanvas());
        pageNum = to;
        isTurning = false;
        setReadout();
        lockButtons();
      }
    } catch (e) {
      console.error("PDF render navigation error:", e);
      isTurning = false;
      lockButtons();
      showEnhancementError();
    }
  }

  /* =========================
     Init
  ========================= */

  async function init() {
    try {
      if (loadingState) loadingState.hidden = false;
      if (errorState) errorState.hidden = true;

      // Disable controls until enhanced is actually ready
      enhancementReady = false;
      lockButtons();

      pdfDoc = await pdfjsLib.getDocument({
        url: SAMPLE_PDF_URL,
        withCredentials: false,
        // If you ever hit CORS weirdness, you can add:
        // disableStream: true,
        // disableAutoFetch: true,
      }).promise;

      totalPages = pdfDoc.numPages || 0;
      pageNum = 1;

      // Render first page to the active “front” canvas
      await renderPageToCanvas(pageNum, getFrontCanvas());

      // Enhancement succeeded — switch from iframe to flipbook
      enableFlipbookUI();

      // Click-to-turn (only meaningful in enhanced mode)
      flipStage.addEventListener("click", () => {
        if (isTurning || !enhancementReady) return;
        if (pageNum < totalPages) goTo(pageNum + 1, { animate: true });
        else if (pageNum > 1) goTo(pageNum - 1, { animate: true });
      });

      prevBtn.addEventListener("click", () => goTo(pageNum - 1, { animate: true }));
      nextBtn.addEventListener("click", () => goTo(pageNum + 1, { animate: true }));

      // Keyboard nav ONLY when stage is focused (no global hijack)
      flipStage.addEventListener("keydown", (ev) => {
        if (isTurning || !enhancementReady) return;
        if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          goTo(pageNum - 1, { animate: true });
        }
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          goTo(pageNum + 1, { animate: true });
        }
      });

      if (zoomInBtn) {
        zoomInBtn.addEventListener("click", async () => {
          if (!pdfDoc || isTurning || !enhancementReady) return;
          scale = clamp(scale + SCALE_STEP, SCALE_MIN, SCALE_MAX);
          await renderPageToCanvas(pageNum, getFrontCanvas());
        });
      }

      if (zoomOutBtn) {
        zoomOutBtn.addEventListener("click", async () => {
          if (!pdfDoc || isTurning || !enhancementReady) return;
          scale = clamp(scale - SCALE_STEP, SCALE_MIN, SCALE_MAX);
          await renderPageToCanvas(pageNum, getFrontCanvas());
        });
      }

      // Rerender on resize (debounced)
      let t = null;
      window.addEventListener("resize", () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          if (!pdfDoc || isTurning || !enhancementReady) return;
          try {
            await renderPageToCanvas(pageNum, getFrontCanvas());
          } catch (e) {
            console.error("PDF resize rerender error:", e);
          }
        }, 140);
      });
    } catch (err) {
      console.error("Sample PDF init error:", err);
      showEnhancementError();
    }
  }

  init();
})();
