/* ============================================================================
   tests/finance-core.test.js — verification of the Payments/Invoices helpers.

   Run with:  node tests/finance-core.test.js
   Covers the pure domain logic shared by the finance pages: amount-in-words,
   voucher classification from cashbook transactions, document numbering and
   invoice/quote/PO totals (standard and school/RBF styles).
   ============================================================================ */
'use strict';
var assert = require('assert');
var Core = require('../cestis-core.js');
var F = Core.Finance;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; throw e; }
}

console.log('cestis-core Finance helpers');

/* ---- numberToWords / amountToWords ------------------------------------ */
test('numberToWords handles zero and small numbers', function () {
  assert.strictEqual(F.numberToWords(0), 'Zero');
  assert.strictEqual(F.numberToWords(7), 'Seven');
  assert.strictEqual(F.numberToWords(15), 'Fifteen');
  assert.strictEqual(F.numberToWords(42), 'Forty-Two');
});
test('numberToWords handles hundreds with the Jamaican "and"', function () {
  assert.strictEqual(F.numberToWords(105), 'One Hundred and Five');
  assert.strictEqual(F.numberToWords(999), 'Nine Hundred and Ninety-Nine');
});
test('numberToWords handles thousands and millions', function () {
  assert.strictEqual(F.numberToWords(1000), 'One Thousand');
  assert.strictEqual(F.numberToWords(130565), 'One Hundred and Thirty Thousand, Five Hundred and Sixty-Five');
  assert.strictEqual(F.numberToWords(4509467), 'Four Million, Five Hundred and Nine Thousand, Four Hundred and Sixty-Seven');
});
test('amountToWords writes the voucher wording with cents as NN/100', function () {
  assert.strictEqual(F.amountToWords(130565.96),
    'One Hundred and Thirty Thousand, Five Hundred and Sixty-Five Dollars and 96/100');
  assert.strictEqual(F.amountToWords(95000), 'Ninety-Five Thousand Dollars');
  assert.strictEqual(F.amountToWords(1), 'One Dollar');
  assert.strictEqual(F.amountToWords(0.05), 'Zero Dollars and 05/100');
});
test('amountToWords carries 99.5+ cents into the next dollar', function () {
  assert.strictEqual(F.amountToWords(12.999), 'Thirteen Dollars');
});

/* ---- voucher classification ------------------------------------------- */
test('payment with a cheque number is a cheque voucher', function () {
  assert.strictEqual(F.voucherTypeFor({ cheque: '1000102', payment: 120000, deposit: 0, category: 'Admin Expenses' }), 'cheque');
});
test('payment without a cheque number is a bank transfer', function () {
  assert.strictEqual(F.voucherTypeFor({ cheque: '', payment: 298707.93, deposit: 0, category: 'Statutory Deductions' }), 'transfer');
  assert.strictEqual(F.voucherTypeFor({ cheque: '   ', payment: 5, category: 'Bank Charges' }), 'transfer');
});
test('deposits, zero rows and cancelled cheques get no voucher', function () {
  assert.strictEqual(F.voucherTypeFor({ cheque: '', deposit: 4509467.25, payment: 0, category: 'Subvention' }), null);
  assert.strictEqual(F.voucherTypeFor({ cheque: '1000119', deposit: 0, payment: 0, category: 'Cancelled' }), null);
  assert.strictEqual(F.voucherTypeFor({ cheque: '1000122', deposit: 0, payment: 80000, category: 'Cancelled' }), null);
  assert.strictEqual(F.voucherTypeFor(null), null);
});
test('vouchersFromTransactions maps cashbook rows to voucher records', function () {
  var vouchers = F.vouchersFromTransactions([
    { id: 1, date: '2025-10-06', cheque: '1000102', details: 'Nakia Sterling (Ink Cartridge)', deposit: 0, payment: 120000, category: 'Admin Expenses' },
    { id: 3, date: '2025-10-25', cheque: '', details: 'SUBVENTION', deposit: 4509467.25, payment: 0, category: 'Subvention' },
    { id: 31, date: '2025-11-25', cheque: '', details: 'TAJ - Bank Transfer (Sep-Oct)', deposit: 0, payment: 298707.93, category: 'Statutory Deductions' },
    { id: 20, date: '2025-11-11', cheque: '1000119', details: 'Cancelled Cheque', deposit: 0, payment: 0, category: 'Cancelled' }
  ]);
  assert.strictEqual(vouchers.length, 2);
  assert.strictEqual(vouchers[0].type, 'cheque');
  assert.strictEqual(vouchers[0].chequeNo, '1000102');
  assert.strictEqual(vouchers[0].accountCharged, 'Admin Expenses');
  assert.strictEqual(vouchers[1].type, 'transfer');
  assert.strictEqual(vouchers[1].chequeNo, '');
  assert.strictEqual(vouchers[1].amount, 298707.93);
});
test('vouchersFromTransactions tolerates junk input', function () {
  assert.deepStrictEqual(F.vouchersFromTransactions(null), []);
  assert.deepStrictEqual(F.vouchersFromTransactions([null, {}, { payment: 'x' }]), []);
});

/* ---- document numbering ------------------------------------------------ */
test('nextDocNumber increments past the highest existing number', function () {
  assert.strictEqual(F.nextDocNumber(['12503', 12550, '12528'], 10000), 12551);
  assert.strictEqual(F.nextDocNumber(['INV-0007'], 1), 8);
});
test('nextDocNumber falls back to the seed on an empty list', function () {
  assert.strictEqual(F.nextDocNumber([], 12551), 12551);
  assert.strictEqual(F.nextDocNumber(['OOO1'], 500), 2); // odd legacy numbers still parse
});

/* ---- totals ------------------------------------------------------------ */
test('docTotals reproduces a real invoice (barricades, 5% discount)', function () {
  var t = F.docTotals({
    items: [
      { qty: 4, unitPrice: 88800 },
      { isNote: true, description: 'Materials Needed: ...' },
      { qty: 1, unitPrice: 25000 }
    ],
    discountPct: 5, taxPct: 0
  });
  assert.strictEqual(t.subtotal, 380200);
  assert.strictEqual(t.discount, 19010);
  assert.strictEqual(t.amountDue, 361190);
});
test('docTotals computes the school/RBF style (percentage of budget)', function () {
  var t = F.docTotals({
    template: 'school',
    items: [{ qty: 30, unitPrice: 18648110.23 }] // 30% of the RBF budget line
  });
  assert.ok(Math.abs(t.subtotal - 5594433.069) < 1e-6);
  assert.ok(Math.abs(t.amountDue - 5594433.069) < 1e-6);
});
test('docTotals applies deposit percentage to the amount due', function () {
  var t = F.docTotals({ items: [{ qty: 1, unitPrice: 94651.36 }], depositPct: 50 });
  assert.ok(Math.abs(t.deposit - 47325.68) < 1e-6);
});
test('lineTotal treats blank values as zero', function () {
  assert.strictEqual(F.lineTotal({ qty: '', unitPrice: '' }), 0);
  assert.strictEqual(F.lineTotal(null), 0);
});

console.log('\n' + passed + ' finance tests passed');
