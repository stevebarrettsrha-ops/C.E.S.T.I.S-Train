/* ============================================================================
   tests/transcript-core.test.js — verification of the Transcript/Grades engine.

   Run with:  node tests/transcript-core.test.js
   Covers the pure resolution logic every page (admin editor, trainee live
   view, instructor view, PDFs) depends on: exam→unit matching, manual-grade
   override precedence, deterministic manual-grade ids, request de-duping and
   the seeded catalogues.
   ============================================================================ */
'use strict';
var assert = require('assert');
var Core = require('../cestis-core.js');
var T = Core.Transcript;

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; throw e; }
}

console.log('transcript/grades engine');

/* ---- seeded catalogues ------------------------------------------------- */
test('Business Administration L5 catalogue seeds all 70 approved units', function () {
  var bam = T.seedCatalogs().filter(function (q) { return q.id === 'QUAL-BAM-L5'; })[0];
  assert.ok(bam, 'QUAL-BAM-L5 missing');
  assert.strictEqual(bam.units.length, 70);
  assert.strictEqual(bam.units[0].code, 'BSBBAD0553B');
  assert.strictEqual(bam.units[0].name, 'Plan and manage meetings');
  assert.strictEqual(bam.units[69].code, 'PSSADM0215B');
  assert.strictEqual(bam.title, 'BUSINESS ADMINISTRATION (MANAGEMENT) LEVEL 5');
});

test('ensureSeeded adds missing quals but never disturbs admin edits', function () {
  var edited = [{ id: 'QUAL-BAM-L5', title: 'EDITED', units: [{ code: 'X', name: 'Y' }] }];
  var out = T.ensureSeeded(edited);
  var bam = out.filter(function (q) { return q.id === 'QUAL-BAM-L5'; })[0];
  assert.strictEqual(bam.title, 'EDITED', 'seed overwrote an admin edit');
  assert.strictEqual(bam.units.length, 1);
  assert.ok(out.length > 1, 'other seeds not added');
  // Idempotent
  assert.strictEqual(T.ensureSeeded(out).length, out.length);
});

test('every qualification plan is seeded with its transcribed units', function () {
  var counts = {
    'QUAL-BAM-L5': 70,  // approved paper transcript
    'QUAL-BT-L2': 31,   // NVQ-J CSB21424
    'QUAL-COS-L2': 50,  // NVQ-J CSB21323
    'QUAL-EIM-L2': 43,  // NVQ-J EEM20723
    'QUAL-EIM-L3': 67,  // NVQ MEM32507
    'QUAL-HVP-L2': 61,  // NVQ-J THH22522
    'QUAL-WEL-L2': 46,  // NVQ-J MEM22423 (incl. MEMCOR0042C from the clustering schedule)
    'QUAL-WEL-L3': 71   // NVQ MEM30215
  };
  var cats = T.seedCatalogs();
  assert.strictEqual(cats.length, Object.keys(counts).length);
  cats.forEach(function (q) {
    assert.strictEqual(q.units.length, counts[q.id], q.id + ' unit count');
    q.units.forEach(function (u) {
      assert.ok(u.code && u.name, q.id + ' has a unit missing code/name');
      assert.ok(u.coreElective === 'Core' || u.coreElective === 'Elective', q.id + ' bad coreElective');
    });
    var codes = {};
    q.units.forEach(function (u) {
      assert.ok(!codes[u.code], q.id + ' duplicate unit code ' + u.code);
      codes[u.code] = true;
    });
  });
  // Spot-check electives transcribed from the plans
  var wl3 = cats.filter(function (q) { return q.id === 'QUAL-WEL-L3'; })[0];
  assert.strictEqual(wl3.units.filter(function (u) { return u.coreElective === 'Elective'; }).length, 30);
  assert.strictEqual(wl3.nvqCode, 'MEM30215');
  var el2 = cats.filter(function (q) { return q.id === 'QUAL-EIM-L2'; })[0];
  assert.strictEqual(el2.units[0].code, 'MEMCOR0141D');
  assert.strictEqual(el2.units[el2.units.length - 1].code, 'EETOPT0152A');
  assert.strictEqual(el2.units[el2.units.length - 1].coreElective, 'Elective');
});

test('ensureSeeded upgrades a pristine empty scaffold to the transcribed units', function () {
  // Simulates a store that persisted the old empty placeholder before the
  // qualification plan was transcribed into the seeds.
  var stored = [
    { id: 'QUAL-WEL-L2', title: 'WELDING LEVEL 2', skillArea: 'Welding & Fabrication', level: 2, units: [], seeded: true },
    { id: 'QUAL-BT-L2', title: 'MY EDITED BT', skillArea: 'Beauty Therapy', level: 2, units: [], seeded: true, updatedAt: '2026-07-01T00:00:00Z' }
  ];
  var out = T.ensureSeeded(stored);
  var wel = out.filter(function (q) { return q.id === 'QUAL-WEL-L2'; })[0];
  assert.strictEqual(wel.units.length, 46, 'pristine scaffold not upgraded');
  var bt = out.filter(function (q) { return q.id === 'QUAL-BT-L2'; })[0];
  assert.strictEqual(bt.title, 'MY EDITED BT', 'edited scaffold was overwritten');
  assert.strictEqual(bt.units.length, 0, 'edited (updatedAt) scaffold must be left alone');
});

/* ---- formatting --------------------------------------------------------- */
test('formatGrade renders like the paper transcript', function () {
  assert.strictEqual(T.formatGrade(90.5), '90.5%');
  assert.strictEqual(T.formatGrade('90.50'), '90.5%');
  assert.strictEqual(T.formatGrade(85), '85%');
  assert.strictEqual(T.formatGrade(90.949), '90.9%');
  assert.strictEqual(T.formatGrade(''), '');
  assert.strictEqual(T.formatGrade(null), '');
  assert.strictEqual(T.formatGrade('A'), 'A');
});

test('formatDateDMY converts ISO and passes through DD/MM/YYYY', function () {
  assert.strictEqual(T.formatDateDMY('2025-02-14T10:00:00.000Z').slice(3), '02/2025');
  assert.strictEqual(T.formatDateDMY('14/02/2025'), '14/02/2025');
  assert.strictEqual(T.formatDateDMY(''), '');
});

/* ---- exam → unit matching ----------------------------------------------- */
var unit = { code: 'BSBBAD0553B', name: 'Plan and manage meetings' };
test('exam matches unit by code in the exam title', function () {
  assert.ok(T.examMatchesUnit({ title: 'BSBBAD0553B — Final Assessment' }, unit));
  assert.ok(T.examMatchesUnit({ title: 'bsbbad0553b final' }, unit));
});
test('exam matches unit by unit name', function () {
  assert.ok(T.examMatchesUnit({ title: 'Plan and Manage Meetings' }, unit));
  assert.ok(T.examMatchesUnit({ title: 'Exam: Plan and manage meetings (resit)' }, unit));
});
test('unrelated exam titles do not match', function () {
  assert.ok(!T.examMatchesUnit({ title: 'Welding Safety Basics' }, unit));
  assert.ok(!T.examMatchesUnit({ title: 'Plan' }, unit));
});

/* ---- grade resolution ---------------------------------------------------- */
var qual = {
  id: 'QUAL-BAM-L5',
  units: [
    { code: 'BSBBAD0553B', name: 'Plan and manage meetings', coreElective: 'Core' },
    { code: 'BSBSBM0163A', name: 'Develop a business proposal', coreElective: 'Core' }
  ]
};
var exams = [
  { id: 'EXAM-1', title: 'BSBBAD0553B - Plan and manage meetings', course: 'Business Administration' },
  { id: 'EXAM-2', title: 'Develop a business proposal', course: 'Business Administration' }
];
var examResults = [
  { id: 'RES-1', examId: 'EXAM-1', studentId: 'STU-a', score: 78, submittedAt: '2025-01-10T12:00:00Z' },
  { id: 'RES-2', examId: 'EXAM-1', studentId: 'STU-a', score: 91, submittedAt: '2025-02-01T12:00:00Z' },
  { id: 'RES-3', examId: 'EXAM-1', studentId: 'STU-b', score: 60, submittedAt: '2025-02-02T12:00:00Z' }
];

test('live exam grade flows into the transcript (latest attempt wins)', function () {
  var rows = T.effectiveGrades({ qual: qual, studentId: 'STU-a', exams: exams, examResults: examResults, manualGrades: [] });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].grade, 91, 'latest attempt should win');
  assert.strictEqual(rows[0].source, 'exam');
  assert.strictEqual(rows[0].examResultId, 'RES-2');
  assert.strictEqual(rows[1].grade, null, 'unit without exam stays ungraded');
  assert.strictEqual(rows[1].source, 'none');
});

test('grades are per-student (another trainee\'s results never leak)', function () {
  var rows = T.effectiveGrades({ qual: qual, studentId: 'STU-b', exams: exams, examResults: examResults, manualGrades: [] });
  assert.strictEqual(rows[0].grade, 60);
});

test('manual override beats the live exam score', function () {
  var manual = T.upsertManualGrade([], {
    studentId: 'STU-a', qualId: 'QUAL-BAM-L5', unitCode: 'BSBBAD0553B',
    grade: 95.5, date: '14/02/2025', updatedBy: 'admin'
  });
  var rows = T.effectiveGrades({ qual: qual, studentId: 'STU-a', exams: exams, examResults: examResults, manualGrades: manual });
  assert.strictEqual(rows[0].grade, 95.5);
  assert.strictEqual(rows[0].source, 'manual');
  assert.strictEqual(rows[0].date, '14/02/2025');
});

test('removing the manual override falls back to the live exam', function () {
  var manual = T.upsertManualGrade([], { studentId: 'STU-a', qualId: 'QUAL-BAM-L5', unitCode: 'BSBBAD0553B', grade: 95.5 });
  manual = T.removeManualGrade(manual, 'STU-a', 'QUAL-BAM-L5', 'BSBBAD0553B');
  var rows = T.effectiveGrades({ qual: qual, studentId: 'STU-a', exams: exams, examResults: examResults, manualGrades: manual });
  assert.strictEqual(rows[0].source, 'exam');
  assert.strictEqual(rows[0].grade, 91);
});

test('manual grade ids are deterministic (same unit → same record everywhere)', function () {
  var a = T.upsertManualGrade([], { studentId: 'S', qualId: 'Q', unitCode: 'U', grade: 80 });
  var b = T.upsertManualGrade(a, { studentId: 'S', qualId: 'Q', unitCode: 'U', grade: 88 });
  assert.strictEqual(b.length, 1, 'upsert duplicated instead of replacing');
  assert.strictEqual(b[0].grade, 88);
  assert.strictEqual(a[0].id, b[0].id);
});

test('gradeStats averages only graded units', function () {
  var stats = T.gradeStats([{ grade: 90 }, { grade: 80.5 }, { grade: null }, { grade: '' }]);
  assert.strictEqual(stats.total, 4);
  assert.strictEqual(stats.graded, 2);
  assert.strictEqual(stats.average, 85.3);
});

/* ---- qualification lookup ------------------------------------------------ */
test('qualForCourse resolves a trainee course to its catalogue', function () {
  var cats = T.seedCatalogs();
  assert.strictEqual(T.qualForCourse(cats, 'Business Administration').id, 'QUAL-BAM-L5');
  assert.strictEqual(T.qualForCourse(cats, 'Welding & Fabrication').id, 'QUAL-WEL-L2');
  assert.strictEqual(T.qualForCourse(cats, ''), null);
});

test('qualForCourse handles hand-typed course names (level + typo tolerant)', function () {
  var cats = T.seedCatalogs();
  // "L2"/"L3" course suffixes pick the catalogue at the right level.
  assert.strictEqual(T.qualForCourse(cats, 'BEAUTY THERAPY L2').id, 'QUAL-BT-L2');
  assert.strictEqual(T.qualForCourse(cats, 'WELDING L3').id, 'QUAL-WEL-L3');
  assert.strictEqual(T.qualForCourse(cats, 'ELECTRICAL INSTALLATION AND MAINTENANCE L2').id, 'QUAL-EIM-L2');
  // One-character misspelling still resolves ("cosmOtology").
  assert.strictEqual(T.qualForCourse(cats, 'COSMOTOLOGY L2').id, 'QUAL-COS-L2');
  // A course with no catalogue resolves to null so the Transcript page can
  // clear the previous trainee's skill area instead of keeping it selected.
  assert.strictEqual(T.qualForCourse(cats, 'COMMI CHEF L2'), null);
});

/* ---- transcript relink on student-id remap -------------------------------- */
test('relinkDependentData remaps transcript grades and requests', function () {
  var data = {
    transcriptGrades: [{ id: 'TG-1', studentId: 'OLD' }],
    certTranscriptRequests: [{ id: 'CTR-1', studentId: 'OLD' }]
  };
  Core.relinkDependentData({ OLD: 'NEW' }, data);
  assert.strictEqual(data.transcriptGrades[0].studentId, 'NEW');
  assert.strictEqual(data.certTranscriptRequests[0].studentId, 'NEW');
});

/* ---- requests -------------------------------------------------------------- */
test('newRequest defaults + hasOpenRequest blocks duplicate requests', function () {
  var r = T.newRequest({ studentId: 'STU-a', studentName: 'A', course: 'C', type: 'transcript' });
  assert.strictEqual(r.status, 'pending');
  var reqs = [r];
  assert.ok(T.hasOpenRequest(reqs, 'STU-a', 'transcript'));
  assert.ok(!T.hasOpenRequest(reqs, 'STU-a', 'certificate'));
  assert.ok(!T.hasOpenRequest(reqs, 'STU-z', 'transcript'));
  r.status = 'collected';
  assert.ok(!T.hasOpenRequest(reqs, 'STU-a', 'transcript'), 'closed request should not block');
  var both = T.newRequest({ studentId: 'STU-a', type: 'both' });
  assert.ok(T.hasOpenRequest([both], 'STU-a', 'certificate'), '"both" covers certificate');
  assert.strictEqual(T.pendingRequestCount([both, r]), 1);
});

/* ---- snapshot sync registration ------------------------------------------ */
test('transcript collections are registered for snapshot loss-detection', function () {
  ['voctrain_unitCatalogs', 'voctrain_transcriptGrades', 'voctrain_certTranscriptRequests'].forEach(function (k) {
    assert.ok(Core.SNAPSHOT_COUNT_KEYS.indexOf(k) !== -1, k + ' missing from SNAPSHOT_COUNT_KEYS');
  });
});

console.log('\nAll ' + passed + ' transcript tests passed.');
