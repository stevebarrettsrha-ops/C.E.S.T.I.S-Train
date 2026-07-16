/* ============================================================================
   tests/lms-chat-roster.test.js — LMS Chat student visibility regression tests.

   Run with:  node tests/lms-chat-roster.test.js
   No test framework and no browser required. Exits non-zero on failure so it
   can gate commits / CI.

   The chat roster logic lives inline in index.html (it needs the page's live
   data arrays), so these tests extract the functions by name from the HTML
   source and run them against mock data. If a function is renamed, moved into
   another file, or its brace structure breaks, extraction fails loudly here —
   which is exactly the regression signal we want.

   Covered guarantees (the "every student is visible in chat" fix):
     • every student record gets a linked account (lmsChatEnsureStudentAccounts)
     • deleted/tombstoned students never get accounts minted
     • disabled accounts count as chat members; pending/rejected never do;
       accounts with a MISSING status (legacy imports) still count
     • students land in their correct skill-area room, including via
       course aliases (e.g. "Photovoltaic Installer" → Solar Energy Tech)
     • the whole sync is idempotent and survives malformed records
   ============================================================================ */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + (e && e.message)); process.exitCode = 1; throw e; }
}

/* Extract "function <name>(...) {...}" from index.html by brace matching.
   Throws (test failure) if the function has been renamed or removed. */
function extractFn(name) {
  var idx = html.indexOf('function ' + name + '(');
  if (idx === -1) throw new Error('function ' + name + ' not found in index.html — renamed or removed?');
  var i = html.indexOf('{', idx), depth = 0, j = i;
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (!depth) break; }
  }
  if (depth) throw new Error('unbalanced braces extracting ' + name);
  return html.slice(idx, j + 1);
}

/* ---- fixture: a minimal in-memory app environment ---------------------- */
function makeEnv() {
  var env = {
    skillAreas: [
      { id: 1, name: 'Welding & Fabrication', icon: 'W', color: '#e74c3c' },
      { id: 18, name: 'Solar Energy Tech', icon: 'S', color: '#fdd835' }
    ],
    certTemplates: {},
    students: [],
    userAccounts: [],
    lmsChatRooms: [],
    saveCalls: { accounts: 0, chat: 0 },
    deletedIds: {}
  };
  env.saveUserAccounts = function () { env.saveCalls.accounts++; };
  env.saveLmsChatData = function () { env.saveCalls.chat++; };
  env.localDateStr = function () { return '2026-07-16'; };
  env.isStudentDeleted = function (id) { return env.deletedIds[id] === true; };
  env.backfillAccountProgrammes = undefined; // exercised separately via extraction
  return env;
}

/* Evaluate the extracted functions inside an env's globals and return the
   callable functions bound to that env. The functions reference bare globals
   (students, userAccounts, …) which are fed in as named parameters, plus a
   mutable holder for lmsChatRooms since lmsChatEnsureMembership reassigns it. */
var CHAT_FN_NAMES = [
  'findSkillAreaForCourse',
  'backfillAccountProgrammes',
  'lmsChatEnsureStudentAccounts',
  'lmsChatAccountEligible',
  'lmsChatEnsureMembership'
];
function loadChatFns(env) {
  var decls = CHAT_FN_NAMES.map(extractFn).join('\n');
  var epilogue =
    'return {\n' +
    '  _syncRooms: function () { roomsHolder.rooms = lmsChatRooms; },\n' +
    CHAT_FN_NAMES.map(function (n) { return '  ' + n + ': ' + n; }).join(',\n') + '\n' +
    '};';
  var fn = new Function(
    'skillAreas', 'certTemplates', 'students', 'userAccounts',
    'saveUserAccounts', 'saveLmsChatData', 'localDateStr', 'isStudentDeleted',
    'roomsHolder',
    'var lmsChatRooms = roomsHolder.rooms;\n' + decls + '\n' + epilogue
  );
  var holder = { rooms: env.lmsChatRooms };
  var api = fn(
    env.skillAreas, env.certTemplates, env.students, env.userAccounts,
    env.saveUserAccounts, env.saveLmsChatData, env.localDateStr, env.isStudentDeleted,
    holder
  );
  api.rooms = function () { api._syncRooms(); return holder.rooms; };
  return api;
}

console.log('LMS Chat roster / student visibility');

/* ---- account sync ------------------------------------------------------ */
test('every student record gets a linked account', function () {
  var env = makeEnv();
  env.students.push(
    { id: 'STU-1', name: 'Rashaun Barrett', course: 'Welding L2' },
    { id: 'STU-2', name: 'Romario Jackson', course: 'Photovoltaic Installer' }
  );
  var api = loadChatFns(env);
  api.lmsChatEnsureStudentAccounts();
  env.students.forEach(function (s) {
    assert.ok(env.userAccounts.some(function (u) { return u.studentDataId === s.id; }),
      'no account for ' + s.id);
  });
});

test('accounts are created disabled with a deterministic id (merge-convergent)', function () {
  var env = makeEnv();
  env.students.push({ id: 'STU-9', name: 'Jane Doe', course: 'Welding' });
  loadChatFns(env).lmsChatEnsureStudentAccounts();
  var acct = env.userAccounts[0];
  assert.strictEqual(acct.id, 'USR-STU-STU-9');
  assert.strictEqual(acct.status, 'disabled');
  assert.strictEqual(acct.programme, 'Welding');
});

test('an unlinked same-username student account is adopted, not duplicated', function () {
  var env = makeEnv();
  env.userAccounts.push({ id: 'USR-7', name: 'Jane Doe', role: 'student', username: 'jane.doe', status: 'active', programme: '' });
  env.students.push({ id: 'STU-3', name: 'Jane Doe', course: 'WELDING L2' });
  loadChatFns(env).lmsChatEnsureStudentAccounts();
  var janes = env.userAccounts.filter(function (u) { return u.name === 'Jane Doe'; });
  assert.strictEqual(janes.length, 1, 'duplicate account created');
  assert.strictEqual(janes[0].studentDataId, 'STU-3');
  assert.strictEqual(janes[0].programme, 'WELDING L2', 'programme not backfilled on adoption');
});

test('name collisions get unique usernames', function () {
  var env = makeEnv();
  env.students.push(
    { id: 'STU-A', name: 'Romario Jackson', course: 'Welding' },
    { id: 'STU-B', name: 'Romario Jackson', course: 'Photovoltaic Installer' }
  );
  loadChatFns(env).lmsChatEnsureStudentAccounts();
  var names = env.userAccounts.map(function (u) { return u.username; });
  assert.strictEqual(new Set(names).size, names.length, 'usernames not unique: ' + names);
});

test('tombstoned (deleted) students never get accounts minted', function () {
  var env = makeEnv();
  env.deletedIds['STU-DEAD'] = true;
  env.students.push({ id: 'STU-DEAD', name: 'Ghost Student', course: 'Welding' });
  loadChatFns(env).lmsChatEnsureStudentAccounts();
  assert.strictEqual(env.userAccounts.length, 0, 'account minted for deleted student');
});

test('malformed student records are skipped without aborting the sync', function () {
  var env = makeEnv();
  env.students.push(
    null,
    { id: 'STU-NONAME' },
    { id: 'STU-NUM', name: 12345, course: 6789 },       // non-string fields
    { id: 'STU-OK', name: 'Real Person', course: 'Welding' }
  );
  loadChatFns(env).lmsChatEnsureStudentAccounts();
  assert.ok(env.userAccounts.some(function (u) { return u.studentDataId === 'STU-OK'; }),
    'good record after bad ones was not processed');
});

test('sync is idempotent across repeated runs', function () {
  var env = makeEnv();
  env.students.push(
    { id: 'STU-1', name: 'Rashaun Barrett', course: 'Welding L2' },
    { id: 'STU-2', name: 'Romario Jackson', course: 'Photovoltaic Installer' }
  );
  var api = loadChatFns(env);
  api.lmsChatEnsureStudentAccounts();
  var count = env.userAccounts.length;
  api.lmsChatEnsureStudentAccounts();
  api.lmsChatEnsureStudentAccounts();
  assert.strictEqual(env.userAccounts.length, count, 'accounts grew on re-run');
});

/* ---- eligibility -------------------------------------------------------- */
test('eligibility: active and disabled count; pending/rejected do not; missing status counts (legacy)', function () {
  var api = loadChatFns(makeEnv());
  assert.strictEqual(api.lmsChatAccountEligible({ status: 'active' }), true);
  assert.strictEqual(api.lmsChatAccountEligible({ status: 'disabled' }), true);
  assert.strictEqual(api.lmsChatAccountEligible({}), true, 'legacy account with no status must stay visible');
  assert.strictEqual(api.lmsChatAccountEligible({ status: 'pending' }), false);
  assert.strictEqual(api.lmsChatAccountEligible({ status: 'rejected' }), false);
  assert.strictEqual(api.lmsChatAccountEligible(null), false);
});

/* ---- room membership ---------------------------------------------------- */
test('students land in their skill-area room, including via course aliases', function () {
  var env = makeEnv();
  env.students.push(
    { id: 'STU-1', name: 'Rashaun Barrett', course: 'Welding L2' },
    { id: 'STU-2', name: 'Romario Jackson', course: 'Photovoltaic Installer' }
  );
  env.userAccounts.push({ id: 'USR-001', name: 'Administrator', role: 'admin', username: 'admin', status: 'active' });
  var api = loadChatFns(env);
  api.lmsChatEnsureMembership();
  var rooms = api.rooms();
  var weld = rooms.find(function (r) { return r.id === 'chat-class-1'; });
  var solar = rooms.find(function (r) { return r.id === 'chat-class-18'; });
  assert.ok(weld && solar, 'skill-area rooms not created');
  var acct = function (sid) { return env.userAccounts.find(function (u) { return u.studentDataId === sid; }); };
  assert.ok(weld.members.indexOf(acct('STU-1').id) !== -1, 'Welding L2 student missing from welding room');
  assert.ok(solar.members.indexOf(acct('STU-2').id) !== -1, 'Photovoltaic student missing from solar room');
  assert.ok(weld.members.indexOf('USR-001') !== -1, 'admin missing from class room');
});

test('pending and rejected accounts are never auto-added to rooms', function () {
  var env = makeEnv();
  env.userAccounts.push(
    { id: 'USR-P', name: 'Pending Person', role: 'student', username: 'p', status: 'pending', programme: 'Welding' },
    { id: 'USR-R', name: 'Rejected Person', role: 'student', username: 'r', status: 'rejected', programme: 'Welding' },
    { id: 'USR-L', name: 'Legacy NoStatus', role: 'student', username: 'l', programme: 'Welding' }
  );
  var api = loadChatFns(env);
  api.lmsChatEnsureMembership();
  var weld = api.rooms().find(function (r) { return r.id === 'chat-class-1'; });
  assert.ok(weld.members.indexOf('USR-P') === -1, 'pending account added to room');
  assert.ok(weld.members.indexOf('USR-R') === -1, 'rejected account added to room');
  assert.ok(weld.members.indexOf('USR-L') !== -1, 'legacy no-status account missing from room');
});

test('blank programmes are backfilled from the linked student record before matching', function () {
  var env = makeEnv();
  env.students.push({ id: 'STU-5', name: 'Blank Prog', course: 'Welding' });
  env.userAccounts.push({ id: 'USR-5', name: 'Blank Prog', role: 'student', username: 'b.p', status: 'disabled', programme: '', studentDataId: 'STU-5' });
  var api = loadChatFns(env);
  api.lmsChatEnsureMembership();
  var weld = api.rooms().find(function (r) { return r.id === 'chat-class-1'; });
  assert.strictEqual(env.userAccounts[0].programme, 'Welding', 'programme not backfilled');
  assert.ok(weld.members.indexOf('USR-5') !== -1, 'backfilled student missing from room');
});

test('a malformed room record does not abort the membership refresh', function () {
  var env = makeEnv();
  env.students.push({ id: 'STU-1', name: 'Rashaun Barrett', course: 'Welding L2' });
  env.lmsChatRooms.push({ id: 'chat-class-999', type: 'class', members: [] }); // no name
  var api = loadChatFns(env);
  api.lmsChatEnsureMembership();
  var weld = api.rooms().find(function (r) { return r.id === 'chat-class-1'; });
  assert.ok(weld, 'membership refresh aborted by malformed room');
  var acct = env.userAccounts.find(function (u) { return u.studentDataId === 'STU-1'; });
  assert.ok(weld.members.indexOf(acct.id) !== -1, 'student not placed despite malformed sibling room');
});

test('membership refresh is idempotent', function () {
  var env = makeEnv();
  env.students.push({ id: 'STU-1', name: 'Rashaun Barrett', course: 'Welding L2' });
  var api = loadChatFns(env);
  api.lmsChatEnsureMembership();
  var snapshot = JSON.stringify(api.rooms()) + '|' + env.userAccounts.length;
  api.lmsChatEnsureMembership();
  assert.strictEqual(JSON.stringify(api.rooms()) + '|' + env.userAccounts.length, snapshot, 'second run changed state');
});

/* ---- guard the directory's active+disabled contract --------------------- */
test('members directory and manage-members no longer filter to active-only', function () {
  var dir = extractFn('lmsChatRenderMembersDirectory');
  var manage = extractFn('lmsChatManageMembers');
  assert.ok(dir.indexOf("u.status === 'active'") === -1, 'directory regressed to active-only filter');
  assert.ok(manage.indexOf("u.status === 'active'") === -1, 'manage-members regressed to active-only filter');
  assert.ok(dir.indexOf('lmsChatGetRosterUsers') !== -1, 'directory no longer uses the shared roster');
  assert.ok(manage.indexOf('lmsChatGetRosterUsers') !== -1, 'manage-members no longer uses the shared roster');
});

console.log('\n' + passed + ' LMS chat roster tests passed');
