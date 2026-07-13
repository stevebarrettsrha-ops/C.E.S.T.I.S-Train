/* ============================================================================
   finance-logos.js — the fixed brand marks that appear on the printed finance
   documents. These point at the real CESTIS / HEART-NSTA logo image files that
   the office committed to the repository, so the documents render the exact
   artwork (no hand-drawn approximation, no user upload required).

     FINANCE_LOGOS.shield     — CESTIS educational crest, used on the
                                School / RBF (HEART-NSTA) subvention invoice.
     FINANCE_LOGOS.technical  — CESTIS Technical Services Ltd, used on the
                                commercial invoice and quote.
     FINANCE_LOGOS.heart      — HEART / NSTA Trust, used on the cheque voucher.

   The source files live beside the HTML pages in the repository root:
     "CESTI Logo 2-Photoroom (1).png"  (crest)
     "CESTIS TECH - INVOICE.png"       (technical services)
     "HEART NSTA TRUST - Logo.png"     (HEART/NSTA)
   Spaces are %20-encoded in the src below. Each value is a self-contained
   <img> tag so callers can drop it straight into the page.
   ============================================================================ */
(function (root) {
  'use strict';

  function img(src, alt) { return '<img class="fin-logo" alt="' + alt + '" src="' + src + '">'; }

  root.FINANCE_LOGOS = {
    shield:    img('CESTI%20Logo%202-Photoroom%20(1).png', 'Community Educational and Skills Training Institute and Services Ltd'),
    technical: img('CESTIS%20TECH%20-%20INVOICE.png', 'CESTIS Technical Services Ltd'),
    heart:     img('HEART%20NSTA%20TRUST%20-%20Logo.png', 'HEART/NSTA Trust')
  };

})(typeof window !== 'undefined' ? window : this);
