/* ============================================================================
   tests/cestis-core.test.js — automated verification of the shared data-core.

   Run with:  node tests/cestis-core.test.js
   No test framework required. Exits non-zero on the first failure so it can
   gate commits / CI. These tests cover the pure domain logic that used to be
   copy-pasted (and drift) across pages: stable identity, merge, dedupe,
   relink, the stable-id migration, and deletion tombstones.
   ============================================================================ */
'use strict';
var assert = require('assert');
var Core = require('../cestis-core.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; throw e; }
}

/* The app's original hash, reproduced here so we can assert cestis-core matches
   it exactly — guaranteeing ids stay compatible with anything already stored. */
function originalHash(str) {
  str = String(str == null ? '' : str);
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

console.log('cestis-core domain logic');

/* ---- hashing ---------------------------------------------------------- */
test('hashString matches the app\'s original algorithm', function () {
  ['', 'a', 'John Smith|welding', 'x'.repeat(500)].forEach(function (s) {
    assert.strictEqual(Core.hashString(s), originalHash(s), 'mismatch for: ' + s);
  });
});
test('hashString is deterministic', function () {
  assert.strictEqual(Core.hashString('repeat me'), Core.hashString('repeat me'));
});

/* ---- stable identity -------------------------------------------------- */
test('stableStudentId is identical for the same person regardless of other fields', function () {
  var a = { id: 'STU1700000000001', name: 'John Smith', course: 'Welding & Fabrication', email: 'j@x.com', progress: 80 };
  var b = { id: 'STU9999999999999', name: 'John Smith', course: 'Welding & Fabrication', progress: 5 };
  assert.strictEqual(Core.stableStudentId(a), Core.stableStudentId(b));
});
test('stableStudentId normalises case and whitespace', function () {
  assert.strictEqual(
    Core.stableStudentId({ name: '  John   Smith ', course: 'WELDING & fabrication' }),
    Core.stableStudentId({ name: 'john smith', course: 'welding & fabrication' })
  );
});
test('stableStudentId differs across people / courses', function () {
  var x = Core.stableStudentId({ name: 'John Smith', course: 'Welding & Fabrication' });
  assert.notStrictEqual(x, Core.stableStudentId({ name: 'Jane Smith', course: 'Welding & Fabrication' }));
  assert.notStrictEqual(x, Core.stableStudentId({ name: 'John Smith', course: 'Plumbing' }));
});
test('stableStudentId is null when there is no usable name', function () {
  assert.strictEqual(Core.stableStudentId({ name: '', course: 'Welding' }), null);
});

/* ---- merge ------------------------------------------------------------ */
test('mergeStudentRecords prefers the newer record, backfills blanks from the older', function () {
  var older = { id: '1', name: 'A', course: 'C', lastModified: '2026-01-01', progress: 10, email: 'old@x.com', phone: '111' };
  var newer = { id: '2', name: 'A', course: 'C', lastModified: '2026-05-01', progress: 90, email: '', phone: '' };
  var m = Core.mergeStudentRecords(older, newer);
  assert.strictEqual(m.progress, 90, 'newer value wins');
  assert.strictEqual(m.email, 'old@x.com', 'blank in newer backfilled from older');
  assert.strictEqual(m.phone, '111');
});

/* ---- dedupe ----------------------------------------------------------- */
test('dedupeStudents collapses cross-device duplicates and maps old ids', function () {
  var list = [
    { id: 'STU-A', name: 'John Smith', course: 'Welding', lastModified: '2026-01-01', progress: 10, email: 'j@x.com' },
    { id: 'STU-B', name: 'john smith', course: 'welding', lastModified: '2026-05-01', progress: 90, email: '' },
    { id: 'STU-C', name: 'Jane Doe', course: 'Plumbing' }
  ];
  var r = Core.dedupeStudents(list);
  assert.strictEqual(r.students.length, 2, 'two unique people remain');
  assert.strictEqual(r.removed, 1);
  var john = r.students.filter(function (s) { return Core.normName(s.name) === 'john smith'; })[0];
  assert.strictEqual(john.progress, 90, 'kept newer progress');
  assert.strictEqual(john.email, 'j@x.com', 'backfilled email from duplicate');
  // every removed id should resolve to a surviving id
  Object.keys(r.idMap).forEach(function (old) {
    assert.ok(r.students.some(function (s) { return s.id === r.idMap[old]; }), 'idMap target survives: ' + old);
  });
});
test('dedupeStudents passes through records with no natural key', function () {
  var list = [{ id: '1', name: '', course: 'X' }, { id: '2', name: '', course: 'Y' }];
  var r = Core.dedupeStudents(list);
  assert.strictEqual(r.students.length, 2);
  assert.strictEqual(r.removed, 0);
});

/* ---- relink ----------------------------------------------------------- */
test('relinkDependentData remaps and dedups dependent arrays', function () {
  var idMap = { 'STU-B': 'STU-A' };
  var data = {
    userAccounts: [
      { username: 'a', studentDataId: 'STU-A', password: 'p', status: 'active' },
      { username: 'a2', studentDataId: 'STU-B' }
    ],
    attendanceRecords: [{ studentId: 'STU-B', date: '2026-01-01' }],
    certDownloadApprovals: [{ studentId: 'STU-A' }, { studentId: 'STU-B' }],
    examResults: [{ studentId: 'STU-B', score: 70 }]
  };
  Core.relinkDependentData(idMap, data);
  assert.strictEqual(data.attendanceRecords[0].studentId, 'STU-A');
  assert.strictEqual(data.examResults[0].studentId, 'STU-A');
  assert.strictEqual(data.certDownloadApprovals.length, 1, 'cert approvals deduped by studentId');
  assert.ok(data.userAccounts.length <= 2);
  data.userAccounts.forEach(function (u) { assert.strictEqual(u.studentDataId, 'STU-A'); });
});

/* ---- migration -------------------------------------------------------- */
test('migrateToStableIds assigns stable ids, collapses dups, relinks deps', function () {
  var data = {
    students: [
      { id: 'STU1700000000001', name: 'John Smith', course: 'Welding', lastModified: '2026-01-01', progress: 10 },
      { id: 'STU1700000000999', name: 'john smith', course: 'welding', lastModified: '2026-05-01', progress: 90 }
    ],
    userAccounts: [{ username: 'js', studentDataId: 'STU1700000000999' }],
    attendanceRecords: [{ studentId: 'STU1700000000001' }, { studentId: 'STU1700000000999' }]
  };
  var res = Core.migrateToStableIds(data);
  assert.strictEqual(data.students.length, 1, 'duplicate collapsed');
  var stable = Core.stableStudentId({ name: 'John Smith', course: 'Welding' });
  assert.strictEqual(data.students[0].id, stable, 'survivor got the stable id');
  assert.strictEqual(data.users === undefined, true);
  assert.strictEqual(data.userAccounts[0].studentDataId, stable, 'account relinked to stable id');
  data.attendanceRecords.forEach(function (r) { assert.strictEqual(r.studentId, stable, 'attendance relinked'); });
  assert.ok(res.changed);
});
test('migrateToStableIds is idempotent (second run changes nothing)', function () {
  var data = {
    students: [
      { id: 'STU-x', name: 'Amy Lee', course: 'Plumbing' },
      { id: 'STU-y', name: 'Bob Ray', course: 'Masonry' }
    ],
    userAccounts: [], attendanceRecords: []
  };
  Core.migrateToStableIds(data);
  var snapshot = JSON.stringify(data.students);
  var res2 = Core.migrateToStableIds(data);
  assert.strictEqual(JSON.stringify(data.students), snapshot, 'no further mutation');
  assert.strictEqual(res2.changed, false, 'reports no change on second run');
});

/* ---- tombstones (with a mock store) ----------------------------------- */
test('tombstones record and detect deleted ids', function () {
  var mem = {};
  var mockStore = {
    getItem: function (k) { return k in mem ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); }
  };
  assert.strictEqual(Core.isStudentDeleted('STU-Z', mockStore), false);
  Core.recordDeletedStudent('STU-Z', mockStore);
  assert.strictEqual(Core.isStudentDeleted('STU-Z', mockStore), true);
  // stable ids mean a re-synced copy of the same deleted student is still caught
  var sid = Core.stableStudentId({ name: 'Gone Person', course: 'Welding' });
  Core.recordDeletedStudent(sid, mockStore);
  assert.strictEqual(Core.isStudentDeleted(Core.stableStudentId({ name: 'gone person', course: 'WELDING' }), mockStore), true);
});

/* ---- catalogue -------------------------------------------------------- */
test('catalogue is shared and freshSkillAreas returns an independent copy', function () {
  assert.strictEqual(Core.SKILL_AREAS.length, 20);
  var a = Core.freshSkillAreas();
  a[0].students = 999;
  assert.strictEqual(Core.SKILL_AREAS[0].students, 0, 'mutating a copy must not corrupt the source');
});

console.log('\nAll ' + passed + ' tests passed.');
