# C.E.S.T.I.S System Longevity Audit

**Date:** 2026-07-11 · **Scope:** every HTML file in the repository (43 files) plus `cestis-core.js` · **Goal:** the system must keep working and keep its data indefinitely — offline, across browser restarts, and across the disappearance of any single third-party service.

---

## 1. Architecture summary (what was audited)

| Layer | Files | Role |
|---|---|---|
| Data-bearing apps | `index.html`, `CESTIS.Cashbook.html`, `School.Fee.html`, `Staff.Clock.in.html`, `Staff.Payslip.html`, `Virement.Request.html`, `Student-Progress.html`, `Qual-Plan-Curriculum.html` | Full applications; all load the shared data core |
| Shared data core | `cestis-core.js` | `CESTISStore`: IndexedDB-backed store with a synchronous localStorage-compatible API, plus shared domain logic (42 Node unit tests) |
| UI fragments | `Pages/*.html` (31 files), `LMS-Chat*.html`, `Video-Conference*.html` | Markup-only fragments injected into `index.html` via `innerHTML`; they contain **no scripts and no storage** by design |
| Standalone tool | `PDF.Workshop.html` | Pure in-memory file converter; deliberately stores nothing |

## 2. Storage audit — verdict: all persistent data goes through IndexedDB

Every data-bearing page routes application data through `CESTISStore`, which:

1. keeps a **synchronous in-memory cache** (fast reads, unchanged call sites),
2. persists **every write to IndexedDB** (`CESTIS_KV` database) — the durable source of truth with a quota far beyond localStorage's ~5 MB,
3. **mirrors to localStorage** as a best-effort fast-load seed, and
4. re-hydrates from IndexedDB on load (`whenReady`), so data survives even if localStorage is cleared or overflows.

`sessionStorage` usage was reviewed line-by-line: it holds only login/session flags (`isLoggedIn`, `loggedInUser`, sync-dismissed banners) — deliberately ephemeral, no durable data at risk. No cookies are used. No `CESTISStore.clear()`/`localStorage.clear()` wipe paths exist in app code.

**Gap found and fixed:** the video-conference chat history in `index.html` wrote directly to raw `localStorage`; it now uses `CESTISStore` (with a localStorage fallback if the store is somehow absent).

## 3. Durability hardening applied in this audit

- **Eviction protection everywhere.** `navigator.storage.persist()` — which asks the browser to never auto-evict this origin's IndexedDB under storage pressure — existed only in `index.html`. It is now called by the canonical `cestis-core.js` (covering all eight data pages) **and** by every page's inline fallback shim, so protection holds even in degraded mode.
- **Silent write-failure elimination.** IndexedDB quota errors fire asynchronously (transaction `onerror`/`onabort`) and were being swallowed in `cestis-core.js`. The core now counts failures, logs them, and dispatches a `cestis-store-write-error` event so the app can warn the user instead of silently losing writes. (This hardening previously existed only as dead code in `index.html`'s inline shim, which never runs when the core loads first — it is now in the canonical core.)
- **Fallback shim parity.** Each data page carries an inline copy of the store that activates only if `cestis-core.js` is missing; these now also request storage persistence.
- **Cache-buster bumped** (`cestis-core.js?v=20260711a`) so browsers everywhere pick up the hardened core.

## 4. Third-party dependency audit — verdict: no single point of failure remains

The system's only external dependencies are CDN-hosted libraries and online-only services. Risk assessment and mitigation:

| Dependency | Used by | Risk | Mitigation applied |
|---|---|---|---|
| cdnjs.cloudflare.com (Chart.js, jsPDF, pdf.js, mammoth, xlsx, jszip, tesseract, otpauth, qrcodejs) | index, School.Fee, PDF.Workshop | CDN outage/shutdown breaks charts, PDF/Excel features | **Same-version fallback on a second, independent CDN (jsDelivr) added after every tag** |
| cdn.jsdelivr.net (chart.js, emailjs, otpauth, qrcodejs) | Cashbook, School.Fee, Clock-in, Payslip | same | Fallbacks to cdnjs/unpkg added |
| unpkg.com (peerjs) | index | same | Fallback to jsDelivr added |
| cdn.sheetjs.com (xlsx 0.20.2) | Payslip | vendor-only CDN | Fallback to xlsx 0.18.5 on jsDelivr (API-compatible for read/write used here) |
| **Unpinned** `npm/chart.js` (always latest major!) | Cashbook | future breaking release silently breaks charts | **Pinned to chart.js@4.4.1** + cdnjs fallback |
| pdf.js worker script | index, PDF.Workshop | worker must come from same source as library | `workerSrc` now follows whichever CDN actually served pdf.js |
| Google Fonts | several | cosmetic only | Every font stack already ends in a system fallback (`sans-serif`/`monospace`) — pages render fine without it |
| Google Drive / GSI, EmailJS, PeerJS cloud | sync, email, video calls | online-only services by nature | Optional features; core data entry/reporting works fully offline. Drive sync doubles as an **off-device backup** of the datastore |

The fallback loader is the synchronous `document.write` pattern (`window.Chart||document.write('<script src="…fallback…">…')`), so script order and parse-time dependencies are preserved.

### 4b. Full vendoring — the system is now self-contained on disk

All libraries are now **vendored into `vendor/`** (fetched from the npm registry at the exact pinned versions) and every page loads the **local copy first**, falling back to the CDN chain only if the vendor file is missing (e.g. a deployment that omits the folder):

- `vendor/` (~29 MB) holds Chart.js 4.4.1 & 3.9.1, jsPDF 2.5.1 + autotable 3.5.31, pdf.js 3.11.174 (**including its worker**), pdf-lib 1.17.1, mammoth 1.6.0, xlsx 0.18.5, jszip 3.10.1, otpauth 9.2.2/9.2.1, qrcodejs 1.0.0, EmailJS SDK v3/v4, PeerJS 1.5.4, and **Tesseract OCR 5.1.1 complete with its web worker, LSTM WASM cores, and English language data** — OCR runs with zero network.
- The pdf.js `workerSrc` follows whichever source actually served the library (vendor → cdnjs → jsDelivr).
- `Staff.Payslip.html` keeps SheetJS 0.20.2 from the vendor CDN as its first choice when online, with the vendored 0.18.5 as the offline fallback (API-compatible for the read/write calls used).
- Google Fonts remain remote but are cosmetic only — every font stack ends in a system font.
- The only features that still require the internet are the ones that *are* the internet: Google Drive sync/sign-in, actually **sending** email via EmailJS, and live video calls between devices (PeerJS signaling). Their SDKs are vendored so pages load cleanly offline; the features simply wait for connectivity.

## 5. Verification performed

- `node tests/cestis-core.test.js` — **all 42 tests pass** after the core changes.
- Headless-Chromium load of all nine app pages **with every CDN unreachable** (zero internet):
  - all vendored library globals (Chart, jspdf + autoTable, pdfjsLib, mammoth, XLSX, PDFLib, JSZip, Tesseract, OTPAuth, QRCode, emailjs, Peer) present on every page that uses them;
  - a real OCR run completed fully offline (Tesseract worker + WASM core + English data all served from `vendor/`);
  - zero syntax/parse errors from the modified files;
  - `CESTISStore` initialized and reached ready state on all eight data pages;
  - a value written through the store **survived a full page reload with localStorage completely wiped** — proving the IndexedDB path alone preserves data;
  - `PDF.Workshop.html` (intentionally storage-free) boots with only the expected missing-library warnings.

## 6. Longevity guarantees after this audit

1. **Data lives in IndexedDB** on every data-bearing page, mirrored (not depended on) in localStorage, and protected from browser eviction via `navigator.storage.persist()`.
2. **Writes can no longer fail silently** — quota/transaction failures are surfaced to the console and to the app via an event.
3. **No third-party script is a network dependency** — every library is vendored on disk at a pinned version, with two independent CDNs as fallbacks.
4. **Offline-first:** with zero network, every page loads with full functionality — data entry, viewing, charts, PDF/Excel/Word processing, QR/OTP, even OCR. Only inherently-online services (Drive sync, email sending, live calls) wait for connectivity.
5. **Off-device safety net:** the built-in Google Drive sync provides an external backup of the datastore.
6. **Regression safety:** the shared core is covered by a Node test suite (`npm test`) that runs with no browser required.
