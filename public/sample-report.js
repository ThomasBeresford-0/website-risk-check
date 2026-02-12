// public/sample-report.js
// Boutique showcase: flipbook-style PDF preview (PDF.js) + hard-linked verification.
// Uses LOCAL PDF.js + LOCAL worker to avoid CSP/worker blocking.

(() => {
  /* =========================
     CONFIG
  ========================= */

  // Choose the showcase PDF (you have both in /public)
  const SAMPLE_PDF_URL = "/sample-report.pdf";

  const SAMPLE_VERIFY_PATH = "/verify/c7eb98c339a3aa9785668b1735f5d685da13c22caabbfe470679e2452ef8db8c";


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

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const pageNumEl = document.getElementById("pageNum");
  const pageCountEl = document.getElementById("pageCount");

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");

  const flipStage = document.getElementById("flipStage");
  const frontCanvas = document.getElementById("frontCanvas");
  const backCanvas = document.getElementById("backCanvas");

  const loadingState = document.getElementById("loadingState");
  const errorState = document.getElementById("errorState");
  const directPdfLink = document.getElementById("directPdfLink");

  const required = [
    flipStage,
    frontCanvas,
    backCanvas,
    prevBtn,
    nextBtn,
    pageNumEl,
    pageCountEl,
    loadingState,
    errorState,
  ];
  if (required.some((el) => !el)) return;

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

  /* =========================
     PDF.js bootstrap (LOCAL)
  ========================= */

  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    loadingState.hidden = true;
    errorState.hidden = false;
    return;
  }

  // LOCAL worker (put the files here):
  // public/vendor/pdfjs/pdf.min.js
  // public/vendor/pdfjs/pdf.worker.min.js
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "/vendor/pdfjs/pdf.worker.min.js?v=1";

  /* =========================
     State
  ========================= */

  let pdfDoc = null;
  let pageNum = 1;
  let totalPages = 0;
  let scale = SCALE_DEFAULT;

  let frontIsA = true;
  let isTurning = false;

  /* =========================
     Helpers
  ========================= */

  function setReadout() {
    pageNumEl.textContent = String(pageNum);
    pageCountEl.textContent = String(totalPages || "–");
  }

  function lockButtons() {
    prevBtn.disabled = pageNum <= 1 || isTurning;
    nextBtn.disabled = pageNum >= totalPages || isTurning;
    if (zoomInBtn) zoomInBtn.disabled = isTurning;
    if (zoomOutBtn) zoomOutBtn.disabled = isTurning;
  }

  function getFrontCanvas() {
    return frontIsA ? frontCanvas : backCanvas;
  }
  function getBackCanvas() {
    return frontIsA ? backCanvas : frontCanvas;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
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

  function showError() {
    loadingState.hidden = true;
    errorState.hidden = false;
  }

  /* =========================
     Navigation / flip logic
  ========================= */

  async function goTo(n, { animate = true } = {}) {
    if (!pdfDoc || isTurning) return;

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
        const front = getFrontCanvas();
        await renderPageToCanvas(to, front);
        pageNum = to;
        isTurning = false;
        setReadout();
        lockButtons();
      }
    } catch (e) {
      console.error("PDF render navigation error:", e);
      isTurning = false;
      lockButtons();
      showError();
    }
  }

  /* =========================
     Init
  ========================= */

  async function init() {
    try {
      loadingState.hidden = false;
      errorState.hidden = true;

      pdfDoc = await pdfjsLib.getDocument({
        url: SAMPLE_PDF_URL,
        withCredentials: false,
      }).promise;

      totalPages = pdfDoc.numPages || 0;
      pageNum = 1;

      await renderPageToCanvas(pageNum, getFrontCanvas());

      setReadout();
      loadingState.hidden = true;
      lockButtons();

      flipStage.addEventListener("click", () => {
        if (isTurning) return;
        if (pageNum < totalPages) goTo(pageNum + 1, { animate: true });
        else if (pageNum > 1) goTo(pageNum - 1, { animate: true });
      });

      prevBtn.addEventListener("click", () =>
        goTo(pageNum - 1, { animate: true })
      );
      nextBtn.addEventListener("click", () =>
        goTo(pageNum + 1, { animate: true })
      );

      window.addEventListener("keydown", (ev) => {
        if (isTurning) return;
        if (ev.key === "ArrowLeft") goTo(pageNum - 1, { animate: true });
        if (ev.key === "ArrowRight") goTo(pageNum + 1, { animate: true });
      });

      if (zoomInBtn) {
        zoomInBtn.addEventListener("click", async () => {
          if (!pdfDoc || isTurning) return;
          scale = clamp(scale + SCALE_STEP, SCALE_MIN, SCALE_MAX);
          await renderPageToCanvas(pageNum, getFrontCanvas());
        });
      }

      if (zoomOutBtn) {
        zoomOutBtn.addEventListener("click", async () => {
          if (!pdfDoc || isTurning) return;
          scale = clamp(scale - SCALE_STEP, SCALE_MIN, SCALE_MAX);
          await renderPageToCanvas(pageNum, getFrontCanvas());
        });
      }

      let t = null;
      window.addEventListener("resize", () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          if (!pdfDoc || isTurning) return;
          try {
            await renderPageToCanvas(pageNum, getFrontCanvas());
          } catch (e) {
            console.error("PDF resize rerender error:", e);
          }
        }, 120);
      });
    } catch (err) {
      console.error("Sample PDF init error:", err);
      showError();
    }
  }

  init();
})();
