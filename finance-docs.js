/* ============================================================================
   finance-docs.js — shared document engine for the Payments/Invoices module.

   One engine drives Finance.Invoice.html, Finance.Quote.html and
   Finance.Purchase.Order.html so the three document types cannot drift apart:
   each page supplies a small config (labels, storage key, number seed, extra
   blocks) and this file renders the editor, the live A4 paper preview, the
   saved-documents list, and handles persistence through CESTISStore.

   The paper layout reproduces the office's real Excel invoices/quotes
   (CESTIS__INVOICE.xlsx): company block, BILLED TO block, item rows with
   "Materials Needed" note lines, SUBTOTAL / DISCOUNT / TAX / AMOUNT DUE and
   the cheques-payable footer — plus the school/RBF variant with percentage ×
   budget columns and the signatories block.

   Pure calculations (totals, numbering, amount-in-words) live in
   cestis-core.js (Core.Finance) where they are unit tested.
   ============================================================================ */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var F = function () { return root.CESTISCore && root.CESTISCore.Finance; };

  var COMPANY = {
    name: 'Community Educational and Skills Training Institute and Services',
    legal: 'COMMUNITY EDUCATIONAL AND SKILLS TRAINING INSTITUTE AND SERVICES LTD.',
    addr1: 'Address: Mack Chem Complex',
    addr2: 'Paisley Avenue, May Pen P.O. Clarendon',
    phone: 'Phone: 876-679-0111, 876-365-2325',
    email: 'Email: cestisadmn@gmail.com',
    website: 'Website: www.hstc-ctdi.com',
    trn: 'TRN #: 003-731-804',
    bank: 'BANK ACCOUNT#: 561722854',
    contactFooter: 'Company Phone Number: 876-679-0111, Email: cestisadmn@gmail.com'
  };

  var BILLED_TO_COMMERCIAL = 'May Pen Hospital - SRHA\n1 Muirhead Avenue, Denbigh\nMay Pen P.O., Clarendon';
  var BILLED_TO_RBF = 'HEART NSTA Trust\n6B Oxford Road\nKingston 5, St. Andrew';

  var cfg = null;      // page config, set by init()
  var docs = [];       // saved documents
  var current = null;  // document being edited
  var dirty = false;

  /* ------------------------------------------------------------------ store */
  function store() { return root.CESTISStore || root.localStorage; }
  function loadDocs() {
    try { var raw = store().getItem(cfg.storageKey); docs = raw ? JSON.parse(raw) : []; }
    catch (e) { docs = []; }
    if (!Array.isArray(docs)) docs = [];
  }
  function persistDocs() { store().setItem(cfg.storageKey, JSON.stringify(docs)); }

  /* ------------------------------------------------------------------ utils */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return F().formatMoney(n); }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) { // 2026-03-24 -> 24/03/2026 (how the office writes dates)
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso);
  }
  function addDays(iso, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || todayISO()));
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function toast(msg) {
    var t = $('fdToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ---------------------------------------------------------------- new doc */
  function newDoc() {
    var d = {
      id: 'FD-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      docType: cfg.docType,
      number: String(F().nextDocNumber(docs.map(function (x) { return x.number; }), cfg.numberSeed)),
      template: 'standard',
      status: cfg.hasStatus ? 'Draft' : '',
      date: todayISO(),
      dueDate: addDays(todayISO(), cfg.dueDays),
      billedTo: cfg.docType === 'po' ? '' : BILLED_TO_COMMERCIAL,
      supplier: '',
      deliverTo: cfg.docType === 'po' ? 'Hazard Skills Training Centre\nMack Chem Complex, Paisley Avenue\nMay Pen P.O., Clarendon' : '',
      poNumber: '', poDate: '',
      items: [
        { itemNo: '', description: '', qty: 1, unitPrice: 0, isNote: false },
        { itemNo: '', description: '', qty: 0, unitPrice: 0, isNote: true }
      ],
      discountPct: 0, taxPct: 0, depositPct: 0,
      notes: '',
      revisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return d;
  }

  /* ================================================================= EDITOR */
  function renderEditor() {
    var d = current;
    var school = d.template === 'school';
    var html = '';

    html += '<div class="fd-form-grid">';
    html += fld(cfg.labels.noLabel, '<input type="text" id="fNumber" value="' + esc(d.number) + '">');
    html += fld(cfg.labels.dateLabel, '<input type="date" id="fDate" value="' + esc(d.date) + '">');
    html += fld(cfg.labels.dueLabel, '<input type="date" id="fDueDate" value="' + esc(d.dueDate) + '">');
    if (cfg.hasTemplates) {
      html += fld('Template', '<select id="fTemplate"><option value="standard"' + (school ? '' : ' selected') + '>Standard (Commercial)</option><option value="school"' + (school ? ' selected' : '') + '>School / RBF (HEART-NSTA)</option></select>');
    }
    if (cfg.hasStatus) {
      html += fld('Status', '<select id="fStatus"><option' + (d.status === 'Draft' ? ' selected' : '') + '>Draft</option><option' + (d.status === 'Issued' ? ' selected' : '') + '>Issued</option></select>');
    }
    html += '</div>';

    if (cfg.docType === 'po') {
      html += '<div class="fd-form-grid two">';
      html += fld('Supplier / Vendor (name & address, one per line)', '<textarea id="fSupplier" rows="3">' + esc(d.supplier) + '</textarea>');
      html += fld('Deliver To', '<textarea id="fDeliverTo" rows="3">' + esc(d.deliverTo) + '</textarea>');
      html += '</div>';
    } else {
      html += '<div class="fd-form-grid two">';
      html += fld('Billed To (name & address, one per line)', '<textarea id="fBilledTo" rows="3">' + esc(d.billedTo) + '</textarea>');
      html += '<div class="fd-form-grid" style="align-content:start;">'
            + fld('Purchase Order # (optional)', '<input type="text" id="fPoNumber" value="' + esc(d.poNumber) + '">')
            + fld('Purchase Date (optional)', '<input type="date" id="fPoDate" value="' + esc(d.poDate) + '">')
            + '</div>';
      html += '</div>';
    }

    /* items */
    html += '<div class="fd-items-head"><h3>' + (school ? 'RBF — Requirements Met' : 'Line Items') + '</h3>'
          + '<div><button class="btn small" onclick="FinanceDoc.addItem(false)">+ Item Row</button> '
          + '<button class="btn small ghost" onclick="FinanceDoc.addItem(true)">+ Description / Materials Row</button></div></div>';
    html += '<table class="fd-items-table"><thead><tr><th style="width:56px;">Item #</th><th>' + (school ? 'Requirement' : 'Product / Service')
          + '</th><th style="width:84px;">' + (school ? '%' : 'Qty') + '</th><th style="width:120px;">' + (school ? 'Budget Amt' : 'Unit Price')
          + '</th><th style="width:110px;">Total</th><th style="width:92px;"></th></tr></thead><tbody>';
    d.items.forEach(function (it, i) {
      if (it.isNote) {
        html += '<tr class="note-row"><td></td><td colspan="4"><input type="text" class="full" placeholder="e.g. Materials Needed: ..." value="' + esc(it.description) + '" oninput="FinanceDoc.setItem(' + i + ',\'description\',this.value)"></td>'
              + '<td class="row-actions">' + rowBtns(i) + '</td></tr>';
      } else {
        html += '<tr><td><input type="text" value="' + esc(it.itemNo) + '" oninput="FinanceDoc.setItem(' + i + ',\'itemNo\',this.value)"></td>'
              + '<td><input type="text" class="full" value="' + esc(it.description) + '" oninput="FinanceDoc.setItem(' + i + ',\'description\',this.value)"></td>'
              + '<td><input type="number" step="any" value="' + esc(it.qty) + '" oninput="FinanceDoc.setItem(' + i + ',\'qty\',this.value)"></td>'
              + '<td><input type="number" step="any" value="' + esc(it.unitPrice) + '" oninput="FinanceDoc.setItem(' + i + ',\'unitPrice\',this.value)"></td>'
              + '<td class="fd-line-total">' + money(F().lineTotal(it, school)) + '</td>'
              + '<td class="row-actions">' + rowBtns(i) + '</td></tr>';
      }
    });
    html += '</tbody></table>';

    html += '<div class="fd-form-grid" style="margin-top:14px;">';
    html += fld('Discount %', '<input type="number" step="any" id="fDiscount" value="' + esc(d.discountPct) + '">');
    html += fld('Tax %', '<input type="number" step="any" id="fTax" value="' + esc(d.taxPct) + '">');
    html += fld('Deposit Required % (0 = none)', '<input type="number" step="any" id="fDeposit" value="' + esc(d.depositPct) + '">');
    html += '</div>';
    if (cfg.hasStatus) {
      html += fld('Revision note (kept in the document history when you save changes)', '<input type="text" id="fRevNote" placeholder="e.g. Corrected qty on line 2">');
    }

    $('fdEditor').innerHTML = html;

    /* wire meta inputs */
    [['fNumber', 'number'], ['fDate', 'date'], ['fDueDate', 'dueDate'], ['fBilledTo', 'billedTo'],
     ['fSupplier', 'supplier'], ['fDeliverTo', 'deliverTo'], ['fPoNumber', 'poNumber'], ['fPoDate', 'poDate'],
     ['fDiscount', 'discountPct'], ['fTax', 'taxPct'], ['fDeposit', 'depositPct'], ['fStatus', 'status']]
      .forEach(function (pair) {
        var el = $(pair[0]);
        if (el) el.addEventListener('input', function () { current[pair[1]] = el.value; dirty = true; renderPaper(); });
      });
    var tpl = $('fTemplate');
    if (tpl) tpl.addEventListener('change', function () {
      current.template = tpl.value;
      /* offer the matching default recipient when the block is still untouched */
      if (tpl.value === 'school' && current.billedTo === BILLED_TO_COMMERCIAL) current.billedTo = BILLED_TO_RBF;
      else if (tpl.value !== 'school' && current.billedTo === BILLED_TO_RBF) current.billedTo = BILLED_TO_COMMERCIAL;
      dirty = true; renderEditor(); renderPaper();
    });
  }

  function fld(label, control) { return '<label class="fd-field"><span>' + label + '</span>' + control + '</label>'; }
  function rowBtns(i) {
    return '<button class="mini" title="Move up" onclick="FinanceDoc.moveItem(' + i + ',-1)">↑</button>'
         + '<button class="mini" title="Move down" onclick="FinanceDoc.moveItem(' + i + ',1)">↓</button>'
         + '<button class="mini danger" title="Remove row" onclick="FinanceDoc.removeItem(' + i + ')">✕</button>';
  }

  /* ================================================================== PAPER */
  function money$(n) { return '$' + money(n); }

  function renderPaper() {
    var d = current, school = d.template === 'school', t = F().docTotals(d);
    var isPO = cfg.docType === 'po';
    /* theme drives every coloured element on the sheet:
         green — School / RBF (HEART-NSTA) subvention invoice
         blue  — commercial invoice & quote
         slate — purchase order                                              */
    var theme = school ? 'green' : (isPO ? 'slate' : 'blue');
    var LOGOS = root.FINANCE_LOGOS || {};
    /* the crest fronts the RBF invoice and the purchase order; the commercial
       invoice and quote carry the Technical Services mark. */
    var logo = (isPO || school) ? LOGOS.shield : LOGOS.technical;

    /* the office writes DUE DATE on the RBF invoice but EXPIRATION DATE on the
       commercial invoice — both quotes read EXPIRATION DATE. */
    var dueLabel = cfg.labels.dueLabel;
    if (cfg.docType === 'invoice') dueLabel = school ? 'DUE DATE' : 'EXPIRATION DATE';

    var h = '<div class="sheet theme-' + theme + '" id="fdSheet">';

    /* coloured header band: title left, numbering right */
    h += '<div class="p-band"><div class="p-title">' + esc(cfg.labels.title) + '</div>'
       + '<div class="p-band-meta">'
       + '<div><span>' + esc(cfg.labels.noLabel) + ':</span> ' + esc(d.number) + '</div>'
       + '<div><span>' + esc(cfg.labels.dateLabel) + ':</span> ' + esc(fmtDate(d.date)) + '</div>'
       + '<div><span>' + esc(dueLabel) + ':</span> ' + esc(fmtDate(d.dueDate)) + '</div>'
       + (d.status === 'Draft' ? '<div class="p-draft">DRAFT</div>' : '')
       + '</div></div>';

    h += '<div class="p-doc-body">';

    /* brand mark */
    if (logo) h += '<div class="p-logo">' + logo + '</div>';

    /* company + billed-to blocks */
    h += '<div class="p-blocks"><div class="p-co"><div class="p-co-name">' + esc(COMPANY.name) + '</div>'
       + [COMPANY.addr1, COMPANY.addr2, COMPANY.phone, COMPANY.email].map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('')
       + '<div class="p-strong">' + esc(COMPANY.website) + '</div>'
       + (school ? '<div class="p-strong">' + esc(COMPANY.bank) + '</div>' : '')
       + '<div class="p-strong">' + esc(COMPANY.trn) + '</div></div>';
    var rightTitle = isPO ? 'SUPPLIER' : 'BILLED TO';
    var rightBody = isPO ? d.supplier : d.billedTo;
    h += '<div class="p-billed"><div class="p-billed-title">' + rightTitle + '</div>'
       + String(rightBody || '').split('\n').map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    if (!isPO && d.poNumber) h += '<div class="p-po">PURCHASE ORDER #: ' + esc(d.poNumber) + '</div>';
    if (!isPO && d.poDate) h += '<div class="p-po">PURCHASE DATE: ' + esc(fmtDate(d.poDate)) + '</div>';
    if (isPO) {
      h += '<div class="p-billed-title" style="margin-top:10px;">DELIVER TO</div>'
         + String(d.deliverTo || '').split('\n').map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    }
    h += '</div></div>';

    /* items table */
    h += '<table class="p-items"><thead><tr><th style="width:9%;">ITEM NO.</th><th>' + (school ? 'RBF - REQUIREMENTS MET' : 'PRODUCT/SERVICE')
       + '</th><th style="width:12%;">' + (school ? 'PERCENTAGE %' : 'QUANTITY') + '</th><th style="width:15%;">' + (school ? 'BUDGET AMOUNT' : 'UNIT PRICE')
       + '</th><th style="width:15%;">' + (school ? 'TOTAL COST' : 'TOTAL') + '</th></tr></thead><tbody>';
    d.items.forEach(function (it) {
      if (it.isNote) {
        if (String(it.description || '').trim()) h += '<tr class="p-note"><td></td><td colspan="4">' + esc(it.description) + '</td></tr>';
      } else {
        h += '<tr><td>' + esc(it.itemNo) + '</td><td>' + esc(it.description) + '</td><td class="num">' + (school ? esc(it.qty) + '%' : esc(it.qty))
           + '</td><td class="num">' + money$(it.unitPrice) + '</td><td class="num">' + money$(F().lineTotal(it, school)) + '</td></tr>';
      }
    });
    for (var pad = d.items.length; pad < 6; pad++) h += '<tr class="p-pad"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>';
    h += '</tbody></table>';

    /* totals + footer */
    h += '<div class="p-bottom"><div class="p-footer-notes">'
       + (isPO
          ? '<div class="p-payable">Please quote PO NO. <b>' + esc(d.number) + '</b> on all invoices, delivery notes and correspondence relating to this order.</div>'
          : '<div class="p-payable">Make all checks payable to:<br><b>' + esc(COMPANY.legal) + '</b></div>')
       + '<div>If you have any questions about this ' + esc(cfg.labels.docWord) + ' please contact us using the below details.</div>'
       + '<div>' + esc(COMPANY.contactFooter) + '</div>'
       + (d.notes ? '<div class="p-usernotes">' + esc(d.notes) + '</div>' : '')
       + '</div>';
    h += '<table class="p-totals"><tr><td>SUBTOTAL</td><td>' + money$(t.subtotal) + '</td></tr>';
    h += '<tr><td>DISCOUNT (' + esc(Number(d.discountPct) || 0) + '%)</td><td>' + money$(t.discount) + '</td></tr>';
    h += '<tr><td>TAX ' + (Number(d.taxPct) ? '(' + esc(d.taxPct) + '%)' : '(%)') + '</td><td>' + (Number(d.taxPct) ? money$(t.tax) : '') + '</td></tr>';
    h += '<tr class="p-due"><td>' + (isPO ? 'ORDER TOTAL' : 'AMOUNT DUE') + '</td><td>' + money$(t.amountDue) + '</td></tr></table></div>';
    if (Number(d.depositPct)) {
      h += '<div class="p-deposit">Deposit Required for Job (' + esc(d.depositPct) + '%) = <b>' + money$(t.deposit) + '</b></div>';
    }

    /* signature blocks */
    if (school && !isPO) {
      h += '<div class="p-signatories"><div class="p-sig-title">SIGNATORIES</div>'
         + '<table class="p-sig-table"><tr class="p-sig-head"><th>FULL NAME (IN BLOCK LETTERS)</th><th>SIGNATURES</th></tr>'
         + ['PROGRAMME COORDINATOR', 'TREASURER', 'CMC CHAIRPERSON'].map(function (role) {
             return '<tr><td><div class="p-sig-line">&nbsp;</div><div class="p-sig-role">' + role + '</div></td><td><div class="p-sig-line">&nbsp;</div></td></tr>';
           }).join('') + '</table></div>';
    }
    if (isPO) {
      h += '<div class="p-authorize"><div><div class="p-sig-line">&nbsp;</div>Authorized By (Name & Signature)</div>'
         + '<div><div class="p-sig-line">&nbsp;</div>Date</div></div>';
    }

    h += '<div class="p-thanks">THANK YOU FOR YOUR BUSINESS!</div>';
    h += '</div>';   /* /p-doc-body */
    h += '</div>';   /* /sheet     */
    $('fdPaper').innerHTML = h;
  }

  /* ============================================================= SAVED LIST */
  function renderList() {
    var el = $('fdSavedList');
    if (!el) return;
    if (!docs.length) {
      el.innerHTML = '<div class="fd-empty">No saved ' + esc(cfg.labels.docWord) + 's yet — the form above starts a new one.</div>';
      return;
    }
    var rows = docs.slice().sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); })
      .map(function (d) {
        var t = F().docTotals(d);
        var who = String((cfg.docType === 'po' ? d.supplier : d.billedTo) || '').split('\n')[0];
        return '<tr><td class="mono">' + esc(d.number) + '</td><td>' + esc(fmtDate(d.date)) + '</td><td>' + esc(who || '—') + '</td>'
             + '<td class="num">$' + money(t.amountDue) + '</td>'
             + (cfg.hasStatus ? '<td><span class="status-chip ' + (d.status === 'Issued' ? 'issued' : 'draft') + '">' + esc(d.status || 'Draft') + '</span></td>' : '')
             + '<td class="actions"><button class="mini" onclick="FinanceDoc.editDoc(\'' + d.id + '\')">✏ Edit</button>'
             + '<button class="mini" onclick="FinanceDoc.duplicateDoc(\'' + d.id + '\')">⧉ Duplicate</button>'
             + '<button class="mini" onclick="FinanceDoc.printDoc(\'' + d.id + '\')">🖨 Print</button>'
             + (cfg.canConvert ? '<button class="mini gold" onclick="FinanceDoc.convertToInvoice(\'' + d.id + '\')">→ Invoice</button>' : '')
             + '<button class="mini danger" onclick="FinanceDoc.deleteDoc(\'' + d.id + '\')">🗑</button></td></tr>';
      }).join('');
    el.innerHTML = '<table class="fd-saved-table"><thead><tr><th>' + esc(cfg.labels.noLabel) + '</th><th>Date</th><th>'
      + (cfg.docType === 'po' ? 'Supplier' : 'Billed To') + '</th><th>Amount</th>' + (cfg.hasStatus ? '<th>Status</th>' : '')
      + '<th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ================================================================ ACTIONS */
  var API = {};

  /* Quote → Invoice hand-off: the quote page stores a pre-filled invoice and
     redirects here; pick it up once and drop the baton. Called at init AND
     again once the store has finished its IndexedDB load (and once more after
     a short delay): a localStorage write made immediately before a same-tab
     navigation can miss the new document's storage snapshot in Chromium, but
     it always surfaces through the IndexedDB merge moments later. */
  function consumeConvertPayload() {
    if (cfg.docType !== 'invoice' || dirty) return;
    try {
      var raw = store().getItem('cestis_finance_convert');
      if (!raw) return;
      var payload = JSON.parse(raw);
      store().removeItem('cestis_finance_convert');
      current = Object.assign(newDoc(), payload, {
        id: 'FD-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
        docType: 'invoice',
        number: String(F().nextDocNumber(docs.map(function (x) { return x.number; }), cfg.numberSeed)),
        date: todayISO(), dueDate: addDays(todayISO(), cfg.dueDays),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      dirty = true;
      renderEditor(); renderPaper();
      toast('Quote loaded — review and save it as an invoice.');
    } catch (e) { try { console.error('[FinanceDoc] quote→invoice hand-off failed:', e); } catch (_) {} }
  }

  API.init = function (config) {
    cfg = config;
    loadDocs();
    current = newDoc();
    renderEditor(); renderPaper(); renderList();
    if (store().whenReady) store().whenReady(function () { loadDocs(); renderList(); consumeConvertPayload(); });
    consumeConvertPayload();
    setTimeout(consumeConvertPayload, 600);
  };

  API.setItem = function (i, key, val) {
    var it = current.items[i];
    if (!it) return;
    it[key] = (key === 'qty' || key === 'unitPrice') ? val : val;
    dirty = true;
    /* update just the computed cell + paper — full re-render would steal focus */
    var cell = document.querySelectorAll('.fd-items-table tbody tr')[i];
    if (cell && !it.isNote) {
      var tc = cell.querySelector('.fd-line-total');
      if (tc) tc.textContent = money(F().lineTotal(it, current.template === 'school'));
    }
    renderPaper();
  };
  API.addItem = function (isNote) {
    current.items.push({ itemNo: '', description: '', qty: isNote ? 0 : 1, unitPrice: 0, isNote: !!isNote });
    dirty = true; renderEditor(); renderPaper();
  };
  API.removeItem = function (i) { current.items.splice(i, 1); dirty = true; renderEditor(); renderPaper(); };
  API.moveItem = function (i, dir) {
    var j = i + dir;
    if (j < 0 || j >= current.items.length) return;
    var tmp = current.items[i]; current.items[i] = current.items[j]; current.items[j] = tmp;
    dirty = true; renderEditor(); renderPaper();
  };

  API.saveDoc = function () {
    current.updatedAt = new Date().toISOString();
    if (cfg.hasStatus) {
      var note = $('fRevNote') && $('fRevNote').value.trim();
      if (note) {
        current.revisions = current.revisions || [];
        current.revisions.push({ at: current.updatedAt, note: note });
        $('fRevNote').value = '';
      }
    }
    var idx = docs.findIndex(function (d) { return d.id === current.id; });
    if (idx === -1) docs.push(JSON.parse(JSON.stringify(current)));
    else docs[idx] = JSON.parse(JSON.stringify(current));
    persistDocs(); dirty = false; renderList();
    toast(cfg.labels.title + ' #' + current.number + ' saved.');
  };

  API.newDoc = function () {
    if (dirty && !confirm('Discard unsaved changes and start a new ' + cfg.labels.docWord + '?')) return;
    current = newDoc(); dirty = false;
    renderEditor(); renderPaper();
    toast('Started ' + cfg.labels.docWord + ' #' + current.number + '.');
  };

  API.editDoc = function (id) {
    var d = docs.find(function (x) { return x.id === id; });
    if (!d) return;
    if (dirty && !confirm('Discard unsaved changes and open ' + cfg.labels.docWord + ' #' + d.number + '?')) return;
    current = JSON.parse(JSON.stringify(d)); dirty = false;
    renderEditor(); renderPaper();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  API.duplicateDoc = function (id) {
    var d = docs.find(function (x) { return x.id === id; });
    if (!d) return;
    current = Object.assign(JSON.parse(JSON.stringify(d)), {
      id: 'FD-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      number: String(F().nextDocNumber(docs.map(function (x) { return x.number; }), cfg.numberSeed)),
      date: todayISO(), dueDate: addDays(todayISO(), cfg.dueDays),
      status: cfg.hasStatus ? 'Draft' : '', revisions: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    dirty = true; renderEditor(); renderPaper();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Duplicated as #' + current.number + ' — save to keep it.');
  };

  API.deleteDoc = function (id) {
    var d = docs.find(function (x) { return x.id === id; });
    if (!d) return;
    if (!confirm('Delete ' + cfg.labels.docWord + ' #' + d.number + '? This cannot be undone.')) return;
    docs = docs.filter(function (x) { return x.id !== id; });
    persistDocs(); renderList();
  };

  API.printDoc = function (id) {
    if (id) {
      var d = docs.find(function (x) { return x.id === id; });
      if (d) { current = JSON.parse(JSON.stringify(d)); dirty = false; renderEditor(); renderPaper(); }
    }
    window.print();
  };

  API.convertToInvoice = function (id) {
    var d = docs.find(function (x) { return x.id === id; }) || current;
    if (!d) return;
    var payload = JSON.parse(JSON.stringify(d));
    delete payload.id; delete payload.number; delete payload.createdAt; delete payload.updatedAt;
    payload.docType = 'invoice';
    store().setItem('cestis_finance_convert', JSON.stringify(payload));
    window.location.href = 'Finance.Invoice.html';
  };

  root.FinanceDoc = API;
  root.FINANCE_COMPANY = COMPANY;
})(typeof window !== 'undefined' ? window : this);
