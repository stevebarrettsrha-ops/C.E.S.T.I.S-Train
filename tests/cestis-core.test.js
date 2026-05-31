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

test('mergeStudentRecords preserves cross-system link fields (schoolFeeId)', function () {
  var manual = { id: 'STU-1', name: 'A', course: 'C', lastModified: '2026-05-01', progress: 50 };
  var feeLinked = { id: 'SF-99', name: 'A', course: 'C', lastModified: '2026-01-01', schoolFeeId: '99', source: 'schoolfee' };
  var m = Core.mergeStudentRecords(manual, feeLinked);
  assert.strictEqual(m.schoolFeeId, '99', 'fee link survives merge into the newer manual record');
  assert.strictEqual(m.source, 'schoolfee');
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

/* ---- integration: realistic mixed dataset ----------------------------- */
test('migration: fee-linked + manual + cross-device dup all collapse correctly', function () {
  var data = {
    students: [
      // Same person, three ways they could enter the system on different devices:
      { id: 'SF-99', name: 'Mary Jane', course: 'Cosmetology', schoolFeeId: '99', source: 'schoolfee', lastModified: '2026-01-01', progress: 0 },
      { id: 'STU-LEGACY-1', name: 'mary jane', course: 'cosmetology', lastModified: '2026-03-01', progress: 40, email: 'mary@x.com' },
      { id: 'STU1700000009999', name: 'Mary  Jane', course: 'Cosmetology', lastModified: '2026-05-01', progress: 75 },
      // A genuinely different person:
      { id: 'STU-2', name: 'Sam Okafor', course: 'Welding & Fabrication', lastModified: '2026-02-01' }
    ],
    userAccounts: [
      { username: 'mary', studentDataId: 'SF-99' },
      { username: 'mary2', studentDataId: 'STU-LEGACY-1' }
    ],
    attendanceRecords: [
      { studentId: 'SF-99' }, { studentId: 'STU-LEGACY-1' }, { studentId: 'STU1700000009999' }
    ],
    certDownloadApprovals: [{ studentId: 'STU-LEGACY-1' }],
    examResults: [{ studentId: 'STU1700000009999', score: 88 }]
  };
  var res = Core.migrateToStableIds(data);
  assert.ok(res.changed);
  assert.strictEqual(data.students.length, 2, 'Mary collapsed to one; Sam separate');

  var mary = data.students.filter(function (s) { return Core.normName(s.name) === 'mary jane'; })[0];
  var maryStable = Core.stableStudentId({ name: 'Mary Jane', course: 'Cosmetology' });
  assert.strictEqual(mary.id, maryStable, 'Mary has the deterministic stable id');
  assert.strictEqual(mary.progress, 75, 'kept newest progress');
  assert.strictEqual(mary.email, 'mary@x.com', 'backfilled email from an older copy');
  assert.strictEqual(mary.schoolFeeId, '99', 'fee link preserved through the collapse');

  // every dependent record now points at the single stable Mary id
  data.attendanceRecords.forEach(function (r) { assert.strictEqual(r.studentId, maryStable); });
  assert.strictEqual(data.examResults[0].studentId, maryStable);
  assert.strictEqual(data.certDownloadApprovals[0].studentId, maryStable);
  data.userAccounts.forEach(function (u) { assert.strictEqual(u.studentDataId, maryStable, 'accounts relinked'); });

  // second run is a no-op
  assert.strictEqual(Core.migrateToStableIds(data).changed, false);
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

/* ---- change bus (drives reactive view refresh) ------------------------ */
test('bus delivers payloads to subscribers and off() unsubscribes', function () {
  var got = [];
  var unsub = Core.on('evt:x', function (p) { got.push(p); });
  Core.emit('evt:x', 1);
  Core.emit('evt:x', 2);
  unsub();
  Core.emit('evt:x', 3);
  assert.deepStrictEqual(got, [1, 2], 'received before unsubscribe only');
});
test('a throwing listener does not break the others', function () {
  var reached = false;
  Core.on('evt:y', function () { throw new Error('boom'); });
  Core.on('evt:y', function () { reached = true; });
  Core.emit('evt:y');
  assert.strictEqual(reached, true);
  // emitting an event with no listeners must not throw
  assert.doesNotThrow(function () { Core.emit('evt:nobody'); });
});

/* ---- master snapshot: build / verify ---------------------------------- */
test('buildSnapshot excludes sensitive keys and is checksum-verifiable', function () {
  var storeMap = {
    voctrain_students: JSON.stringify([{ id: 'STU-A', name: 'A', course: 'C' }]),
    cestisGoogleAccessToken: 'secret-token',
    voctrain_sessionUserId: 'USR-1',
    schoolFeeCloudFileId: 'file123',
    darkMode: 'true',
    cestiSchoolFeeStudents: JSON.stringify([{ id: 'SF-1', name: 'A' }])
  };
  var snap = Core.buildSnapshot(storeMap, { event: 'logout', savedBy: 'admin' });
  assert.ok(!('cestisGoogleAccessToken' in snap.store), 'token excluded');
  assert.ok(!('voctrain_sessionUserId' in snap.store), 'session excluded');
  assert.ok(!('schoolFeeCloudFileId' in snap.store), 'cloud file id excluded');
  assert.ok(!('darkMode' in snap.store), 'volatile ui flag excluded');
  assert.ok('voctrain_students' in snap.store && 'cestiSchoolFeeStudents' in snap.store, 'data kept');
  assert.strictEqual(snap.event, 'logout');
  assert.strictEqual(snap.counts.voctrain_students, 1);
  assert.strictEqual(Core.verifySnapshot(snap).ok, true, 'checksum verifies');
});
test('verifySnapshot detects tampering / corruption', function () {
  var snap = Core.buildSnapshot({ voctrain_students: JSON.stringify([{ id: 'X', name: 'n', course: 'c' }]) }, {});
  snap.store.voctrain_students = JSON.stringify([{ id: 'X', name: 'n', course: 'c' }, { id: 'Y', name: 'm', course: 'c' }]);
  assert.strictEqual(Core.verifySnapshot(snap).ok, false, 'mutated store fails checksum');
});
test('checksum is independent of key insertion order', function () {
  var a = Core.buildSnapshot({ voctrain_students: '[]', cestiSchoolFeeStudents: '[]' }, {});
  var b = Core.buildSnapshot({ cestiSchoolFeeStudents: '[]', voctrain_students: '[]' }, {});
  assert.strictEqual(a.checksum, b.checksum);
});

/* ---- master snapshot: data-loss report -------------------------------- */
test('dataLossReport finds records the snapshot has but local lost', function () {
  var snap = Core.buildSnapshot({
    voctrain_students: JSON.stringify([
      { id: 'STU-A', name: 'A', course: 'C' },
      { id: 'STU-B', name: 'B', course: 'C' },
      { id: 'STU-GONE', name: 'Deleted Person', course: 'C' }
    ])
  }, {});
  var local = {
    voctrain_students: JSON.stringify([{ id: 'STU-A', name: 'A', course: 'C' }]),
    voctrain_deletedStudentIds: JSON.stringify(['STU-GONE']) // intentionally deleted
  };
  var rep = Core.dataLossReport(snap, local);
  assert.strictEqual(rep.collections.voctrain_students.missingFromLocal, 1, 'only STU-B counts as lost');
  assert.deepStrictEqual(rep.missingLocally.voctrain_students, ['STU-B']);
  assert.strictEqual(rep.totalMissing, 1);
});

/* ---- master snapshot: reconcile (merge & repair) ---------------------- */
test('reconcileSnapshot restores missing records without resurrecting deletes', function () {
  var snap = Core.buildSnapshot({
    voctrain_students: JSON.stringify([
      { id: 'STU-A', name: 'A', course: 'C', progress: 10 },
      { id: 'STU-B', name: 'B', course: 'C' },
      { id: 'STU-GONE', name: 'Gone', course: 'C' }
    ]),
    voctrain_systemSettings: JSON.stringify({ theme: 'x' })
  }, {});
  var local = {
    voctrain_students: JSON.stringify([{ id: 'STU-A', name: 'A', course: 'C', progress: 99 }]),
    voctrain_deletedStudentIds: JSON.stringify(['STU-GONE']),
    voctrain_systemSettings: '' // empty locally -> should be restored
  };
  var res = Core.reconcileSnapshot(snap, local);
  assert.ok(res.changed);
  var students = JSON.parse(res.store.voctrain_students);
  var ids = students.map(function (s) { return s.id; }).sort();
  assert.deepStrictEqual(ids, ['STU-A', 'STU-B'], 'B restored, GONE not resurrected');
  var a = students.filter(function (s) { return s.id === 'STU-A'; })[0];
  assert.strictEqual(a.progress, 99, 'newer local edit preserved, not overwritten by snapshot');
  assert.strictEqual(res.recoveredStudents, 1);
  assert.strictEqual(res.store.voctrain_systemSettings, JSON.stringify({ theme: 'x' }), 'empty config restored');
});
test('reconcileSnapshot unions tombstones and drops a now-tombstoned local student', function () {
  // Device A deleted Mary -> the snapshot carries the tombstone but not Mary.
  // Device B still has Mary locally and no tombstone. After reconcile, B must
  // gain the tombstone AND drop Mary (deleted data cannot re-emerge anywhere).
  var maryId = 'STU-MARY';
  var snap = Core.buildSnapshot({
    voctrain_students: JSON.stringify([{ id: 'STU-keep', name: 'Sam', course: 'Welding' }]),
    voctrain_deletedStudentIds: JSON.stringify([maryId])
  }, {});
  var local = {
    voctrain_students: JSON.stringify([
      { id: maryId, name: 'Mary', course: 'Cosmetology' },
      { id: 'STU-keep', name: 'Sam', course: 'Welding' }
    ]),
    voctrain_deletedStudentIds: JSON.stringify([])
  };
  var res = Core.reconcileSnapshot(snap, local);
  assert.ok(res.changed);
  var ids = JSON.parse(res.store.voctrain_students).map(function (s) { return s.id; });
  assert.strictEqual(ids.indexOf(maryId), -1, 'tombstoned Mary dropped on device B');
  assert.ok(ids.indexOf('STU-keep') !== -1, 'Sam kept');
  assert.ok(JSON.parse(res.store.voctrain_deletedStudentIds).indexOf(maryId) !== -1, 'tombstone propagated to device B');
  assert.ok(res.droppedTombstoned >= 1);
});
test('reconcileSnapshot is a no-op when local already has everything', function () {
  var data = { voctrain_students: JSON.stringify([{ id: 'STU-A', name: 'A', course: 'C' }]) };
  var snap = Core.buildSnapshot(data, {});
  var res = Core.reconcileSnapshot(snap, data);
  assert.strictEqual(res.changed, false);
});

/* ---- tombstone resurrection prevention -------------------------------- */
test('dropTombstonedStudents removes a student matched by its current id', function () {
  var students = [{ id: 'STU-A', name: 'A', course: 'C' }, { id: 'STU-B', name: 'B', course: 'C' }];
  var del = { 'STU-A': true };
  var r = Core.dropTombstonedStudents(students, del);
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(r.students.map(function (s) { return s.id; }), ['STU-B']);
  assert.deepStrictEqual(r.droppedIds, ['STU-A']);
});
test('dropTombstonedStudents catches a resurrected copy carrying a DIFFERENT id', function () {
  // Student was deleted; its stable id was tombstoned. A cloud/fee copy returns
  // under a legacy id but the same name+course -> must still be dropped.
  var person = { name: 'Mary Jane', course: 'Cosmetology' };
  var stable = Core.stableStudentId(person);
  var resurrected = { id: 'SF-legacy-999', name: 'mary  jane', course: 'COSMETOLOGY' };
  var r = Core.dropTombstonedStudents([resurrected, { id: 'STU-keep', name: 'Sam', course: 'Welding' }], (function () { var m = {}; m[stable] = true; return m; })());
  assert.strictEqual(r.removed, 1, 'resurrected copy dropped via stable-id match');
  assert.deepStrictEqual(r.students.map(function (s) { return s.id; }), ['STU-keep']);
});
test('dropTombstonedStudents keeps everything when nothing is tombstoned', function () {
  var students = [{ id: 'STU-A', name: 'A', course: 'C' }];
  var r = Core.dropTombstonedStudents(students, {});
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.students.length, 1);
});
test('end-to-end: tombstoned student survives neither migration nor a re-add', function () {
  // Simulate: delete Mary (tombstone her stable id), then a sync re-adds her
  // under a fresh unstable id. After stabilize + drop she must be gone.
  var mary = { name: 'Mary Jane', course: 'Cosmetology' };
  var stable = Core.stableStudentId(mary);
  var del = {}; del[stable] = true;
  var students = [
    { id: 'STU-1700000000001', name: 'Mary Jane', course: 'Cosmetology' }, // re-added copy
    { id: 'STU-keep', name: 'Sam Okafor', course: 'Welding & Fabrication' }
  ];
  // migrate first (as the app does, which restabilises every id), then drop tombstoned
  var bundle = { students: students };
  Core.migrateToStableIds(bundle);
  var r = Core.dropTombstonedStudents(bundle.students, del);
  assert.strictEqual(r.students.length, 1, 'only one student remains');
  assert.strictEqual(Core.normName(r.students[0].name), 'sam okafor', 'Mary stays deleted, Sam remains');
});

/* ---- catalogue -------------------------------------------------------- */
test('catalogue is shared and freshSkillAreas returns an independent copy', function () {
  assert.strictEqual(Core.SKILL_AREAS.length, 20);
  var a = Core.freshSkillAreas();
  a[0].students = 999;
  assert.strictEqual(Core.SKILL_AREAS[0].students, 0, 'mutating a copy must not corrupt the source');
});

console.log('\nAll ' + passed + ' tests passed.');
