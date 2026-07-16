# C.E.S.T.I.S System Longevity Audit

**Last full audit:** 2026-07-16 · **Scope:** the whole codebase — `index.html` (main LMS), the sibling apps (`School.Fee.html`, `Staff.Payslip.html`, `Staff.Clock.in.html`, `CESTIS.Cashbook.html`, `Virement.Request.html`, finance docs, transcript pages), `cestis-core.js`, `Pages/*` fragments, and `vendor/`. · **Goal:** the system must keep working and keep its data indefinitely — offline, across browser restarts, across devices, and across the disappearance of any single third-party service.

This audit was run with **real-browser verification**, not just static review: every page was loaded headless with all network blocked, and the auth/sync/storage flows were exercised. That is how the two runtime-only defects below (which passed a plain syntax check) were caught.

---

## 1. Architecture (unchanged core model)

| Layer | Files | Role |
|---|---|---|
| Main app | `index.html` | Full LMS; loads the shared data core |
| Sibling apps | `School.Fee.html`, `Staff.Payslip.html`, `Staff.Clock.in.html`, `CESTIS.Cashbook.html`, `Virement.Request.html`, finance/transcript pages | Separate apps, each with its own store keys, sharing the same-origin IndexedDB (`CESTIS_KV`) and the Google-Drive backup model |
| Shared core | `cestis-core.js` | `CESTISStore` (IndexedDB w/ synchronous cache + localStorage mirror) + pure domain logic (merge/dedupe/relink/snapshot/finance/transcript), 83 Node unit tests |
| UI fragments | `Pages/*.html`, `LMS-Chat*`, `Video-Conference*` | Markup-only, injected via `innerHTML`; no scripts, no storage (verified) |

Data flows: in-memory cache → **IndexedDB** (durable source of truth) → localStorage mirror (fast-load seed) → Google Drive (off-device backup + cross-device sync). Verified on all 10 data pages that a value written through the store **survives a full reload with localStorage wiped** (IndexedDB path alone preserves it).

---

## 2. Defects found and FIXED in this audit

### Runtime-only corruption (would pass a syntax check, breaks the page)
- **Login page dead / "Sync Now" broken (CRITICAL).** A regex in the User-Login helper contained stray control-character bytes (`\x00–\x1f`) — a valid *token* but an invalid *RegExp*, throwing "Range out of order" at load and leaving **every** function undefined. Fixed; a repo-wide control-byte scan is now clean.
- **`cestis-core.js` control bytes.** Raw `0x00`/`0x01` inside `stableStringify` string literals replaced with `\u` escapes; checksum tests confirm byte-identical output.

### Authentication & credentials
- **Default-credential backdoor (CRITICAL).** Seeded admin/adminstaff/cmc accounts shipped with a password published in this **public** repo, so anyone could sign in on a fresh device or clone. Accounts still holding a known default are now flagged (synchronously for plaintext, plus a hash-verify sweep for already-hashed ones) and **forced through a change-password dialog before `enterApp` grants access**; cancelling refuses entry; the flag clears across devices once changed.
- **Weak password hashing → PBKDF2.** Was unsalted-per-user SHA-256 with a fixed app salt. Now PBKDF2-HMAC-SHA256 with a random per-user salt (`pbkdf2$iter$salt$hash`), legacy hashes still verify, and a correct login transparently upgrades the stored hash.
- **2FA never propagated across devices.** The account merge whitelisted fields and dropped `twoFactorEnabled/twoFactorSecret/backupCodes`. Now merged newest-wins with backup-code union — in `index.html` **and** in `Staff.Payslip.html` (same bug, 4 sites).
- **2FA library-missing lockout.** A 2FA login used to hard-block if the OTPAuth library failed to load. Now falls back to backup codes / emailed code (neither needs the library).

### Sync integrity
- **Account edits reverting on sync (HIGH).** `userAccounts` merged cloud-over-local with no recency guard, so a stale device could revert a password reset / status / role / email change. Added an `updatedAt` stamp (`touchAccount`) on every account mutation and a newest-wins guard in both merge paths.
- **Login/cert dangling after sync.** Student dedupe now applies its id-remap to accounts/approvals/attendance/exam/transcript records instead of discarding it; account & approval dedup keep the *best* record (real password/active; approved) instead of order-dependent first-wins.
- **Offline account load.** Accounts are re-read once IndexedDB hydration completes and the login-button gate re-runs, so accounts survive a localStorage wipe and unlock offline login with no network.

### OTP / brute-force
- **Emailed OTP now has an attempt cap** (6 tries, then invalidated) in `School.Fee`, `Staff.Payslip`, `Staff.Clock.in` — previously expiry-only and brute-forceable. The main app's emailed OTP already had single-use + expiry + attempt-cap + purpose/account binding.

### Backup coverage
- **Finance/cashbook/virement had no Google-independent backup.** `exportDataBackup()` now includes the sibling apps' keys (finance docs, cashbook, virements, budgets, per-quarter buckets, staff time-clock/payroll) via explicit list + dynamic prefix sweep; restore writes back every key. Verified the export payload contains them.
- Minor: guarded `window.CESTISCore.Finance` in `Payments.Invoices.html`; removed password-length console logging in `Staff.Payslip.html`.

### Verified sound (no action needed)
Quota/write-error surfacing (`cestis-store-write-error` → visible "storage failing" banner), token 401/403 handling (stops autosave, clears token, banner; local data untouched), duplicate-file-fork guards, `{version,data}` + legacy envelope tolerance, master-snapshot add-only reconcile, logout final-save ordering, `Pages/*` purity, all local `vendor/` script refs present and pinned with CDN fallbacks, and the finance/transcript test suites.

---

## 3. Known RESIDUAL risks (documented, not yet changed)

These are real but lower-severity or architectural; left as-is to avoid destabilising the sync core, and recorded here so they are tracked, not forgotten.

| Risk | Severity | Note |
|---|---|---|
| ~~No conflict check on the 5 s auto-save; no periodic pull.~~ **FIXED (2026-07-16).** | — | Auto-save now checks the main backup file's Drive `version` before every write; if another device wrote since we last saw it, we **pull+merge their changes first** (`pullMainIfRemoteNewer`), so a write can never silently clobber unseen data. Our own writes record the returned `version` so we don't re-pull them. This also serves as the **periodic cross-device pull** (runs every autosave tick, downloads only on actual change). A sub-second race remains between the version GET and the PATCH, but it is covered by the additive/newest-wins merges and self-heals on the next tick. Verified with a mocked-Drive test of the version-decision logic. |
| **Deletions don't propagate for non-student records** (tombstones exist only for students / fee LMS ids). Deleting an exam/announcement/account on one device can be resurrected by another. | MEDIUM | Extend the tombstone-union pattern to the other id-keyed collections. |
| **`Date.now()`-based ids for some cross-device records** (accounts `USR-<ts>`, announcements, notifications, sessions). Two devices in the same ms collide. | MEDIUM | Partly shielded by username/title dedupe; use the stable-id/hash pattern (as `USR-SYNC` now does) for the rest. |
| **Non-admin devices may upload full core collections** (`students` etc.) which can be a filtered subset. | MED (SUSPECTED, deployment-dependent) | Read-merges are additive so populated devices survive; a fresh admin pulling a truncated file first would inherit it. Gate non-admin uploads or make them additive-only. |
| **No silent Google-token refresh.** The ~1 h token expires and sync stops until manual reconnect (local data safe). | STALENESS | Add a token-refresh path or a clear "reconnect to resume backup" nudge. |
| **Sibling apps store passwords in plaintext** (`cestiUsers`, `dashboardUsers`, `cestisStaffMembers`) with no hashed-format handling. | SECURITY / latent | They don't read the LMS `userAccounts`, so PBKDF2 doesn't reach them today — but if a hashed value ever enters those stores their `password === input` check fails with no fallback. Keep `cestisStaffMembers` (shared with `index.html`) plaintext in lockstep, or hash both together. |
| **Sibling wholesale-restore paths** (`users = backup.data.users`, `staffMembers = …`) can drop local-only records if a pull precedes a push. | MEDIUM | Merge instead of replace. |
| **`Transcript-Grades.html`** loads `vendor/jspdf` with no CDN fallback; **Cashbook** seeds a hardcoded default fiscal year `2025/2026`; **Qual-Plan** view is Google-Drive-only (no local fallback). | LOW / cosmetic | Redundancy/aging nits. |

---

## 4. Longevity guarantees after this audit

1. **Data lives in IndexedDB** on every data page, mirrored (not depended on) in localStorage, eviction-protected via `navigator.storage.persist()`, and re-hydrated on load — proven to survive a localStorage wipe.
2. **Writes can't fail silently** — quota/transaction failures surface to the user.
3. **No third-party script is a network dependency** — every library is vendored and pinned, with two CDN fallbacks; full offline operation verified for all 22 pages.
4. **Off-device + Google-independent backups both exist** — Google Drive sync **and** a local JSON export that now covers *all* modules (LMS + finance + cashbook + virement + payroll).
5. **Credentials are hardened** — PBKDF2 per-user salting, no published default that grants access, forced first-run change, 2FA that survives sync, and brute-force-capped OTP.
6. **Regression safety** — 83 Node unit tests plus a headless page-load harness that catches runtime-only breakage.

*The main cross-device lost-update window (section 3) is now closed by version-gated pull-before-write. Remaining residuals are lower-severity (non-student delete propagation, `Date.now()` ids, sibling plaintext passwords, silent token refresh) and are tracked above.*
