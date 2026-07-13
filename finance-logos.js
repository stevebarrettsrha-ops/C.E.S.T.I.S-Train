/* ============================================================================
   finance-logos.js — the fixed brand marks that appear on the printed finance
   documents. These are the real CESTIS / HEART-NSTA logos rebuilt as inline
   SVG so they render crisply on screen and in print without depending on a
   user-uploaded image.

     FINANCE_LOGOS.shield     — CESTIS educational crest (green), used on the
                                School / RBF (HEART-NSTA) subvention invoice.
     FINANCE_LOGOS.technical  — CESTIS Technical Services Ltd (red / blue),
                                used on the commercial invoice and quote.
     FINANCE_LOGOS.heart      — HEART / NSTA Trust, used on the cheque voucher.

   Each value is a self-contained <svg> string.
   ============================================================================ */
(function (root) {
  'use strict';

  var GREEN = '#0e8a3e', GREEN_DK = '#0a7233', BLUE = '#1f5fbf';

  /* ---------------------------------------------------------- CESTIS crest */
  /* Dense green laurel wreath encircling a blue-edged shield split by dotted
     blue lines into four quadrants (book & pencils, bed, chef's hat with
     spoon & fork, angle grinder) over a scrolled banner reading
     EMPOWERING COMMUNITIES - YHWH. */
  function laurel(side) {
    // side = 1 right / -1 left. Leaves follow a circular arc from near the
    // top of the crest down to the banner; each node carries an outer and an
    // inner leaf so the wreath reads as a dense braid.
    var cx = 250, cy = 258, leaves = '';
    for (var i = 0; i < 15; i++) {
      var phi = 22 + i * 9.2;                       // degrees from 12 o'clock
      var rad = phi * Math.PI / 180;
      var rot = side * (phi - 90);                  // tangent to the arc
      var xo = cx + side * 186 * Math.sin(rad), yo = cy - 186 * Math.cos(rad);
      var xi = cx + side * 164 * Math.sin(rad), yi = cy - 164 * Math.cos(rad);
      leaves += '<g transform="translate(' + xo.toFixed(1) + ',' + yo.toFixed(1) + ') rotate(' + (rot + side * 28).toFixed(1) + ')">'
              + '<path d="M0 -16 Q7 0 0 16 Q-7 0 0 -16 Z" fill="' + GREEN + '"/></g>'
              + '<g transform="translate(' + xi.toFixed(1) + ',' + yi.toFixed(1) + ') rotate(' + (rot - side * 14).toFixed(1) + ')">'
              + '<path d="M0 -13 Q6 0 0 13 Q-6 0 0 -13 Z" fill="' + GREEN_DK + '"/></g>';
    }
    return '<g>' + leaves + '</g>';
  }

  var SHIELD_PATH = 'M250 128 C303 156 358 161 388 159 C388 292 350 362 250 414 C150 362 112 292 112 159 C142 161 197 156 250 128 Z';

  var CREST = '<svg viewBox="0 0 500 505" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Community Educational and Skills Training Institute and Services Ltd">'
    + laurel(-1) + laurel(1)
    /* shield: blue outer edge with a green inner line */
    + '<path d="' + SHIELD_PATH + '" fill="#ffffff" stroke="' + BLUE + '" stroke-width="10"/>'
    + '<path d="' + SHIELD_PATH + '" fill="none" stroke="' + GREEN + '" stroke-width="4" transform="translate(15 16.2) scale(0.94)"/>'
    /* dotted quartering lines */
    + '<line x1="250" y1="140" x2="250" y2="404" stroke="' + BLUE + '" stroke-width="3.5" stroke-dasharray="3 7" stroke-linecap="round"/>'
    + '<line x1="122" y1="264" x2="378" y2="264" stroke="' + BLUE + '" stroke-width="3.5" stroke-dasharray="3 7" stroke-linecap="round"/>'
    /* TL — book & pencils */
    + '<g stroke="' + GREEN + '" stroke-width="7" fill="none" stroke-linejoin="round" stroke-linecap="round">'
    +   '<path d="M152 182 h44 a8 8 0 0 1 8 8 v46 a8 8 0 0 1 -8 8 h-44 Z"/>'
    +   '<path d="M152 182 v62 a8 8 0 0 0 8 8 h44" stroke-width="5"/>'
    +   '<line x1="222" y1="188" x2="222" y2="244"/><path d="M216 188 l6 -12 l6 12"/>'
    +   '<line x1="238" y1="196" x2="238" y2="244"/><path d="M233 196 l5 -10 l5 10"/></g>'
    /* TR — bed */
    + '<g stroke="' + GREEN + '" stroke-width="7" fill="none" stroke-linejoin="round" stroke-linecap="round">'
    +   '<line x1="274" y1="178" x2="274" y2="242"/><line x1="352" y1="178" x2="352" y2="242"/>'
    +   '<circle cx="274" cy="172" r="5" fill="' + GREEN + '" stroke="none"/><circle cx="352" cy="172" r="5" fill="' + GREEN + '" stroke="none"/>'
    +   '<path d="M274 196 q39 -20 78 0" stroke-width="5"/>'
    +   '<line x1="268" y1="226" x2="358" y2="226"/>'
    +   '<line x1="274" y1="226" x2="274" y2="244"/><line x1="352" y1="226" x2="352" y2="244"/></g>'
    /* BL — chef's hat, spoon & fork */
    + '<g stroke="' + GREEN + '" stroke-width="6" fill="none" stroke-linejoin="round" stroke-linecap="round">'
    +   '<path d="M166 322 v-9 q-20 -3 -16 -23 q3 -15 18 -15 q6 -14 24 -6 q18 -8 24 6 q15 0 18 15 q4 20 -16 23 v9 Z"/>'
    +   '<line x1="166" y1="312" x2="220" y2="312" stroke-width="4"/>'
    +   '<line x1="158" y1="376" x2="176" y2="352"/>'
    +   '<path d="M176 352 l10 -13 m-16 5 l8 -10 m-1 16 l9 -11" stroke-width="4.5"/>'
    +   '<line x1="228" y1="376" x2="212" y2="354"/>'
    +   '<ellipse cx="205" cy="345" rx="8" ry="12" transform="rotate(-38 205 345)"/></g>'
    /* BR — angle grinder (green body, blue disc) */
    + '<g fill="none" stroke-linejoin="round" stroke-linecap="round">'
    +   '<circle cx="298" cy="356" r="17" stroke="' + BLUE + '" stroke-width="6"/>'
    +   '<path d="M281 344 a21 21 0 0 1 34 -4" stroke="' + BLUE + '" stroke-width="7"/>'
    +   '<path d="M306 334 h48 a10 10 0 0 1 10 10 v10 a10 10 0 0 1 -10 10 h-42" stroke="' + GREEN + '" stroke-width="7"/>'
    +   '<line x1="364" y1="344" x2="378" y2="344" stroke="' + GREEN + '" stroke-width="9"/>'
    +   '<circle cx="298" cy="356" r="4" fill="' + BLUE + '" stroke="none"/></g>'
    /* banner: notched arrow tails + curved band with the motto */
    + '<g>'
    +   '<path d="M120 420 L48 436 L64 448 L52 468 L124 452 Z" fill="' + GREEN + '"/>'
    +   '<path d="M380 420 L452 436 L436 448 L448 468 L376 452 Z" fill="' + GREEN + '"/>'
    +   '<path d="M116 440 Q250 402 384 440 L378 478 Q250 442 122 478 Z" fill="' + GREEN + '"/>'
    +   '<defs><path id="crestMotto" d="M118 472 Q250 428 382 472"/></defs>'
    +   '<text font-family="Georgia, serif" font-size="13.5" font-style="italic" fill="#ffffff">'
    +     '<textPath href="#crestMotto" startOffset="50%" text-anchor="middle">EMPOWERING COMMUNITIES - YHWH</textPath>'
    +   '</text>'
    + '</g>'
    + '</svg>';

  /* ----------------------------------------------- CESTIS Technical Services */
  /* Red square (black CES) overlapping a blue rectangle (white TIS), with
     TECHNICAL SERVICES LTD across the bottom. */
  var TECHNICAL = '<svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CESTIS Technical Services Ltd">'
    + '<rect x="322" y="92" width="334" height="176" fill="#1e50a0"/>'
    + '<rect x="34" y="20" width="300" height="300" fill="#e5342b"/>'
    + '<text x="184" y="238" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="168" fill="#111111" text-anchor="middle" textLength="292" lengthAdjust="spacingAndGlyphs">CES</text>'
    + '<text x="490" y="232" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="150" fill="#ffffff" text-anchor="middle" textLength="288" lengthAdjust="spacingAndGlyphs">TIS</text>'
    + '<text x="350" y="382" font-family="Arial, sans-serif" font-weight="700" font-size="52" fill="#111111" text-anchor="middle" textLength="640" lengthAdjust="spacingAndGlyphs">TECHNICAL SERVICES  LTD</text>'
    + '</svg>';

  /* --------------------------------------------------------- HEART / NSTA */
  /* Three dots over a rounded blue box reading HEART, with NSTA in bold
     italics and TRUST letter-spaced beneath. */
  var HB = '#1b7fc4';
  var HEART = '<svg viewBox="0 0 200 170" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="HEART/NSTA Trust">'
    + '<circle cx="56" cy="16" r="10" fill="' + HB + '"/>'
    + '<circle cx="100" cy="16" r="10" fill="' + HB + '"/>'
    + '<circle cx="144" cy="16" r="10" fill="' + HB + '"/>'
    + '<rect x="28" y="36" width="144" height="48" rx="14" fill="' + HB + '"/>'
    + '<text x="100" y="72" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="34" fill="#ffffff" text-anchor="middle" textLength="120" lengthAdjust="spacingAndGlyphs">HEART</text>'
    + '<text x="100" y="128" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-style="italic" font-size="42" fill="' + HB + '" text-anchor="middle" textLength="128" lengthAdjust="spacingAndGlyphs">NSTA</text>'
    + '<text x="100" y="148" font-family="Arial, sans-serif" font-weight="700" font-size="13" fill="' + HB + '" text-anchor="middle" letter-spacing="7">TRUST</text>'
    + '</svg>';

  root.FINANCE_LOGOS = { shield: CREST, technical: TECHNICAL, heart: HEART };

})(typeof window !== 'undefined' ? window : this);
