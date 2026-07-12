/* ============================================================================
   cestis-core.js — The single shared data-core for the CESTIS LMS.

   WHY THIS FILE EXISTS
   --------------------
   Historically every HTML page re-implemented its own copy of the storage
   layer, the student de-duplication / merge / relink logic and the course
   catalogue. Those copies drifted apart, which is the root cause behind the
   recurring "duplicate students", "stale data" and "didn't update on the other
   page" bugs. This module is the ONE place that logic lives now. Every page
   loads it with <script src="cestis-core.js"></script> BEFORE its own inline
   script, so there is exactly one implementation that cannot drift.

   DESIGN RULES
   ------------
   1. Backward compatible: window.CESTISStore keeps the exact same synchronous
      getItem/setItem/removeItem API the whole app already calls, so existing
      call sites keep working unchanged.
   2. Stable identity: a student's id is derived deterministically from their
      natural key (name|course), so the SAME person gets the SAME id on every
      device. This is what stops cross-device sync from creating duplicates.
   3. Pure & testable: the merge/dedupe/relink/migration helpers are pure
      functions that take data in and return data out, so they can be unit
      tested in Node (see tests/cestis-core.test.js) with no browser.
   4. Node-safe: guarded so this file can be require()'d in Node for testing.
   ============================================================================ */
(function (root) {
  'use strict';

  /* --------------------------------------------------------------------------
     CESTISStore — localStorage-compatible API backed by IndexedDB.
     IndexedDB has a far larger quota than localStorage (~5MB), so large data
     (e.g. staff records with embedded document blobs) no longer overflows.
     A synchronous in-memory cache preserves the existing synchronous
     getItem/setItem/removeItem call sites; writes persist to IndexedDB
     (durable) and mirror to localStorage when they still fit.

     This is the canonical copy. The identical IIFE inlined in each HTML page
     self-guards with `if (window.CESTISStore) return;`, so once this file has
     defined it, every page's inline copy becomes a harmless no-op.
     -------------------------------------------------------------------------- */
  (function () {
    if (!root || root.CESTISStore) return;
    if (typeof indexedDB === 'undefined') return; // Node / non-browser: skip the store, keep the helpers.
    var DB_NAME = 'CESTIS_KV', STORE = 'kv', LS = null;
    try { LS = root.localStorage; } catch (e) { LS = null; }
    var cache = {};
    try { if (LS) { for (var i = 0; i < LS.length; i++) { var k = LS.key(i); cache[k] = LS.getItem(k); } } } catch (e) {}

    var db = null, ready = false, wq = [];
    // Durable-write failure tracking: quota errors on the IndexedDB transaction
    // fire asynchronously (transaction onerror/onabort), so a plain try/catch
    // never sees them. Record the failure and notify the app so it can warn the
    // user instead of silently losing every write from that point on.
    var writeFailCount = 0;
    function reportWriteFailure(k, err) {
      writeFailCount++;
      try { root._cestisStoreWriteFailures = writeFailCount; } catch (_) {}
      try { console.error('[CESTISStore] Durable write FAILED for key "' + k + '":', err); } catch (_) {}
      try { root.dispatchEvent(new CustomEvent('cestis-store-write-error', { detail: { key: k, count: writeFailCount } })); } catch (_) {}
    }
    function drainQueue() { var q = wq; wq = []; for (var i = 0; i < q.length; i++) { writeIDB(q[i].k, q[i].v, q[i].del); } }
    function writeIDB(k, v, del) {
      if (!db) { if (!ready) { wq.push({ k: k, v: v, del: del }); } return; }
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.onerror = function (e) { reportWriteFailure(k, e && e.target && e.target.error); };
        tx.onabort = function (e) { reportWriteFailure(k, (e && e.target && e.target.error) || 'transaction aborted'); };
        var os = tx.objectStore(STORE); if (del) { os.delete(k); } else { os.put(v, k); }
      } catch (e) { reportWriteFailure(k, e); }
    }
    // Ask the browser to protect this origin's storage from automatic eviction —
    // essential for a system whose primary datastore is IndexedDB for years.
    try { if (root.navigator && root.navigator.storage && root.navigator.storage.persist) { root.navigator.storage.persist(); } } catch (e) {}
    try {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) { var d = e.target.result; if (!d.objectStoreNames.contains(STORE)) { d.createObjectStore(STORE); } };
      req.onsuccess = function (e) {
        db = e.target.result;
        try {
          var idbKeys = {};
          var cur = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
          cur.onsuccess = function (ev) {
            var c = ev.target.result;
            if (c) { idbKeys[c.key] = 1; if (!(c.key in cache)) { cache[c.key] = c.value; } c.continue(); }
            else {
              try {
                var ws = db.transaction(STORE, 'readwrite').objectStore(STORE);
                for (var kk in cache) { if (Object.prototype.hasOwnProperty.call(cache, kk) && !idbKeys[kk]) { ws.put(cache[kk], kk); } }
              } catch (_) {}
              ready = true; drainQueue(); try { root.dispatchEvent(new Event('cestis-store-ready')); } catch (_) {}
            }
          };
          cur.onerror = function () { ready = true; drainQueue(); };
        } catch (e) { ready = true; drainQueue(); }
      };
      req.onerror = function () { db = null; ready = true; };
    } catch (e) { db = null; ready = true; }

    var Store = {
      _cache: cache,
      getItem: function (k) { k = String(k); return (k in cache) ? cache[k] : null; },
      setItem: function (k, v) { k = String(k); v = String(v); cache[k] = v; try { if (LS) LS.setItem(k, v); } catch (e) {} writeIDB(k, v, false); },
      removeItem: function (k) { k = String(k); delete cache[k]; try { if (LS) LS.removeItem(k); } catch (e) {} writeIDB(k, null, true); },
      clear: function () {
        for (var k in cache) { if (Object.prototype.hasOwnProperty.call(cache, k)) delete cache[k]; }
        try { if (LS) LS.clear(); } catch (e) {}
        if (db) { try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch (e) {} }
      },
      key: function (i) { return Object.keys(cache)[i]; },
      keys: function () { return Object.keys(cache); },
      hasOwnProperty: function (k) { return Object.prototype.hasOwnProperty.call(cache, String(k)); },
      whenReady: function (cb) { if (ready) { cb(); } else { root.addEventListener('cestis-store-ready', cb, { once: true }); } },
      get length() { return Object.keys(cache).length; }
    };
    root.CESTISStore = Store;
  })();

  /* ==========================================================================
     CESTISCore — shared domain logic. Pure where possible.
     ========================================================================== */
  var Core = {};
  Core.VERSION = '1.0.0';

  /* --- Canonical course catalogue ----------------------------------------
     Previously hardcoded separately in index.html and Qual-Plan-Curriculum.html
     (drift risk). This is now the one source. freshSkillAreas() returns a deep
     copy so callers can mutate the per-render counts without corrupting it. */
  var SKILL_AREAS = [
    { id: 1, name: "Welding & Fabrication", icon: "🔥", color: "#e74c3c", students: 0, materials: 0, desc: "SMAW, MIG, TIG welding processes and metal fabrication" },
    { id: 2, name: "Electrical Installation", icon: "⚡", color: "#f1c40f", students: 0, materials: 0, desc: "Residential and commercial wiring, conduit bending, circuits" },
    { id: 3, name: "Cosmetology", icon: "💇", color: "#e91e63", students: 0, materials: 0, desc: "Hair care, styling, chemical treatments, salon management" },
    { id: 4, name: "Business Administration", icon: "💼", color: "#3498db", students: 0, materials: 0, desc: "Office management, accounting, business communication" },
    { id: 5, name: "Auto Mechanics", icon: "🔧", color: "#e67e22", students: 0, materials: 0, desc: "Engine repair, diagnostics, brake and suspension systems" },
    { id: 6, name: "Plumbing", icon: "🔩", color: "#1abc9c", students: 0, materials: 0, desc: "Pipe fitting, drainage systems, water supply installation" },
    { id: 7, name: "Carpentry", icon: "🪚", color: "#8d6e63", students: 0, materials: 0, desc: "Furniture making, roof framing, cabinet installation" },
    { id: 8, name: "Hospitality & Tourism", icon: "🏨", color: "#9b59b6", students: 0, materials: 0, desc: "Food & beverage service, front office, housekeeping" },
    { id: 9, name: "Information Technology", icon: "💻", color: "#2196f3", students: 0, materials: 0, desc: "Networking, hardware repair, software applications" },
    { id: 10, name: "Garment Construction", icon: "🧵", color: "#ff7043", students: 0, materials: 0, desc: "Pattern drafting, sewing techniques, fashion design basics" },
    { id: 11, name: "Refrigeration & AC", icon: "❄️", color: "#00bcd4", students: 0, materials: 0, desc: "AC installation, refrigerant handling, system maintenance" },
    { id: 12, name: "Heavy Equipment Ops", icon: "🚜", color: "#ff9800", students: 0, materials: 0, desc: "Excavator, loader, bulldozer operation and safety" },
    { id: 13, name: "Commercial Cooking", icon: "👨‍🍳", color: "#4caf50", students: 0, materials: 0, desc: "Culinary arts, food safety, menu planning, pastry arts" },
    { id: 14, name: "Beauty Therapy", icon: "💆", color: "#ce93d8", students: 0, materials: 0, desc: "Facial treatments, body massage, nail technology" },
    { id: 15, name: "Data Operations", icon: "📊", color: "#42a5f5", students: 0, materials: 0, desc: "Data entry, spreadsheets, database management" },
    { id: 16, name: "Agriculture", icon: "🌾", color: "#66bb6a", students: 0, materials: 0, desc: "Crop production, livestock management, agribusiness" },
    { id: 17, name: "Masonry", icon: "🧱", color: "#a1887f", students: 0, materials: 0, desc: "Block laying, plastering, tiling, concrete work" },
    { id: 18, name: "Solar Energy Tech", icon: "☀️", color: "#fdd835", students: 0, materials: 0, desc: "PV installation, solar system design, inverter setup" },
    { id: 19, name: "Early Childhood Ed", icon: "👶", color: "#ef9a9a", students: 0, materials: 0, desc: "Child development, lesson planning, classroom management" },
    { id: 20, name: "Customer Service", icon: "🎯", color: "#7e57c2", students: 0, materials: 0, desc: "Communication skills, conflict resolution, CRM systems" }
  ];
  Core.SKILL_AREAS = SKILL_AREAS;
  Core.freshSkillAreas = function () { return JSON.parse(JSON.stringify(SKILL_AREAS)); };

  Core.STAGES = ['testing', 'interview', 'training', 'certified', 'collected', 'incomplete'];
  Core.STAGE_LABELS = { testing: 'Testing', interview: 'Interview', training: 'In Training', certified: 'Certified', collected: 'Collected', incomplete: 'Incomplete' };
  Core.STAGE_BADGE = { testing: 'badge-blue', interview: 'badge-purple', training: 'badge-amber', certified: 'badge-green', collected: 'badge-green', incomplete: 'badge-red' };
  Core.STAGE_ICONS = { testing: '📝', interview: '🗣️', training: '📚', certified: '🎓', collected: '✅', incomplete: '⚠️' };

  /* --- Hashing (identical to the app's existing cestisHashString) --------- */
  Core.hashString = function (str) {
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
  };

  /* --- Normalisation & stable identity -----------------------------------
     The natural key is (name|course), matching the de-dup key the app has
     always used — so migrating to stable ids collapses exactly the records the
     system already considers duplicates, with no surprising new merges/splits.
     The difference is the id is now DETERMINISTIC, so the same person resolves
     to the same id on every device and cloud sync stops minting duplicates. */
  Core.normName = function (s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); };
  Core.normCourse = function (s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); };

  Core.naturalKey = function (student) {
    if (!student) return '';
    var n = Core.normName(student.name);
    var c = Core.normCourse(student.course);
    if (!n) return ''; // no usable identity — caller should keep the existing id
    return n + '|' + c;
  };

  // True if an id looks machine-generated (e.g. 'STU'+Date.now()[+random])
  // rather than human-entered, so it is safe to restabilise. A deterministic
  // stable id ('STU-<hash>') returns false because the dash breaks the digit
  // run — which is what keeps fee-id stabilisation idempotent.
  Core.isAutoGeneratedId = function (id) {
    if (id == null || id === '') return true;
    return /^STU\d{10,}/.test(String(id));
  };

  // Deterministic id derived from the natural key. Prefixed STU- to match the
  // app's id convention and to be visually distinct from raw timestamps.
  Core.stableStudentId = function (student) {
    var key = Core.naturalKey(student);
    if (!key) return null;
    return 'STU-' + Core.hashString(key);
  };

  /* --- Student record merge (pure; identical semantics to the app) -------- */
  var MERGE_FIELDS = ['stage', 'progress', 'score', 'gpa', 'certNo', 'certDate', 'certCollected',
    'attendance', 'assignments', 'instructor', 'email', 'phone', 'address',
    'dob', 'enrollDate', 'completionDate', 'nqfLevel', 'notes', 'gender',
    // Cross-system link fields — must survive a merge so the School-Fee <-> LMS
    // link is not lost when a fee-linked record and a manual record collapse.
    'schoolFeeId', 'source'];

  Core.mergeStudentRecords = function (a, b) {
    var aMod = a && a.lastModified ? new Date(a.lastModified).getTime() : 0;
    var bMod = b && b.lastModified ? new Date(b.lastModified).getTime() : 0;
    var base = (bMod > aMod) ? Object.assign({}, b) : Object.assign({}, a);
    var other = (bMod > aMod) ? a : b;
    MERGE_FIELDS.forEach(function (f) {
      if ((base[f] === undefined || base[f] === null || base[f] === '') &&
          other[f] !== undefined && other[f] !== null && other[f] !== '') {
        base[f] = other[f];
      }
    });
    return base;
  };

  /* --- De-duplicate a student array (pure) -------------------------------
     Returns { students, removed, idMap } where idMap[oldId] = keptId for every
     removed duplicate. Records with no usable natural key are passed through
     untouched (same behaviour the app has always had). */
  Core.dedupeStudents = function (input) {
    var list = Array.isArray(input) ? input : [];
    var seen = {};    // key -> kept record
    var idMap = {};   // oldId -> keptId

    list.forEach(function (s) {
      var key = Core.naturalKey(s);
      if (!key) return;
      if (seen[key]) {
        var prev = seen[key];
        seen[key] = Core.mergeStudentRecords(prev, s);
        if (seen[key].id !== prev.id) idMap[prev.id] = seen[key].id;
        if (seen[key].id !== s.id) idMap[s.id] = seen[key].id;
      } else {
        seen[key] = s;
      }
    });

    var added = {}, deduped = [];
    list.forEach(function (s) {
      var key = Core.naturalKey(s);
      if (!key) { deduped.push(s); return; }
      if (!added[key]) {
        added[key] = true;
        deduped.push(seen[key]);
        if (s.id !== seen[key].id) idMap[s.id] = seen[key].id;
      } else {
        if (s.id !== seen[key].id) idMap[s.id] = seen[key].id;
      }
    });

    return { students: deduped, removed: list.length - deduped.length, idMap: idMap };
  };

  /* --- Relink dependent arrays after ids change (pure-ish; mutates input) -
     `data` is an object with any of: userAccounts, attendanceRecords,
     certDownloadApprovals, examResults. Every reference to a remapped student
     id is updated to the kept id, and the obvious duplicates that result are
     collapsed — mirroring relinkDependentData() in index.html. */
  Core.relinkDependentData = function (idMap, data) {
    data = data || {};
    if (!idMap || Object.keys(idMap).length === 0) return data;

    if (Array.isArray(data.userAccounts)) {
      data.userAccounts.forEach(function (u) {
        if (u && u.studentDataId && idMap[u.studentDataId]) u.studentDataId = idMap[u.studentDataId];
      });
      var seenAcct = {};
      data.userAccounts = data.userAccounts.filter(function (u) {
        if (!u || !u.studentDataId) return true;
        if (seenAcct[u.studentDataId]) {
          var prev = seenAcct[u.studentDataId];
          if ((u.password && !prev.password) || (u.status === 'active' && prev.status !== 'active')) {
            seenAcct[u.studentDataId] = u;
            return true;
          }
          return false;
        }
        seenAcct[u.studentDataId] = u;
        return true;
      });
    }

    if (Array.isArray(data.attendanceRecords)) {
      data.attendanceRecords.forEach(function (r) {
        if (r && r.studentId && idMap[r.studentId]) r.studentId = idMap[r.studentId];
      });
    }

    if (Array.isArray(data.certDownloadApprovals)) {
      data.certDownloadApprovals.forEach(function (c) {
        if (c && c.studentId && idMap[c.studentId]) c.studentId = idMap[c.studentId];
      });
      var seenCert = {};
      data.certDownloadApprovals = data.certDownloadApprovals.filter(function (c) {
        if (!c || !c.studentId) return true;
        if (seenCert[c.studentId]) return false;
        seenCert[c.studentId] = true;
        return true;
      });
    }

    if (Array.isArray(data.examResults)) {
      data.examResults.forEach(function (r) {
        if (r && r.studentId && idMap[r.studentId]) r.studentId = idMap[r.studentId];
      });
    }

    if (Array.isArray(data.transcriptGrades)) {
      data.transcriptGrades.forEach(function (g) {
        if (g && g.studentId && idMap[g.studentId]) g.studentId = idMap[g.studentId];
      });
    }

    if (Array.isArray(data.certTranscriptRequests)) {
      data.certTranscriptRequests.forEach(function (r) {
        if (r && r.studentId && idMap[r.studentId]) r.studentId = idMap[r.studentId];
      });
    }

    return data;
  };

  /* --- One-time migration to stable ids (pure-ish; mutates `data`) --------
     1. De-duplicate by natural key (collapses cross-device duplicates).
     2. Assign each surviving student its deterministic stable id.
     3. Relink every dependent array through the composed id map.
     Returns { changed, idMap, removed }. Safe to run repeatedly (idempotent):
     once ids are stable, step 2 produces no changes. */
  Core.migrateToStableIds = function (data) {
    data = data || {};
    var students = Array.isArray(data.students) ? data.students : [];

    var dr = Core.dedupeStudents(students);
    var survivors = dr.students;
    var idMap = {};
    var k;
    for (k in dr.idMap) { if (Object.prototype.hasOwnProperty.call(dr.idMap, k)) idMap[k] = dr.idMap[k]; }

    survivors.forEach(function (s) {
      var newId = Core.stableStudentId(s);
      if (!newId) return; // no natural key — leave id alone
      if (s.id !== newId) {
        var oldId = s.id;
        s.id = newId;
        if (oldId != null) idMap[oldId] = newId;
      }
    });

    // Compose: any id previously mapped to a survivor whose id then changed
    // must now point at the survivor's new stable id.
    for (k in idMap) {
      if (!Object.prototype.hasOwnProperty.call(idMap, k)) continue;
      var target = idMap[k];
      // Follow one extra hop if the target itself was later restabilised.
      if (idMap[target] && idMap[target] !== target) idMap[k] = idMap[target];
    }

    data.students = survivors;
    Core.relinkDependentData(idMap, data);

    var changed = Object.keys(idMap).length > 0 || dr.removed > 0;
    return { changed: changed, idMap: idMap, removed: dr.removed };
  };

  /* --- Deletion tombstones ----------------------------------------------
     Stored as a JSON array of ids under voctrain_deletedStudentIds (the format
     the app already uses). Because ids are now stable, a deleted student keeps
     the same id when re-synced from another device, so the tombstone reliably
     prevents resurrection. */
  Core.TOMBSTONE_KEY = 'voctrain_deletedStudentIds';
  function _store(s) { return s || root.CESTISStore; }
  Core.readDeletedIds = function (store) {
    store = _store(store);
    try {
      var raw = store && store.getItem(Core.TOMBSTONE_KEY);
      if (!raw) return {};
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return {};
      var map = {};
      arr.forEach(function (id) { if (id) map[id] = true; });
      return map;
    } catch (e) { return {}; }
  };
  Core.isStudentDeleted = function (id, store) {
    if (!id) return false;
    return Core.readDeletedIds(store)[id] === true;
  };
  Core.recordDeletedStudent = function (id, store) {
    if (!id) return;
    store = _store(store);
    try {
      var existing = Core.readDeletedIds(store);
      existing[id] = true;
      if (store) store.setItem(Core.TOMBSTONE_KEY, JSON.stringify(Object.keys(existing)));
    } catch (e) {}
  };

  // Drop any student that has been tombstoned (deleted), matching on BOTH the
  // record's current id and its deterministic stable id. This is the single
  // chokepoint that prevents a deleted student from re-emerging no matter which
  // path re-added them (cloud merge under a legacy/fee id, account reconcile,
  // recovery, etc.) — because even a copy carrying a different id resolves to
  // the same tombstoned stable id. Returns the kept list + the dropped ids so
  // callers can purge dependent records.
  Core.dropTombstonedStudents = function (students, deletedMap) {
    deletedMap = deletedMap || {};
    var dropped = {};
    var kept = (students || []).filter(function (s) {
      if (!s) return false;
      var sid = Core.stableStudentId(s);
      if (deletedMap[s.id] === true || (sid && deletedMap[sid] === true)) {
        if (s.id != null) dropped[s.id] = true;
        return false;
      }
      return true;
    });
    return { students: kept, droppedIds: Object.keys(dropped), removed: (students ? students.length : 0) - kept.length };
  };

  /* --- Lightweight change bus -------------------------------------------
     A single in-page pub/sub plus an optional cross-document (postMessage)
     bridge so any page can announce "students changed" and every listener —
     including iframes — reacts, instead of relying on callers to remember to
     call refreshXView(). Opt-in: pages wire emit()/on() where useful. */
  var listeners = {};
  Core.on = function (event, cb) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(cb);
    return function () { Core.off(event, cb); };
  };
  Core.off = function (event, cb) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(function (f) { return f !== cb; });
  };
  Core.emit = function (event, payload) {
    (listeners[event] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (e) { /* one bad listener must not break the rest */ }
    });
  };

  /* ==========================================================================
     MASTER SNAPSHOT — one self-describing JSON of the entire data store.
     Saved to Drive on logout / tab-close / periodically; read on login to
     reconcile (merge & repair) and to let an algorithm detect data loss.
     All logic here is pure: it takes a plain { key: value } map of the store
     and returns data out, so it is fully unit-testable without a browser.
     ========================================================================== */
  Core.SNAPSHOT_SCHEMA_VERSION = 1;

  // Collections we report counts / missing-id deltas for (the loss-detection
  // signal). Arrays or id-keyed; everything else is still snapshotted, just not
  // diffed at id granularity.
  Core.SNAPSHOT_COUNT_KEYS = [
    'voctrain_students', 'voctrain_users', 'voctrain_attendance', 'voctrain_examResults',
    'voctrain_certDownloadApprovals', 'voctrain_instructorData',
    'voctrain_unitCatalogs', 'voctrain_transcriptGrades', 'voctrain_certTranscriptRequests',
    'cestiSchoolFeeStudents', 'cestiSchoolFeePayments'
  ];

  // Deletion-tombstone keys. These are UNIONED (never overwritten) during
  // reconcile because tombstones only ever grow — that is how a delete on one
  // device propagates to all others so deleted data cannot re-emerge anywhere.
  Core.TOMBSTONE_UNION_KEYS = ['voctrain_deletedStudentIds', 'cestiSchoolFeeDeletedLmsIds'];

  // Keys that must NEVER leave the device inside a shared snapshot: auth tokens,
  // session pointers, per-device Drive metadata and volatile UI flags. Excluding
  // these prevents session/token bleed across devices and keeps the file clean.
  Core.isSnapshotableKey = function (key) {
    if (!key) return false;
    key = String(key);
    if (/token/i.test(key)) return false;            // cestisGoogleAccessToken, *Token
    if (/session/i.test(key)) return false;          // voctrain_session*
    if (/cloudfileid/i.test(key)) return false;      // *CloudFileId
    if (/lastsync/i.test(key)) return false;         // *LastSyncTime
    if (key === 'darkMode') return false;
    if (/examInProgress/i.test(key)) return false;   // volatile exam state
    return true;
  };

  Core._parseArr = function (raw) {
    try { var v = JSON.parse(raw || 'null'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  };

  // Deterministic serialisation of the store map (sorted keys) so the checksum
  // is stable regardless of key insertion order across devices.
  Core.stableStringify = function (storeObj) {
    storeObj = storeObj || {};
    return Object.keys(storeObj).sort().map(function (k) {
      return k + ' ' + String(storeObj[k]);
    }).join('');
  };

  Core.snapshotCounts = function (store) {
    store = store || {};
    var c = {};
    Core.SNAPSHOT_COUNT_KEYS.forEach(function (k) {
      var n = 0;
      try {
        var v = JSON.parse(store[k] == null ? 'null' : store[k]);
        if (Array.isArray(v)) n = v.length;
        else if (v && typeof v === 'object') n = Object.keys(v).length;
      } catch (e) {}
      c[k] = n;
    });
    return c;
  };

  // Build the self-describing snapshot object from a { key: value } store map.
  Core.buildSnapshot = function (storeMap, meta) {
    meta = meta || {};
    var store = {};
    Object.keys(storeMap || {}).forEach(function (k) {
      if (!Core.isSnapshotableKey(k)) return;
      var v = storeMap[k];
      if (v == null) return;
      store[k] = (typeof v === 'string') ? v : JSON.stringify(v);
    });
    return {
      schemaVersion: Core.SNAPSHOT_SCHEMA_VERSION,
      app: 'CESTIS-LMS',
      savedAt: meta.savedAt || new Date().toISOString(),
      savedBy: meta.savedBy || 'unknown',
      savedByRole: meta.savedByRole || 'unknown',
      event: meta.event || 'manual',
      keyCount: Object.keys(store).length,
      counts: Core.snapshotCounts(store),
      checksum: Core.hashString(Core.stableStringify(store)),
      store: store
    };
  };

  // Re-derive the checksum and confirm the snapshot's store is intact.
  Core.verifySnapshot = function (snapshot) {
    if (!snapshot || !snapshot.store) return { ok: false, reason: 'no-store' };
    var actual = Core.hashString(Core.stableStringify(snapshot.store));
    return { ok: actual === snapshot.checksum, expected: snapshot.checksum, actual: actual };
  };

  // THE DATA-LOSS ALGORITHM. Compares a snapshot to the current local store map
  // and reports, per collection, how many records the snapshot has that local is
  // missing (i.e. that would be lost without recovery). Tombstoned (deliberately
  // deleted) students are not counted as "lost".
  Core.dataLossReport = function (snapshot, localStoreMap) {
    localStoreMap = localStoreMap || {};
    var rep = { checksumOk: Core.verifySnapshot(snapshot).ok, collections: {}, missingLocally: {}, totalMissing: 0 };
    var snapStore = (snapshot && snapshot.store) || {};
    var deleted = {};
    Core._parseArr(localStoreMap['voctrain_deletedStudentIds']).forEach(function (id) { if (id) deleted[id] = true; });
    Core.SNAPSHOT_COUNT_KEYS.forEach(function (k) {
      var snapArr = Core._parseArr(snapStore[k]);
      var locArr = Core._parseArr(localStoreMap[k]);
      var locIds = {};
      locArr.forEach(function (r) { if (r && r.id != null) locIds[r.id] = true; });
      var isStudents = (k === 'voctrain_students');
      var missing = snapArr.filter(function (r) {
        if (!r || r.id == null) return false;
        if (locIds[r.id]) return false;
        if (isStudents && deleted[r.id]) return false; // intentionally deleted, not lost
        return true;
      });
      rep.collections[k] = { snapshot: snapArr.length, local: locArr.length, missingFromLocal: missing.length };
      if (missing.length) { rep.missingLocally[k] = missing.map(function (r) { return r.id; }); rep.totalMissing += missing.length; }
    });
    return rep;
  };

  // MERGE & REPAIR. Returns a new store map that unions the snapshot into local
  // without losing data: missing records are restored, newer local edits are
  // preserved, tombstoned students are never resurrected, and students are kept
  // duplicate-free via the stable-id dedupe. Non-array keys are restored only
  // when local is missing/empty (never overwrites populated local config).
  Core.reconcileSnapshot = function (snapshot, localStoreMap) {
    localStoreMap = localStoreMap || {};
    var out = {}; var k;
    for (k in localStoreMap) { if (Object.prototype.hasOwnProperty.call(localStoreMap, k)) out[k] = localStoreMap[k]; }
    var snapStore = (snapshot && snapshot.store) || {};
    var result = { store: out, changed: false, restored: {}, recoveredStudents: 0, restoredKeys: [], droppedTombstoned: 0 };

    // 1) Union deletion tombstones (local + snapshot). Tombstones only grow, so
    //    unioning is always safe — this propagates a delete made on one device to
    //    every other device so deleted data cannot re-emerge anywhere.
    Core.TOMBSTONE_UNION_KEYS.forEach(function (tk) {
      var snapIds = Core._parseArr(snapStore[tk]);
      if (!snapIds.length) return;
      var set = {}; Core._parseArr(localStoreMap[tk]).forEach(function (id) { if (id) set[id] = true; });
      var addedAny = false;
      snapIds.forEach(function (id) { if (id && !set[id]) { set[id] = true; addedAny = true; } });
      if (addedAny) { out[tk] = JSON.stringify(Object.keys(set)); result.changed = true; if (result.restoredKeys.indexOf(tk) === -1) result.restoredKeys.push(tk); }
    });
    var deletedStudents = {};
    Core._parseArr(localStoreMap['voctrain_deletedStudentIds']).forEach(function (id) { if (id) deletedStudents[id] = true; });
    Core._parseArr(snapStore['voctrain_deletedStudentIds']).forEach(function (id) { if (id) deletedStudents[id] = true; });

    // 2) id-keyed array collections: union (add-missing), keep local on id clash.
    Core.SNAPSHOT_COUNT_KEYS.forEach(function (key) {
      var isStudents = (key === 'voctrain_students');
      var snapArr = Core._parseArr(snapStore[key]);
      var locArr = Core._parseArr(localStoreMap[key]);
      var byId = {}; var order = [];
      locArr.forEach(function (r) { if (r && r.id != null) { byId[r.id] = r; order.push(r.id); } });
      var added = 0;
      snapArr.forEach(function (r) {
        if (!r || r.id == null) return;
        if (isStudents && deletedStudents[r.id]) return; // honor tombstone on add
        if (!(r.id in byId)) { byId[r.id] = r; order.push(r.id); added++; }
      });
      var merged = order.map(function (id) { return byId[id]; });
      var changedHere = (added > 0);
      if (isStudents) {
        // Drop any student (local OR added) that is now tombstoned, then dedupe.
        var dropRes = Core.dropTombstonedStudents(merged, deletedStudents);
        if (dropRes.removed > 0) { merged = dropRes.students; result.droppedTombstoned += dropRes.removed; changedHere = true; }
        var dr = Core.dedupeStudents(merged);
        if (dr.removed > 0) changedHere = true;
        merged = dr.students;
        result.recoveredStudents += added;
      }
      if (changedHere) {
        out[key] = JSON.stringify(merged);
        if (added > 0) result.restored[key] = added;
        result.changed = true;
      }
    });

    // 3) Any other snapshot key absent or empty locally: restore (fill-only),
    //    excluding the count keys and tombstone keys already handled above.
    Object.keys(snapStore).forEach(function (key) {
      if (Core.SNAPSHOT_COUNT_KEYS.indexOf(key) !== -1) return;
      if (Core.TOMBSTONE_UNION_KEYS.indexOf(key) !== -1) return;
      var local = localStoreMap[key];
      var localEmpty = (local == null || local === '' || local === '[]' || local === '{}');
      if (localEmpty && snapStore[key] != null && snapStore[key] !== '') {
        out[key] = snapStore[key];
        result.restoredKeys.push(key);
        result.changed = true;
      }
    });

    return result;
  };

  /* ==========================================================================
     QUARTER ENGINE — shared financial-year / quarter state for the whole app.

     WHY THIS EXISTS
     ---------------
     Several pages (Cashbook, Virement, and now School Fee, Staff Clock-In and
     Attendance) present their data one financial quarter at a time. Before this
     engine each page rolled its own FY/quarter maths and persisted the active
     selection differently, so "switch quarter here" did not switch it there.

     This block is the ONE source of truth:
       • the canonical Apr–Jun / Jul–Sep / Oct–Dec / Jan–Mar definition,
       • deriveQuarter(date)  — bucket any dated record into its FY+quarter,
       • getActiveQuarter()/setActiveQuarter() — read & write the single shared
         selection, persisted under 'cestis_active_quarter' (the key Cashbook &
         Virement already use, so they line up automatically),
       • setActiveQuarter() fires a 'cestis-quarter-changed' DOM event and the
         browser 'storage' event propagates the change to every other open tab,
         giving true "switch everywhere" behaviour.

     The pure helpers (deriveQuarter / quarterKey / labels) are Node-safe so they
     can be unit-tested without a browser.
     ========================================================================== */
  var ACTIVE_QUARTER_KEY = 'cestis_active_quarter';

  // The Sierra-Leone / CESTIS financial year starts in April. Q1 = Apr–Jun.
  Core.QUARTER_META = [
    { q: 1, label: 'Q1', months: 'Apr–Jun', startMonth: 4 },
    { q: 2, label: 'Q2', months: 'Jul–Sep', startMonth: 7 },
    { q: 3, label: 'Q3', months: 'Oct–Dec', startMonth: 10 },
    { q: 4, label: 'Q4', months: 'Jan–Mar', startMonth: 1 }
  ];

  // FY string for a (calendar year, 1-based month): months Apr..Dec belong to
  // FY <year>/<year+1>; Jan..Mar belong to FY <year-1>/<year>.
  function fyStringFor(year, month) {
    var startYear = (month >= 4) ? year : (year - 1);
    return startYear + '/' + (startYear + 1);
  }

  // Quarter number (1..4) for a 1-based calendar month.
  function quarterForMonth(month) {
    if (month >= 4 && month <= 6) return 1;
    if (month >= 7 && month <= 9) return 2;
    if (month >= 10 && month <= 12) return 3;
    return 4; // Jan, Feb, Mar
  }

  /* deriveQuarter(dateInput) -> { fy:'2026/2027', q:1 } | null
     Accepts a 'YYYY-MM-DD' string, an ISO timestamp, a Date, or anything Date
     can parse. Returns null for missing/unparseable input so callers can decide
     how to treat undated records. */
  Core.deriveQuarter = function (dateInput) {
    if (dateInput == null || dateInput === '') return null;
    var d;
    if (dateInput instanceof Date) {
      d = dateInput;
    } else {
      var s = String(dateInput);
      // Fast path for plain 'YYYY-MM-DD' to avoid timezone shifts.
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m) {
        var yr = parseInt(m[1], 10), mo = parseInt(m[2], 10);
        return { fy: fyStringFor(yr, mo), q: quarterForMonth(mo) };
      }
      d = new Date(s);
    }
    if (isNaN(d.getTime())) return null;
    var month = d.getMonth() + 1, year = d.getFullYear();
    return { fy: fyStringFor(year, month), q: quarterForMonth(month) };
  };

  // The FY+quarter that "today" falls in — the sensible default selection.
  Core.currentQuarter = function (now) {
    return Core.deriveQuarter(now || new Date());
  };

  Core.getQuarterMeta = function (q) {
    for (var i = 0; i < Core.QUARTER_META.length; i++) {
      if (Core.QUARTER_META[i].q === q) return Core.QUARTER_META[i];
    }
    return null;
  };

  // Calendar year that a given FY+quarter actually lands in (Q4 = Jan–Mar of the
  // second year of the FY span; Q1–Q3 are the first year).
  Core.quarterCalendarYear = function (fy, q) {
    var startYear = parseInt(String(fy).split('/')[0], 10);
    return (q === 4) ? startYear + 1 : startYear;
  };

  Core.fyLabel = function (fy) { return 'FY ' + fy; };
  Core.quarterShortLabel = function (fy, q) {
    var meta = Core.getQuarterMeta(q);
    return meta ? (meta.label + ' · ' + meta.months) : ('Q' + q);
  };
  Core.quarterPeriodLabel = function (fy, q) {
    var meta = Core.getQuarterMeta(q);
    var yr = Core.quarterCalendarYear(fy, q);
    return meta ? (meta.months + ' ' + yr) : ('Q' + q + ' ' + yr);
  };

  /* quarterKey(baseKey, fy, q) — namespace a storage key by quarter so a page can
     keep one bucket per quarter when it wants physical separation. Format mirrors
     the Cashbook convention ('<base>::<fy>_Q<n>'). */
  Core.quarterKey = function (baseKey, fy, q) {
    return baseKey + '::' + fy + '_Q' + q;
  };

  // True when two FY+quarter pairs are the same (null-safe).
  Core.sameQuarter = function (a, b) {
    return !!a && !!b && a.fy === b.fy && a.q === b.q;
  };

  /* recordInQuarter(record, fy, q, dateField) — does a dated record belong to the
     given quarter? Reads record[dateField] (default 'date'). Records that already
     carry explicit fy/quarter fields (e.g. Cashbook/Virement) honour those. */
  Core.recordInQuarter = function (record, fy, q, dateField) {
    if (!record) return false;
    if (record.fy != null && record.quarter != null) {
      return record.fy === fy && record.quarter === q;
    }
    var dq = Core.deriveQuarter(record[dateField || 'date']);
    return !!dq && dq.fy === fy && dq.q === q;
  };

  /* --- Active-quarter persistence + cross-page propagation (browser only) --- */
  Core.ACTIVE_QUARTER_KEY = ACTIVE_QUARTER_KEY;

  Core.getActiveQuarter = function () {
    try {
      var raw = root.CESTISStore ? root.CESTISStore.getItem(ACTIVE_QUARTER_KEY) : null;
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.fy && parsed.q) {
          return { fy: parsed.fy, q: parseInt(parsed.q, 10) };
        }
      }
    } catch (e) {}
    return Core.currentQuarter();
  };

  Core.setActiveQuarter = function (fy, q) {
    q = parseInt(q, 10);
    var val = { fy: fy, q: q };
    try {
      if (root.CESTISStore) root.CESTISStore.setItem(ACTIVE_QUARTER_KEY, JSON.stringify(val));
    } catch (e) {}
    // Notify this page's listeners immediately…
    try {
      if (root.dispatchEvent && typeof CustomEvent === 'function') {
        root.dispatchEvent(new CustomEvent('cestis-quarter-changed', { detail: val }));
      }
    } catch (e) {}
    return val;
  };

  /* onQuarterChange(cb) — subscribe to quarter switches from THIS page (custom
     event) AND from OTHER tabs (the native localStorage 'storage' event). Returns
     an unsubscribe function. cb receives { fy, q }. */
  Core.onQuarterChange = function (cb) {
    if (typeof cb !== 'function' || !root.addEventListener) return function () {};
    var localHandler = function (e) { cb((e && e.detail) || Core.getActiveQuarter()); };
    var storageHandler = function (e) {
      if (e && e.key === ACTIVE_QUARTER_KEY) cb(Core.getActiveQuarter());
    };
    root.addEventListener('cestis-quarter-changed', localHandler);
    root.addEventListener('storage', storageHandler);
    return function () {
      root.removeEventListener('cestis-quarter-changed', localHandler);
      root.removeEventListener('storage', storageHandler);
    };
  };

  /* mountQuarterBar(target, opts) — render the shared FY/quarter selector bar
     (the "FY 2026/2027  ◀ ▶  | Q1·Apr–Jun … | ◀ Prev Qtr  Next Qtr ▶" strip) into
     `target` (an element or element id) and keep it in sync with the shared
     active-quarter state. Clicking any control calls setActiveQuarter, which
     propagates to every other bar/page. opts.onChange({fy,q}) fires whenever the
     active quarter changes (from this bar OR another page/tab) so the host can
     re-render its data. Returns { destroy(), refresh() }. Browser-only. */
  Core.mountQuarterBar = function (target, opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return { destroy: function () {}, refresh: function () {} };
    var el = (typeof target === 'string') ? document.getElementById(target) : target;
    if (!el) return { destroy: function () {}, refresh: function () {} };

    if (!document.getElementById('cestis-qbar-styles')) {
      var st = document.createElement('style');
      st.id = 'cestis-qbar-styles';
      st.textContent =
        '.cestis-qbar{display:flex;flex-direction:column;gap:8px;align-items:center;padding:12px 14px;border-radius:12px;' +
        'background:linear-gradient(180deg,rgba(13,71,161,.06),rgba(13,71,161,.02));border:1px solid rgba(13,71,161,.18);margin:0 0 16px;}' +
        '.cestis-qbar-fy{display:flex;align-items:center;gap:14px;}' +
        '.cestis-qbar-fy .cestis-qbar-fylabel{font-weight:700;font-size:15px;letter-spacing:.5px;color:var(--text,#0D47A1);min-width:150px;text-align:center;}' +
        '.cestis-qbar-tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;}' +
        '.cestis-qbar-tab{cursor:pointer;border:1px solid rgba(13,71,161,.25);background:transparent;color:var(--text-muted,#5b6b80);' +
        'padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;transition:all .15s;}' +
        '.cestis-qbar-tab:hover{background:rgba(13,71,161,.08);}' +
        '.cestis-qbar-tab.active{background:#0D47A1;color:#fff;border-color:#0D47A1;box-shadow:0 0 0 3px rgba(13,71,161,.18);}' +
        '.cestis-qbar-btn{cursor:pointer;border:1px solid rgba(13,71,161,.25);background:transparent;color:var(--text,#0D47A1);' +
        'padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;transition:all .15s;}' +
        '.cestis-qbar-btn:hover{background:rgba(13,71,161,.08);}';
      document.head.appendChild(st);
    }

    el.classList.add('cestis-qbar');
    el.innerHTML =
      '<div class="cestis-qbar-fy">' +
        '<button class="cestis-qbar-btn" data-act="fy-1" title="Previous financial year">◀</button>' +
        '<span class="cestis-qbar-fylabel"></span>' +
        '<button class="cestis-qbar-btn" data-act="fy+1" title="Next financial year">▶</button>' +
      '</div>' +
      '<div class="cestis-qbar-tabs">' +
        Core.QUARTER_META.map(function (m) {
          return '<button class="cestis-qbar-tab" data-q="' + m.q + '">' + m.label + ' · ' + m.months + '</button>';
        }).join('') +
        '<button class="cestis-qbar-btn" data-act="q-1" style="margin-left:8px;">◀ Prev Qtr</button>' +
        '<button class="cestis-qbar-btn" data-act="q+1">Next Qtr ▶</button>' +
      '</div>';

    function shiftFY(fy, dir) {
      var start = parseInt(String(fy).split('/')[0], 10) + dir;
      return start + '/' + (start + 1);
    }
    function paint() {
      var cur = Core.getActiveQuarter();
      var lbl = el.querySelector('.cestis-qbar-fylabel');
      if (lbl) lbl.textContent = Core.fyLabel(cur.fy);
      var tabs = el.querySelectorAll('.cestis-qbar-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', parseInt(tabs[i].getAttribute('data-q'), 10) === cur.q);
      }
    }
    function go(fy, q) {
      // clamp quarter into 1..4, rolling the FY across year boundaries
      while (q < 1) { q += 4; fy = shiftFY(fy, -1); }
      while (q > 4) { q -= 4; fy = shiftFY(fy, 1); }
      Core.setActiveQuarter(fy, q);
    }
    // Hosts re-mount the bar on the SAME element every time their page is
    // re-visited (the attendance/cashbook/etc. pages just re-run their init).
    // Each mount used to stack another click listener on `el`, so after N visits
    // one Prev/Next click fired N times and jumped N quarters at once — making
    // quarter navigation look broken ("can't go to previous/next"). Tear down any
    // bar previously mounted on this element first so mounting is idempotent.
    if (typeof el._cestisQbarTeardown === 'function') { try { el._cestisQbarTeardown(); } catch (e) {} }

    function onBarClick(e) {
      var t = e.target.closest('[data-q],[data-act]');
      if (!t || !el.contains(t)) return;
      var cur = Core.getActiveQuarter();
      if (t.hasAttribute('data-q')) { go(cur.fy, parseInt(t.getAttribute('data-q'), 10)); return; }
      switch (t.getAttribute('data-act')) {
        case 'fy-1': go(shiftFY(cur.fy, -1), cur.q); break;
        case 'fy+1': go(shiftFY(cur.fy, 1), cur.q); break;
        case 'q-1': go(cur.fy, cur.q - 1); break;
        case 'q+1': go(cur.fy, cur.q + 1); break;
      }
    }
    el.addEventListener('click', onBarClick);

    var unsub = Core.onQuarterChange(function (cur) {
      paint();
      if (typeof opts.onChange === 'function') opts.onChange(cur);
    });
    paint();

    function teardown() {
      try { unsub(); } catch (e) {}
      el.removeEventListener('click', onBarClick);
      try { delete el._cestisQbarTeardown; } catch (e) { el._cestisQbarTeardown = null; }
    }
    el._cestisQbarTeardown = teardown;

    return {
      refresh: paint,
      destroy: function () { teardown(); el.innerHTML = ''; el.classList.remove('cestis-qbar'); }
    };
  };

  /* ============================== COURSE DURATION ============================
     Every training centre / course carries a start and end date. Course-scoped
     activity (the attendance register first and foremost, plus tests, fee entry,
     certification, etc.) is "open" only while the course is running — OR when an
     instructor has been granted a temporary, time-boxed reopen permission
     (half-day = 12h, full-day = 24h from the grant instant). When a course has
     ended, students who were never certified become Not-Yet-Competent (NYC).

     These helpers are PURE (dates/timestamps passed in, or defaulted to "now")
     so they are unit-testable without a browser and shared by every page.
     ------------------------------------------------------------------------- */
  var COURSE_DAY_MS = 24 * 60 * 60 * 1000;
  Core.courseDuration = (function () {
    function normDate(s) {
      return (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : '';
    }
    function todayStr(injected) {
      if (injected) return normDate(injected);
      var d = new Date();
      var mo = String(d.getMonth() + 1), da = String(d.getDate());
      return d.getFullYear() + '-' + (mo.length < 2 ? '0' + mo : mo) + '-' + (da.length < 2 ? '0' + da : da);
    }
    // 'no-dates' | 'not-started' | 'active' | 'ended'
    function status(startDate, endDate, today) {
      var t = todayStr(today), s = normDate(startDate), e = normDate(endDate);
      if (!s && !e) return 'no-dates';
      if (s && t < s) return 'not-started';
      if (e && t > e) return 'ended';
      return 'active';
    }
    // A course with no dates is treated as open (never blocks) until dates are set.
    function isActive(startDate, endDate, today) {
      var st = status(startDate, endDate, today);
      return st === 'active' || st === 'no-dates';
    }
    // Expiry timestamp (ms) for a freshly-granted reopen permission.
    function grantExpiry(nowMs, type) {
      return nowMs + (type === 'half' ? (COURSE_DAY_MS / 2) : COURSE_DAY_MS);
    }
    // Any unexpired instructor reopen permission? permissions: [{expiresAtMs}]
    function permissionActiveAt(permissions, nowMs) {
      if (!permissions || !permissions.length) return false;
      var now = (typeof nowMs === 'number') ? nowMs : Date.now();
      for (var i = 0; i < permissions.length; i++) {
        var p = permissions[i];
        if (p && typeof p.expiresAtMs === 'number' && p.expiresAtMs > now) return true;
      }
      return false;
    }
    // course = { startDate, endDate, instructorPermissions:[{expiresAtMs}] }
    function isRegisterOpen(course, today, nowMs) {
      if (!course) return true;
      if (isActive(course.startDate, course.endDate, today)) return true;
      return permissionActiveAt(course.instructorPermissions, nowMs);
    }
    // Drop permissions that have already expired (housekeeping before persist).
    function prunePermissions(permissions, nowMs) {
      if (!permissions || !permissions.length) return [];
      var now = (typeof nowMs === 'number') ? nowMs : Date.now();
      return permissions.filter(function (p) { return p && typeof p.expiresAtMs === 'number' && p.expiresAtMs > now; });
    }
    return {
      normDate: normDate, todayStr: todayStr, status: status, isActive: isActive,
      grantExpiry: grantExpiry, permissionActiveAt: permissionActiveAt,
      isRegisterOpen: isRegisterOpen, prunePermissions: prunePermissions
    };
  })();

  /* ==========================================================================
     TRANSCRIPT / GRADES ENGINE — shared logic for the Transcript & Grades
     system (admin editor, trainee live view, instructor view, PDF exports).

     WHY THIS EXISTS
     ---------------
     A trainee's final grade for a unit can come from two places:
       1. LIVE EXAMS taken on VocTrain (voctrain_examResults), matched to a
          catalogue unit by unit code / unit name appearing in the exam title.
       2. A MANUAL grade entered (or overridden) by Admin on the
          Transcript/Grades page (voctrain_transcriptGrades).
     A manual record always wins over a live exam score for the same unit.
     Every page (admin, trainee, instructor) must resolve grades identically,
     so the resolution logic lives here — pure and unit-testable in Node.

     STORAGE KEYS (all JSON in CESTISStore; snapshot-synced like the rest)
       voctrain_unitCatalogs          [{id,title,skillArea,level,centre,units:[{code,name,coreElective}]}]
       voctrain_transcriptGrades      [{id,studentId,qualId,unitCode,grade,date,source,examResultId,updatedBy,updatedAt}]
       voctrain_certTranscriptRequests[{id,studentId,studentName,course,type,note,status,requestedAt,handledBy,handledAt}]
       voctrain_transcriptProfiles    {studentId:{dob,address,idNo}}
     ========================================================================== */
  Core.Transcript = (function () {
    var T = {};

    T.KEYS = {
      catalogs: 'voctrain_unitCatalogs',
      grades: 'voctrain_transcriptGrades',
      requests: 'voctrain_certTranscriptRequests',
      profiles: 'voctrain_transcriptProfiles'
    };

    // Institution block rendered on the official transcript — matches the
    // approved paper transcript exactly. Do not restyle without approval.
    T.INSTITUTION = {
      nameLine1: 'Community Educational and Skills Training',
      nameLine2: 'Institute and Services Ltd.',
      centre: 'Hazard Skills Training Centre',
      addressLines: ['Mack Chem Complex', 'Paisley Avenue, May Pen', 'Clarendon, Jamaica'],
      email: 'hazardtrainingcentre@gmail.com',
      tel: '876-679-0111,876-365-2325'
    };

    T.REQUEST_TYPES = { transcript: 'Transcript', certificate: 'Certificate', both: 'Transcript & Certificate' };
    T.REQUEST_STATUSES = ['pending', 'processing', 'ready', 'collected', 'declined'];
    T.REQUEST_STATUS_LABELS = { pending: 'Pending', processing: 'Processing', ready: 'Ready for Collection', collected: 'Collected', declined: 'Declined' };

    /* --- The seeded unit catalogues ---------------------------------------
       BUSINESS ADMINISTRATION (MANAGEMENT) LEVEL 5 is seeded verbatim from the
       institution's approved transcript. The other programmes mirror the
       Qualification Plan page's skill areas; Admin fills their units in from
       the Transcript/Grades input section. */
    var BAM_L5_UNITS = [
      ['BSBBAD0553B', 'Plan and manage meetings'],
      ['BSBSBM0163A', 'Develop a business proposal'],
      ['BSBSBM0423A', 'Organize business finances'],
      ['FSFACC0033B', 'Prepare operational budget'],
      ['BSBSBM0143A', 'Apply advanced business communication skills'],
      ['BSBCOR0353B', 'Communicate information relating to work activities'],
      ['BSBMKP1053B', 'Seize a business opportunity'],
      ['BSBMKP0173B', 'Conduct research and prepare a marketing plan to achieve goals'],
      ['BSBMKP0913B', 'Manage business customers'],
      ['PSSCOR0063B', 'Monitor performance and provide feedback'],
      ['BSBBAD1273B', 'Lead and manage people'],
      ['PSSCOR0103B', 'Promote diversity'],
      ['PSSADM0264B', 'Provide leadership across the organization'],
      ['FSFACC0134B', 'Produce management reports to enable effective decision making'],
      ['BSBBAD0274B', 'Manage finances within a budget'],
      ['FSFADM0074B', 'Provide financial and business performance information'],
      ['PSSADM0204B', 'Manage policy implementation'],
      ['BSBSBM0024B', 'Research business opportunities'],
      ['BSBSBM0054C', 'Develop a business plan'],
      ['BSBSBM0354A', 'Protect and use intangible assets'],
      ['PSAHRD0224B', 'Develop and use emotional intelligence'],
      ['BSBIPR0014A', 'Comply with organizational requirements for protection and use of intellectual property'],
      ['BSBIPR0044A', 'Manage intellectual property to protect and grow business'],
      ['FSFACC0884A', 'Implement and maintain internal control procedures'],
      ['PSSADM0144B', 'Exercise delegations'],
      ['BSBLEG0014A', 'Apply the principles of contract law'],
      ['PSSCOR0114B', 'Conduct systems evaluations'],
      ['PSSCOR0124B', 'Use complex workplace communication strategies'],
      ['THHWPO0344B', 'Manage quality guest service'],
      ['PSSCOR0034B', 'Contribute to and manage the change processes'],
      ['BSBBAD1244B', 'Manage workplace (industrial) relations'],
      ['PSSCOR0164B', 'Represent and promote the organization'],
      ['PSSADM0175A', 'Develop partnering arrangements'],
      ['PSSCOR0145B', 'Prepare high-level-sensitive written materials'],
      ['PSSPAD0095B', 'Establish and maintain a strategic planning cycle'],
      ['PSSADM0165B', 'Manage innovation and continuous improvement'],
      ['BSBEBU0085B', 'Evaluate new technologies for business'],
      ['BSBFLM0035B', 'Manage effective workplace relationships'],
      ['BSBBAD1305B', 'Analyse and interpret workforce development trends'],
      ['BSBEBU0125B', 'Use online systems to support managerial decision- making'],
      ['BSBFLM0095B', 'Facilitate continuous improvement'],
      ['PSAHRD0185B', 'Formulate a human resource strategic plan'],
      ['BSBBAD1365B', 'Manage environmental risks'],
      ['BSBBAD1345B', 'Monitor and review strategic direction'],
      ['PSSADM0535B', 'Provide advice to executive team and stakeholders'],
      ['PSSPAD0065B', 'Evaluate an organization’s OHS performance'],
      ['PSSPAD0115B', 'Establish and maintain community, government and business partnerships'],
      ['PSSCOR0023B', 'Develop and implement work unit plan'],
      ['BSBSBM0313A', 'Lead and facilitate offsite staff'],
      ['BSBBAD0473B', 'Plan and manage conferences'],
      ['BSBBAD0793B', 'Promote the business'],
      ['BSBBAD0384B', 'Ensure sales and service delivery'],
      ['PSAHRD0214B', 'Manage performance'],
      ['THTCOT0204B', 'Manage projects'],
      ['BSBADM0034B', 'Develop and use complex spreadsheets'],
      ['FSFACC0294B', 'Report on financial activity'],
      ['BSBBAD1264B', 'Undertake compliance audits'],
      ['CSCSAD0014A', 'Provide community education projects'],
      ['BSBMKP0054B', 'Design and deliver a presentation'],
      ['PSSPAD0075B', 'Develop and implement organizational policies'],
      ['PSSPAD0105B', 'Plan organizational needs'],
      ['PSSADM0285B', 'Advise on organisation policy'],
      ['PSSAPM0065B', 'Negotiate strategic procurement'],
      ['PSSADM0245B', 'Obtain and manage consultancy services'],
      ['FSFADM0025B', 'Develop and monitor financial policy statements and operating procedures'],
      ['BSBFLM0135B', 'Manage budgets and financial plans within the work team'],
      ['PSAHRD0155B', 'Manage remuneration strategies and plans'],
      ['PSSADM0235B', 'Manage self as a board member'],
      ['CSEGCC0075A', 'Provide workplace mentoring'],
      ['PSSADM0215B', 'Manage a board meeting']
    ];

    // GENERAL BEAUTY THERAPY LEVEL 2 - NVQ-J CSB21424 - transcribed from the institution's qualification plan.
    var BT_L2_UNITS = [
      ['CSBBTH0122C', 'Design and apply facial make-up'],
      ['CSBBTH0052E', 'Perform facial treatment'],
      ['CSBBTH0062D', 'Provide lash and brow treatment'],
      ['CSBBTH0072D', 'Provide temporary epilation and bleaching treatments'],
      ['CSBBTH0132C', 'Provide paraffin wax treatment'],
      ['CSBBTH0032C', 'Apply nail art'],
      ['CSBBTH0092B', 'Apply acrylic nail enhancement'],
      ['CSBBTH0102B', 'Apply gel nail enhancement'],
      ['CSBBTH0002D', 'Provide manicure and pedicure service'],
      ['CSBBTH0202A', 'Acquire foundation knowledge of massage therapy'],
      ['CSBBTH0212A', 'Apply knowledge of the history of massage'],
      ['CRIOHS0022A', 'Provide advance first aid'],
      ['CSACMP0012B', 'Comply with infection prevention and control policies and procedures'],
      ['CRIHLT0042A', 'Protect self against communicable diseases in the workplace'],
      ['CSBCOS0032D', 'Sell products and services'],
      ['CSBCOS0042D', 'Conduct financial transactions'],
      ['CSBCOS0052D', 'Perform stock control procedures'],
      ['ITIDAT3552A', 'Perform advanced features of computer applications'],
      ['ITIWEB1012C', 'Use social media tools for collaboration and engagement'],
      ['CRICOM0022B', 'Communicate and interact effectively in the workplace'],
      ['CRICOM0012B', 'Apply language and communication skills'],
      ['CSBCOS0002D', 'Receive and direct clients'],
      ['CRICUS0012A', 'Provide quality customer/client service'],
      ['CSBCOS0012D', 'Schedule and check out clients'],
      ['BSBCOR0382D', 'Display human relations skills'],
      ['BSBSBM0012E', 'Craft personal entrepreneurial strategy'],
      ['CSWCOR0052B', 'Reflect on and improve own professional practice'],
      ['CRIMAT0012B', 'Perform mathematical computations'],
      ['CSBBAR0042D', 'Perform face shave', 'Elective'],
      ['THHFRO0032B', 'Develop and apply conversational skills in a foreign language', 'Elective'],
      ['CSBCOS0202C', 'Perform hair styling services', 'Elective']
    ];

    // COSMETOLOGY LEVEL 2 - NVQ-J CSB21323 - transcribed from the institution's qualification plan.
    var COS_L2_UNITS = [
      ['CSBCOR0021D', 'Plan and organize work'],
      ['CSBCOS0001E', 'Prepare clients for salon service'],
      ['CSBCOS0031C', 'Perform shampooing and conditioning services'],
      ['CSBHDR0011C', 'Perform head, neck and shoulder massage'],
      ['CSBCOS0021C', 'Perform wet hair styling and roller placement'],
      ['CSBCOR0011D', 'Maintain a safe, clean and efficient work environment'],
      ['CSBCOS0011D', 'Perform temporary hair colour services'],
      ['CSBCOS0041B', 'Perform basic hair and scalp treatments'],
      ['CSBBTH0001B', 'Provide basic manicure and pedicure service'],
      ['CSBBTH0112B', 'Apply knowledge of nail science to nail services'],
      ['CSBBTH0002D', 'Provide manicure and pedicure service'],
      ['CSBBTH0132C', 'Provide paraffin wax treatment'],
      ['CSBBTH0032C', 'Apply nail art'],
      ['CSBBTH0052E', 'Perform facial treatment'],
      ['CSBBTH0122C', 'Design and apply facial make-up'],
      ['CSBBAR0042D', 'Perform face shave'],
      ['CSBBTH0062D', 'Provide lash and brow treatment'],
      ['CSBBTH0072D', 'Provide temporary epilation and bleaching treatments'],
      ['CSBCOS0072C', 'Consult with clients and diagnose hair and scalp conditions'],
      ['CSBCOS0242A', 'Utilise sensory skills in beauty service for optimal client experience'],
      ['CSBCOS0162C', 'Perform chemical straightening services'],
      ['CSBCOS0172C', 'Perform permanent wave services'],
      ['CSBCOS0192C', 'Provide permanent hair colour services'],
      ['CSBCOS0102D', 'Perform semi-permanent hair colour services'],
      ['CSBCOS0022C', 'Perform hair shaping'],
      ['CSBCOS0132C', 'Maintain wigs and hair pieces'],
      ['CSBCOS0142C', 'Perform thermal straightening, curling and waving'],
      ['CSBCOS0182C', 'Perform hair braiding services'],
      ['CSBCOS0202C', 'Perform hair styling services'],
      ['CSBBTH0082C', 'Provide advice on retail beauty care products'],
      ['CRICOM0012B', 'Apply language and communication skills'],
      ['BMFCRT0182B', 'Collaborate in a creative process'],
      ['BSSCRE0322C', 'Contribute to effective workplace relationships'],
      ['CRICUS0012A', 'Provide quality customer/client service'],
      ['CSBCOS0002D', 'Receive and direct clients'],
      ['CSBCOS0012D', 'Schedule and check out clients'],
      ['CSBCOS0032D', 'Sell products and services'],
      ['CRIMAT0012B', 'Perform mathematical computations'],
      ['CSBCOS0042D', 'Conduct financial transactions'],
      ['BSBMKP0192C', 'Undertake research and analysis'],
      ['BSBSBM0012E', 'Craft personal entrepreneurial strategy'],
      ['CSBCOS0052D', 'Perform stock control procedures'],
      ['BSBSBM0872B', 'Comply with regulatory and taxation requirements'],
      ['BSBBAD0372E', 'Manage time'],
      ['BMFCUL0072B', 'Exercise professionalism and ethical behaviour'],
      ['ITIDAT0212D', 'Use advanced features of computer applications'],
      ['ITIWEB1012C', 'Use social media tools for collaboration and engagement'],
      ['CSBBAR0022D', 'Perform hair shaping on excessively curly hair', 'Elective'],
      ['LMFIND0112B', 'Research interior decoration and design influences', 'Elective'],
      ['THHFRO0032B', 'Develop and apply conversational skills in a foreign language', 'Elective']
    ];

    // ELECTRICAL INSTALLATION AND MAINTENANCE LEVEL 2 - NVQ-J EEM20723 - transcribed from the institution's qualification plan.
    var EIM_L2_UNITS = [
      ['MEMCOR0141D', 'Follow principles of Occupational Health and Safety (OH&S) in work environment'],
      ['EEMELS0011B', 'Apply basic electrical safety'],
      ['EEMINS0011B', 'Use and maintain hand and power tools for electrical work'],
      ['MEMCOR0171D', 'Use and maintain graduated measuring devices'],
      ['MEMCOR0081E', 'Use marking out tools'],
      ['MEMCOR0161D', 'Plan to undertake a routine task'],
      ['EEMTEC0011B', 'Apply principles and practices in electrical installation'],
      ['MEMCOR0071E', 'Use electrical/electronic measuring devices'],
      ['MEMCOR0091D', 'Draw and interpret sketches and simple drawings'],
      ['MEMINS0071D', 'Prepare for electrical conduits/wiring installation'],
      ['EEMEDR0011B', 'Interpret and draw standard electrical drawings'],
      ['MEMINS0011E', 'Install, terminate and connect electrical wiring systems'],
      ['MEMFAB0011D', 'Perform manual soldering/de-soldering of electrical/electronic components'],
      ['MEMMRD0091D', 'Terminate basic signal and data cables'],
      ['MEMINS0051D', 'Cut, bend and install electrical conduits'],
      ['MEMINS0162C', 'Cut, fit and install trunking system'],
      ['MEMINS0172C', 'Prepare and install basic cable trays'],
      ['MEMINS0062D', 'Terminate and connect specialist cables'],
      ['MEMCOR0012C', 'Plan a complete work activity'],
      ['MEMINS0262D', 'Install distribution panels, metering sockets, terminal mains and meter earthing systems'],
      ['EEMINS0022B', 'Perform basic testing and inspection on electrical installations'],
      ['EEMMRD0022B', 'Dismantle and reassemble electromechanical components'],
      ['EEMMRD0012B', 'Troubleshoot and repair basic electrical/electronic apparatus'],
      ['MEMCOR0132C', 'Use industrial instrumentation measuring devices'],
      ['EEMEDR0012B', 'Use electrical software to draw simple circuits'],
      ['EEMINS0012B', 'Interpret electrical standard, specifications and manuals'],
      ['MEMMRD0072E', 'Shut down/isolate machines/equipment'],
      ['MEMINS0092D', 'Install electrical and electronic apparatus, machinery, fixtures and secondary wiring'],
      ['MEMMRD0182E', 'Locate and repair/rectify electrical circuits'],
      ['CRICOM0012B', 'Apply language and communication skills'],
      ['MEMCOR0122D', 'Write basic technical reports'],
      ['THTCOR0082C', 'Provide quality customer service'],
      ['CRIMAT0012B', 'Perform mathematical computations'],
      ['MEMCOR0152C', 'Use graphical techniques and perform simple statistical computations (Basic)'],
      ['BMFCUL0072B', 'Exercise professionalism and ethical behaviour'],
      ['BSBSBM0012E', 'Craft personal entrepreneurial strategy'],
      ['BSBMKP0342D', 'Prepare quotations'],
      ['MEMMAH0042D', 'Order materials'],
      ['ITIDAT0212D', 'Use advanced features of computer applications'],
      ['ITIWEB1012C', 'Use social media tools for collaboration and engagement'],
      ['EETOPT0092A', 'Develop an understanding of concepts and application of optoelectronics technology', 'Elective'],
      ['EETOPT0112A', 'Install LED technology signs', 'Elective'],
      ['EETOPT0152A', 'Apply the fibre optic technology', 'Elective']
    ];

    // ELECTRICAL INSTALLATION AND MAINTENANCE LEVEL 3 - NVQ MEM32507 - transcribed from the institution's qualification plan.
    var EIM_L3_UNITS = [
      ['MEMCOR0051A', 'Perform related computations – basic'],
      ['MEMCOR0071A', 'Use electrical/electronic measuring devices'],
      ['MEMCOR0081A', 'Mark off/out (general engineering)'],
      ['MEMCOR0091A', 'Draw and interpret sketches and simple drawings'],
      ['MEMCOR0111A', 'Use power tools'],
      ['MEMCOR0131A', 'Undertake interactive workplace communication'],
      ['MEMCOR0141A', 'Follow principles of Occupational Health and Safety (OH&S) in work environment'],
      ['MEMCOR0161A', 'Plan to undertake a routine task'],
      ['MEMCOR0171A', 'Use graduated measuring devices'],
      ['MEMCOR0191A', 'Use hand tools'],
      ['MEMMAH0071A', 'Perform manual handling and lifting'],
      ['MEMMAH0081A', 'Perform housekeeping duties'],
      ['MEMFAB0011A', 'Perform manual soldering/de-soldering – electrical/electronic components'],
      ['MEMINS0011A', 'Install terminate and connect electrical wiring'],
      ['MEMINS0051A', 'Cut bend and install electrical conduits'],
      ['MEMINS0071A', 'Prepare for electrical conduits/wiring installation'],
      ['MEMMRD0091A', 'Terminate signal and data cables – (basic)'],
      ['MEMMRD0121A', 'Perform basic repair to electrical/electronic apparatus'],
      ['MEMMRD0161A', 'Disconnect and reconnect fixed wired electrical machinery appliance and fixtures'],
      ['MEMMRD0181A', 'Attach flexible cables & plugs to electrical machinery appliance and fixtures'],
      ['MEMCOR0012A', 'Plan a complete activity'],
      ['MEMCOR0022A', 'Perform related computations'],
      ['MEMCOR0042A', 'Interpret standard specifications and manuals'],
      ['MEMCOR0052A', 'Operate in an autonomous team environment'],
      ['MEMCOR0122A', 'Write technical reports (basic)'],
      ['MEMINS0062A', 'Terminate and connect specialist cables'],
      ['MEMINS0092A', 'Install electrical/electronic machinery appliances, fixtures'],
      ['MEMINS0162A', 'Cut fit and install trunking system'],
      ['MEMINS0172A', 'Prepare and install cable trays - basic'],
      ['MEMINS0262A', 'Install distribution panels, metering sockets, terminal mains and meter earthing systems'],
      ['MEMMRD0072A', 'Shut down/isolate machines/equipment'],
      ['MEMMRD0182A', 'Fault find and repair/rectify basic electrical circuits and secondary wiring'],
      ['MEMMRD0402A', 'Check/identify/isolate/rectify malfunctioning electrical machinery appliances and fixtures'],
      ['MEMMRD0872A', 'Install and maintain electrical equipment'],
      ['MEMMRD0892A', 'Install and maintain electronic electrical equipment and distribution circuits'],
      ['MEMQUA0012A', 'Perform inspection (basic)'],
      ['MEMMAH0073A', 'Purchase materials'],
      ['MEMPLN0063A', 'Coordinate and manage basic installation projects'],
      ['MEMPLN0113A', 'Plan for wiring and installation of electrical/electronic machinery appliances and fixtures'],
      ['MEMCOM0023A', 'Perform internal and external customer service'],
      ['MEMCOR0093A', 'Plan and organize work'],
      ['MEMCOR0103A', 'Maintain quality systems within a team'],
      ['BSBFLM0023A', 'Support leadership in the workplace'],
      ['MEMMRD0423A', 'Diagnose and repair faults in electrical and electronic systems'],
      ['MEMMRD0663A', 'Perform testing and inspection of electrical installations'],
      ['MEMMRD0673A', 'Coordinate the installation of electrical wiring support system infrastructure'],
      ['MEMMRD0683A', 'Coordinate the installation of electrical cable and fixture'],
      ['MEMMRD0693A', 'Coordinate the installation of electrical equipment, ancillary apparatus and secondary wiring'],
      ['MEMCOR0101A', 'Prepare basic engineering drawing', 'Elective'],
      ['MEMCOR0121A', 'Classify engineering materials – (basic)', 'Elective'],
      ['ITICOR0011A', 'Carry out data entry and retrieval procedures', 'Elective'],
      ['MEMMRD0191A', 'Assemble & disassemble scaffolding to enable access to the work area', 'Elective'],
      ['BSBSBM0012A', 'Craft personal entrepreneurial strategy', 'Elective'],
      ['MEMMAH0042A', 'Order materials', 'Elective'],
      ['MEMINS0122A', 'Install below ground communication cables', 'Elective'],
      ['MEMCOR0132A', 'Use Industrial Instrumentation measuring devices', 'Elective'],
      ['MEMCOR0063A', 'Attend to breakdown in hazardous area', 'Elective'],
      ['MEMCOR0013A', 'Assist in the provision of on the job training', 'Elective'],
      ['MEMMRD0703A', 'Coordinate the installation of substation plant and apparatus', 'Elective'],
      ['MEMMRD0443A', 'Diagnose & repair faults in electrical equipment', 'Elective'],
      ['BSBFLM0053A', 'Support operational plan', 'Elective'],
      ['BSBFLM0093A', 'Support continuous improvement systems and processes', 'Elective'],
      ['MEMPLN0034A', 'Coordinate and manage commissioning processes', 'Elective'],
      ['MEMPLN0094A', 'Determine and plan for electrical installation requirements', 'Elective'],
      ['MEMPLN0104A', 'Interpret and carry out electrical design', 'Elective'],
      ['MEMPLN0114A', 'Evaluate electrical installation', 'Elective'],
      ['MEMPLN0124A', 'Perform testing on complex electrical installation', 'Elective']
    ];

    // HOSPITALITY VILLA/PROPERTIES SERVICES LEVEL 2 - NVQ-J THH22522 - transcribed from the institution's qualification plan.
    var HVP_L2_UNITS = [
      ['THHHOK1211D', 'Clean public areas'],
      ['THHHOK0911D', 'Clean floors, walls, furniture and furnishings'],
      ['THHHOK1181D', 'Clean and maintain soft floor and furnishings'],
      ['THHHOK0921D', 'Prepare guests rooms'],
      ['THHHOK1151D', 'Prepare offices'],
      ['THHHOK0931D', 'Provide laundry service'],
      ['THHGAD0141D', 'Receive and store stock'],
      ['THHFAB0151D', 'Prepare and serve non-alcoholic beverages'],
      ['THHFRO0101D', 'Develop and apply conversational skills in a foreign language'],
      ['THHFRO0141D', 'Carry out rooming procedures'],
      ['THHFRO0091C', 'Provide bell services'],
      ['THHHOK0901C', 'Respond to guest related complaints and requests'],
      ['THHCFP0261E', 'Prepare dishes using basic methods of cookery'],
      ['THHCFP0281D', 'Prepare and present sandwiches'],
      ['THHCFP0321D', 'Prepare and cook poultry dishes'],
      ['THHCFP0331D', 'Prepare and cook meat and seafood'],
      ['THHCFP0651D', 'Prepare vegetables, fruits, eggs and farinaceous dishes'],
      ['THHCFP0271D', 'Prepare and present appetizers and salads'],
      ['THHCFP0251D', 'Clean kitchen premises and equipment'],
      ['THHCFP1031B', 'Use knives for basic task in the kitchen environment'],
      ['THHCFP0671C', 'Prepare stocks, sauces and soups'],
      ['THHCFP0231D', 'Organize, prepare and present simple dishes'],
      ['THHFAB0101D', 'Provide food and beverage service'],
      ['THHHOK1411B', 'Develop and apply principles of professional codes of conduct & ethics'],
      ['THHCOR0011C', 'Work with colleagues and customers'],
      ['THHCOR0031D', 'Develop and update hospitality industry/job knowledge'],
      ['THTTEJ0011D', 'Apply knowledge of Team Jamaica requirements in the workplace'],
      ['CRIDIV0021A', 'Operate in a culturally diverse work environment'],
      ['CRIWHS0061A', 'Apply environmentally sustainable work practices'],
      ['ITCMOB0111B', 'Use mobile IT devices'],
      ['ITICOR0011E', 'Perform basic computer applications'],
      ['ITCWEB0161B', 'Participate in online networks and social media'],
      ['THHFRO0112C', 'Facilitate access to external services'],
      ['THHFRO0152C', 'Provide customized guests services'],
      ['THHHOK1192C', 'Provide linen room services'],
      ['THHFRO0132C', 'Maintain guests\' accounts'],
      ['THHFRO0012C', 'Receive and process reservations'],
      ['THHFRO0022D', 'Provide accommodation reception services'],
      ['THHGFA0042D', 'Process cash and non-cash transactions'],
      ['THHHOK1142D', 'Repair and recycle linen'],
      ['THHFRO0162C', 'Prepare customer accounts and deal with departures'],
      ['THHGCS0222D', 'Promote and up-sell products and services'],
      ['THHPAT0542C', 'Prepare and produce cakes and puddings products'],
      ['THHPAT0532C', 'Prepare and produce pastries'],
      ['THHPAT0552C', 'Prepare and produce yeast goods'],
      ['THHPAT0772D', 'Prepare and present desserts'],
      ['CRIOHS0012A', 'Comply with the occupational health and safety, security and hygiene practices'],
      ['THHCFP1262A', 'Comply with the relevant legislative and regulatory requirements in hospitality'],
      ['BSBSBM0012E', 'Craft personal entrepreneurial strategy'],
      ['CSEJOB0692A', 'Develop an understanding of business operations'],
      ['CSEJOB0362A', 'Use strategies to identify job opportunities'],
      ['CRICOM0012B', 'Apply language and communication skills'],
      ['CRIMAT0022B', 'Perform mathematical computation'],
      ['BSBBAD0362E', 'Manage personal stress in the workplace'],
      ['CSEJOB0382A', 'Respond to familiar workplace problems'],
      ['CSEJOB0682A', 'Apply the principles of customer service'],
      ['BSBWKR0012A', 'Plan and apply time management strategies'],
      ['CSEJOB0372A', 'Enhance self-management skills for work'],
      ['THHHOK1322B', 'Maintain housekeeping supplies', 'Elective'],
      ['THHHOK1342B', 'Administer the current records systems', 'Elective'],
      ['THHHOK1352B', 'Maintain store security and cleanliness', 'Elective']
    ];

    // WELDING LEVEL 2 - NVQ-J MEM22423 - transcribed from the institution's qualification plan.
    var WEL_L2_UNITS = [
      ['MEMCOR0141D', 'Follow principles of Occupational Health and Safety (OH&S) in work environment'],
      ['MEMCOR0171D', 'Use and maintain graduated measuring devices'],
      ['BCGCOR0051D', 'Use hand and power tools'],
      ['MEMMPO0081C', 'Use workshop machines for basic operations'],
      ['MEMCOR0091D', 'Draw and interpret sketches and simple drawings'],
      ['MEMFAB0141C', 'Develop basic geometric shapes'],
      ['MEMCOR0101C', 'Prepare basic engineering drawing'],
      ['MEMFAB0051D', 'Perform brazing and/or silver soldering'],
      ['MEMFAB0111C', 'Perform basic welding using manual metal arc welding process (MMAW)'],
      ['MEMFAB0121C', 'Perform basic welding using oxyacetylene welding process (OAW) - fuel gas welding'],
      ['MEMFAB0151C', 'Prepare for oxyacetylene/metal arc welding processes'],
      ['MEMFAB0041C', 'Carry out mechanical cutting operations – (basic)'],
      ['MEMCOR0081E', 'Use marking out tools'],
      ['MEMCOR0121D', 'Classify engineering materials (basic)'],
      ['MEMFAB0081C', 'Assemble fabricated components'],
      ['MEMFAB0061C', 'Perform manual heating, and thermal cutting'],
      ['MEMFAB0071C', 'Undertake fabrication, forming, bending and shaping'],
      ['ITCMOB0111B', 'Use mobile IT devices'],
      ['ITICOR0011E', 'Perform basic computer applications'],
      ['ITCWEB0161B', 'Participate in online networks and social media'],
      ['MEMDDD0042C', 'Prepare basic mechanical drawings'],
      ['EEMCAD0012A', 'Operate computer aided design (CAD) to produce basic drawing elements'],
      ['MEMFAB0042C', 'Perform weld in the flat and horizontal positions using manual metal arc welding process (MMAW)'],
      ['MEMFAB0072C', 'Perform advanced welding using oxyacetylene welding process (OAW)'],
      ['MEMCOR0092C', 'Mark off/out structural fabrication and shapes'],
      ['MEMFAB0022C', 'Perform advanced manual thermal cutting, gouging and shaping'],
      ['CSAPQA0012A', 'Apply quality standards and procedures'],
      ['MEMFAB0052C', 'Weld using gas metal arc welding process (GMAW) – metal inert gas (MIG)'],
      ['MEMCOR0012D', 'Plan a complete work activity'],
      ['MEMFAB0142C', 'Perform weld in flat and horizontal positions using flux cored arc welding process (FCAW)'],
      ['MEMFAB0062C', 'Perform weld in flat and horizontal positions using gas tungsten metal arc welding process (GTAW) - (Tungsten inert gas - TIG)'],
      ['CRICOM0012B', 'Apply language and communication skills'],
      ['MEMCOR0122D', 'Write basic technical reports'],
      ['THTCOR0082C', 'Provide quality customer service'],
      ['BMFCUL0072B', 'Exercise professionalism and ethical behaviour'],
      ['BSBSBM0012E', 'Craft personal entrepreneurial strategy'],
      ['BSBMKP0342D', 'Prepare quotations'],
      ['MEMMAH0042D', 'Order materials'],
      ['CRIMAT0012B', 'Perform mathematical computations'],
      ['BSBCOR0382D', 'Display human relations skills'],
      ['BSBBAD0362F', 'Manage personal stress in the workplace'],
      ['BSBWKR0012A', 'Plan and apply time management strategies'],
      ['MEMCOR0042C', 'Interpret standard specifications and manuals'],
      ['MEMPRG0012A', 'Apply introductory machine programming techniques', 'Elective'],
      ['MEMMRD0062C', 'Perform levelling and alignment of machines and engineering components', 'Elective'],
      ['MEMMPO0072B', 'Perform machining operations using horizontal and/or vertical boring machines', 'Elective']
    ];

    // WELDING LEVEL 3 - NVQ MEM30215 - transcribed from the institution's qualification plan.
    var WEL_L3_UNITS = [
      ['MEMCOR0131B', 'Undertake interactive workplace communication'],
      ['MEMCOR0141B', 'Follow principles of Occupational Health and Safety (OH&S) in work environment'],
      ['ITICOR0011B', 'Carry out data entry and retrieval procedures'],
      ['MEMCOR0161B', 'Plan to undertake a routine task'],
      ['MEMCOR0171B', 'Use and maintain graduated measuring devices'],
      ['MEMCOR0191B', 'Use hand tools'],
      ['MEMCOR0051B', 'Perform related computations – (basic)'],
      ['MEMCOR0081B', 'Mark off/out (general engineering)'],
      ['MEMCOR0091B', 'Draw and interpret sketch and simple drawing'],
      ['MEMCOR0111B', 'Use and care power tools'],
      ['MEMCOR0121B', 'Classify engineering materials – (basic)'],
      ['MEMFAB0041B', 'Carry out mechanical cutting operations - (basic)'],
      ['MEMFAB0141B', 'Develop geometric shapes (basic)'],
      ['MEMFAB0151B', 'Prepare for oxyacetylene/metal arc welding processes'],
      ['MEMFAB0051B', 'Perform brazing and/or silver soldering'],
      ['MEMFAB0061B', 'Perform manual heating and thermal cutting'],
      ['MEMFAB0071B', 'Undertake fabrication, forming, bending and shaping – (basic)'],
      ['MEMFAB0081B', 'Assemble fabricated components-(basic)'],
      ['MEMFAB0111B', 'Perform basic welding using manual metal arc welding process (MMAW)'],
      ['MEMFAB0121B', 'Perform basic welding using oxyacetylene welding process (OAW) - Fuel Gas Welding'],
      ['MEMMAH0071B', 'Perform manual handling and lifting'],
      ['MEMMAH0081B', 'Perform housekeeping duties'],
      ['MEMCOR0012B', 'Plan a complete activity'],
      ['MEMCOR0022B', 'Perform related computations'],
      ['MEMCOR0042B', 'Interpret standard specifications and manuals'],
      ['MEMCOR0052B', 'Operate in an autonomous team environment'],
      ['MEMCOR0122C', 'Write technical reports (basic)'],
      ['MEMFAB0022B', 'Perform advanced manual thermal cutting, gouging and shaping'],
      ['MEMFAB0042B', 'Perform advanced welding using manual metal arc welding process (MMAW)'],
      ['MEMFAB0052B', 'Weld using gas metal arc welding process GMAW - (Metal inert gas MIG)'],
      ['MEMFAB0062B', 'Weld using gas tungsten metal arc welding process GTAW - (Tungsten inert gas -TIG)'],
      ['MEMFAB0072B', 'Perform advanced welding using oxyacetylene welding process (OAW)'],
      ['MEMCOR0023C', 'Write technical reports (advanced)'],
      ['MEMCOR0093B', 'Plan and organise work'],
      ['MEMCOR0103C', 'Maintain quality systems within a team'],
      ['MEMCOR0113B', 'Coordinate team activities'],
      ['MEMFAB0023B', 'Perform advanced welding using gas metal arc welding process GMAW -(Metal inert gas MIG)'],
      ['MEMFAB0033B', 'Perform advanced welding using gas tungsten arc welding process (GTAW) –Tungsten inert Gas (TIG)'],
      ['MEMFAB0113B', 'Perform manual metal arc welding process to AWS specification (Alloy steel pipe)'],
      ['MEMCOR0083B', 'Estimate projects'],
      ['BSBFLM0053B', 'Support operational plan'],
      ['MEMCOR0101B', 'Prepare basic engineering drawing', 'Elective'],
      ['MEMSUF0061B', 'Prepare for the application of protective coating', 'Elective'],
      ['MEMMRD0191B', 'Assemble & disassemble scaffolding to enable access to the work area', 'Elective'],
      ['MEMFAB0131B', 'Repair/replace/modify fabrications (basic)', 'Elective'],
      ['MEMQUA0012B', 'Perform inspection - (basic)', 'Elective'],
      ['MEMMAH0042B', 'Order materials', 'Elective'],
      ['MEMCOR0062B', 'Attend to breakdown', 'Elective'],
      ['MEMCOR0092B', 'Mark off/out structural fabrications and shapes', 'Elective'],
      ['BSBSBM0012C', 'Craft personal entrepreneurial strategy', 'Elective'],
      ['MEMFAB0102B', 'Perform manual metal arc welding process to AWS specification (Low carbon steel sheet)', 'Elective'],
      ['MEMFAB0112B', 'Perform manual metal arc welding process to AWS specification (Low carbon steel pipe)', 'Elective'],
      ['MEMFAB0122B', 'Perform oxyacetylene welding process (fuel gas) to AWS specification', 'Elective'],
      ['MEMFAB0142B', 'Weld using flux cored arc welding process to FCAW', 'Elective'],
      ['MEMFAB0013B', 'Monitor quality of production welding/fabrication', 'Elective'],
      ['MEMFAB0043B', 'Weld using submerged arc welding process', 'Elective'],
      ['MEMFAB0053B', 'Perform welding supervision', 'Elective'],
      ['MEMFAB0063B', 'Perform welding/ fabrication inspection', 'Elective'],
      ['MEMFAB0103B', 'Perform manual metal arc welding to weld to AWS specification (Alloy steel plate)', 'Elective'],
      ['MEMFAB0123B', 'Perform gas tungsten arc welding process to AWS specification.(Plate)', 'Elective'],
      ['MEMFAB0133B', 'Perform gas tungsten arc welding process to AWS specification (Pipe)', 'Elective'],
      ['MEMFAB0143B', 'Perform gas metal arc welding process to AWS specification (Pipe and plate)', 'Elective'],
      ['MEMFAB0153B', 'Perform submerged arc welding to AWS specification', 'Elective'],
      ['MEMFAB0193B', 'Perform advanced welding using flux cored arc welding process - FCAW', 'Elective'],
      ['MEMMAH0073B', 'Purchase materials', 'Elective'],
      ['MEMCOR0013B', 'Assist in the provision of on the job training', 'Elective'],
      ['MEMCOM0023B', 'Perform internal and external customer service', 'Elective'],
      ['MEMPLN0063B', 'Coordinate and manage basic installation projects', 'Elective'],
      ['MEMMAH0093B', 'Coordinate materials', 'Elective'],
      ['MEMCOR0063B', 'Attend to break downs in hazardous areas', 'Elective'],
      ['BSBFLM0093B', 'Support continuous improvement systems and processes', 'Elective']
    ];

    function seedQual(id, title, skillArea, level, nvqCode, units) {
      return {
        id: id, title: title, skillArea: skillArea, level: level,
        nvqCode: nvqCode || '',
        centre: T.INSTITUTION.centre,
        units: (units || []).map(function (u) { return { code: u[0], name: u[1], coreElective: u[2] || 'Core' }; }),
        seeded: true
      };
    }

    T.seedCatalogs = function () {
      return [
        seedQual('QUAL-BAM-L5', 'BUSINESS ADMINISTRATION (MANAGEMENT) LEVEL 5', 'Business Administration', 5, '', BAM_L5_UNITS),
        seedQual('QUAL-BT-L2',  'GENERAL BEAUTY THERAPY LEVEL 2', 'Beauty Therapy', 2, 'CSB21424', BT_L2_UNITS),
        seedQual('QUAL-COS-L2', 'COSMETOLOGY LEVEL 2', 'Cosmetology', 2, 'CSB21323', COS_L2_UNITS),
        seedQual('QUAL-EIM-L2', 'ELECTRICAL INSTALLATION AND MAINTENANCE LEVEL 2', 'Electrical Installation', 2, 'EEM20723', EIM_L2_UNITS),
        seedQual('QUAL-EIM-L3', 'ELECTRICAL INSTALLATION AND MAINTENANCE LEVEL 3', 'Electrical Installation', 3, 'MEM32507', EIM_L3_UNITS),
        seedQual('QUAL-HVP-L2', 'HOSPITALITY VILLA/PROPERTIES SERVICES LEVEL 2', 'Hospitality & Tourism', 2, 'THH22522', HVP_L2_UNITS),
        seedQual('QUAL-WEL-L2', 'WELDING LEVEL 2', 'Welding & Fabrication', 2, 'MEM22423', WEL_L2_UNITS),
        seedQual('QUAL-WEL-L3', 'WELDING LEVEL 3', 'Welding & Fabrication', 3, 'MEM30215', WEL_L3_UNITS)
      ];
    };

    // Merge freshly-seeded catalogues into a stored list without disturbing
    // admin edits. Two cases, both idempotent:
    //   1. A qual id absent from the store is appended.
    //   2. A stored scaffold that is still PRISTINE (seeded, never edited,
    //      zero units) is replaced by the current seed — this is how stores
    //      that persisted an empty placeholder receive the real unit list
    //      when a qualification plan is later transcribed into the seeds.
    // The moment an admin saves a catalogue (updatedAt set), their version
    // wins forever.
    T.ensureSeeded = function (catalogs) {
      var list = Array.isArray(catalogs) ? catalogs.slice() : [];
      var idxById = {};
      list.forEach(function (q, i) { if (q && q.id) idxById[q.id] = i; });
      T.seedCatalogs().forEach(function (seed) {
        var i = idxById[seed.id];
        if (i === undefined) { list.push(seed); return; }
        var cur = list[i];
        if (cur && cur.seeded && !cur.updatedAt && (!cur.units || !cur.units.length) && seed.units.length) {
          list[i] = seed;
        }
      });
      return list;
    };

    /* --- Normalisation / formatting ---------------------------------------- */
    T.normText = function (s) {
      return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    };

    // "90.5" / 90.5 / "90.50" -> "90.5%"; 90 -> "90%"; non-numeric passes through.
    T.formatGrade = function (v) {
      if (v == null || v === '') return '';
      var n = Number(v);
      if (isNaN(n)) return String(v);
      var s = String(Math.round(n * 10) / 10);
      return s + '%';
    };

    // ISO / Date-parseable string -> DD/MM/YYYY (the transcript's date format).
    T.formatDateDMY = function (iso) {
      if (!iso) return '';
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(iso))) return String(iso);
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      var da = String(d.getDate()), mo = String(d.getMonth() + 1);
      return (da.length < 2 ? '0' + da : da) + '/' + (mo.length < 2 ? '0' + mo : mo) + '/' + d.getFullYear();
    };

    /* --- Live-exam matching -------------------------------------------------
       An exam counts towards a unit when its title carries the unit code, or
       its title is (or contains / is contained by) the unit name. Length
       guards stop trivially-short names from matching everything. */
    T.examMatchesUnit = function (exam, unit) {
      if (!exam || !unit) return false;
      var title = T.normText(exam.title);
      if (!title) return false;
      var code = T.normText(unit.code);
      if (code && title.indexOf(code) !== -1) return true;
      var name = T.normText(unit.name);
      if (!name) return false;
      if (title === name) return true;
      if (name.length >= 12 && title.indexOf(name) !== -1) return true;
      if (title.length >= 12 && name.indexOf(title) !== -1) return true;
      return false;
    };

    // Latest submitted exam result for one student+unit. exams/examResults are
    // the app's canonical arrays. Returns null when the unit has no live score.
    T.latestExamResultForUnit = function (unit, studentId, exams, examResults) {
      if (!unit || !studentId) return null;
      var examsById = {};
      (exams || []).forEach(function (e) { if (e && e.id) examsById[e.id] = e; });
      var best = null, bestTime = -1;
      (examResults || []).forEach(function (r) {
        if (!r || r.studentId !== studentId) return;
        var exam = examsById[r.examId];
        if (!exam || !T.examMatchesUnit(exam, unit)) return;
        var t = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
        if (isNaN(t)) t = 0;
        if (t >= bestTime) { bestTime = t; best = r; }
      });
      return best;
    };

    /* --- THE RESOLUTION ALGORITHM -------------------------------------------
       One row per catalogue unit: manual grade wins, else latest live exam
       score, else ungraded. Every page renders from this so admin, trainee
       and instructor always see the same grades. */
    T.effectiveGrades = function (opts) {
      opts = opts || {};
      var qual = opts.qual, studentId = opts.studentId;
      if (!qual || !Array.isArray(qual.units)) return [];
      var manual = {};
      (opts.manualGrades || []).forEach(function (g) {
        if (g && g.studentId === studentId && g.qualId === qual.id && g.unitCode) {
          manual[g.unitCode] = g;
        }
      });
      return qual.units.map(function (u) {
        var row = {
          code: u.code, name: u.name, coreElective: u.coreElective || 'Core',
          grade: null, date: '', source: 'none', examResultId: null, examTitle: ''
        };
        var m = manual[u.code];
        if (m && m.grade !== '' && m.grade != null) {
          row.grade = m.grade;
          row.date = m.date || '';
          row.source = 'manual';
          row.examResultId = m.examResultId || null;
          return row;
        }
        var res = T.latestExamResultForUnit(u, studentId, opts.exams, opts.examResults);
        if (res) {
          row.grade = res.score;
          row.date = T.formatDateDMY(res.submittedAt);
          row.source = 'exam';
          row.examResultId = res.id;
          var exam = (opts.exams || []).filter(function (e) { return e && e.id === res.examId; })[0];
          row.examTitle = exam ? exam.title : '';
        }
        return row;
      });
    };

    T.gradeStats = function (rows) {
      var graded = (rows || []).filter(function (r) { return r && r.grade != null && r.grade !== ''; });
      var sum = 0;
      graded.forEach(function (r) { var n = Number(r.grade); if (!isNaN(n)) sum += n; });
      return {
        total: (rows || []).length,
        graded: graded.length,
        average: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null
      };
    };

    /* --- Manual grade upsert (pure) -----------------------------------------
       Deterministic id from (studentId|qualId|unitCode) so the SAME unit grade
       resolves to the SAME record on every device — the property the snapshot
       reconcile's id-union relies on to avoid duplicates. */
    T.manualGradeId = function (studentId, qualId, unitCode) {
      return 'TG-' + Core.hashString(String(studentId) + '|' + String(qualId) + '|' + String(unitCode));
    };

    T.upsertManualGrade = function (grades, rec) {
      var list = Array.isArray(grades) ? grades.slice() : [];
      if (!rec || !rec.studentId || !rec.qualId || !rec.unitCode) return list;
      var id = T.manualGradeId(rec.studentId, rec.qualId, rec.unitCode);
      var stored = {
        id: id, studentId: rec.studentId, qualId: rec.qualId, unitCode: rec.unitCode,
        grade: rec.grade, date: rec.date || '', source: 'manual',
        examResultId: rec.examResultId || null,
        updatedBy: rec.updatedBy || '', updatedAt: rec.updatedAt || new Date().toISOString()
      };
      var idx = -1;
      list.forEach(function (g, i) { if (g && g.id === id) idx = i; });
      if (idx === -1) list.push(stored); else list[idx] = stored;
      return list;
    };

    T.removeManualGrade = function (grades, studentId, qualId, unitCode) {
      var id = T.manualGradeId(studentId, qualId, unitCode);
      return (Array.isArray(grades) ? grades : []).filter(function (g) { return !g || g.id !== id; });
    };

    /* --- Qualification lookup for a trainee's course ----------------------- */
    T.qualForCourse = function (catalogs, course) {
      var list = Array.isArray(catalogs) ? catalogs : [];
      var c = T.normText(course);
      if (!c) return null;
      var exact = list.filter(function (q) { return q && T.normText(q.skillArea) === c; })[0];
      if (exact) return exact;
      var contains = list.filter(function (q) {
        if (!q) return false;
        var sa = T.normText(q.skillArea), ti = T.normText(q.title);
        return (sa && (c.indexOf(sa) !== -1 || sa.indexOf(c) !== -1)) ||
               (ti && (ti.indexOf(c) !== -1 || c.indexOf(ti) !== -1));
      })[0];
      return contains || null;
    };

    /* --- Certificate / Transcript requests --------------------------------- */
    T.newRequest = function (opts) {
      opts = opts || {};
      return {
        id: 'CTR-' + Core.hashString(String(opts.studentId) + '|' + String(opts.type) + '|' + String(opts.requestedAt || new Date().toISOString())),
        studentId: opts.studentId || '',
        studentName: opts.studentName || '',
        course: opts.course || '',
        type: opts.type === 'certificate' || opts.type === 'both' ? opts.type : 'transcript',
        note: opts.note || '',
        status: 'pending',
        requestedAt: opts.requestedAt || new Date().toISOString(),
        handledBy: '', handledAt: '', adminNote: ''
      };
    };

    // A trainee may have at most one OPEN (pending/processing/ready) request
    // per document type; further clicks are ignored instead of piling up.
    T.hasOpenRequest = function (requests, studentId, type) {
      return (requests || []).some(function (r) {
        return r && r.studentId === studentId &&
          (r.type === type || r.type === 'both' || type === 'both') &&
          (r.status === 'pending' || r.status === 'processing' || r.status === 'ready');
      });
    };

    T.pendingRequestCount = function (requests) {
      return (requests || []).filter(function (r) { return r && (r.status === 'pending' || r.status === 'processing') ; }).length;
    };

    return T;
  })();

  /* --------------------------------------------------------------------------
     Core.Finance — pure helpers for the Payments/Invoices module.

     Payment vouchers are generated straight from the cashbook's quarterly
     transaction records ({id, date, cheque, details, deposit, payment,
     category}). The classification rule mirrors office practice: a payment
     WITH a cheque number gets a HEART/NSTA Cheque Payment Voucher; a payment
     WITHOUT one is a bank transfer and gets a CESTIS Bank Transfer voucher.
     Deposits and cancelled/voided cheques get no voucher at all.
     -------------------------------------------------------------------------- */
  Core.Finance = (function () {
    var F = {};

    var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                'Seventeen', 'Eighteen', 'Nineteen'];
    var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    var SCALES = [
      { value: 1e9, name: 'Billion' },
      { value: 1e6, name: 'Million' },
      { value: 1e3, name: 'Thousand' }
    ];

    function threeDigitsToWords(n) { // 0..999 -> 'Nine Hundred and Ninety-Nine'
      var parts = [];
      var hundreds = Math.floor(n / 100), rest = n % 100;
      if (hundreds) parts.push(ONES[hundreds] + ' Hundred');
      if (rest) {
        var restWords = rest < 20 ? ONES[rest]
          : TENS[Math.floor(rest / 10)] + (rest % 10 ? '-' + ONES[rest % 10] : '');
        parts.push(hundreds ? 'and ' + restWords : restWords);
      }
      return parts.join(' ');
    }

    /* Whole number to words: 130565 -> 'One Hundred and Thirty Thousand, Five
       Hundred and Sixty-Five'. Handles 0 .. 999,999,999,999. */
    F.numberToWords = function (n) {
      n = Math.floor(Math.abs(Number(n) || 0));
      if (n === 0) return 'Zero';
      var parts = [];
      for (var i = 0; i < SCALES.length; i++) {
        var count = Math.floor(n / SCALES[i].value);
        if (count) { parts.push(threeDigitsToWords(count) + ' ' + SCALES[i].name); n %= SCALES[i].value; }
      }
      if (n) parts.push(threeDigitsToWords(n));
      return parts.join(', ');
    };

    /* Voucher-style money in words, matching how the office writes it:
       130565.96 -> 'One Hundred and Thirty Thousand, Five Hundred and
       Sixty-Five Dollars and 96/100'. */
    F.amountToWords = function (amount) {
      var n = Math.abs(Number(amount) || 0);
      var dollars = Math.floor(n);
      var cents = Math.round((n - dollars) * 100);
      if (cents === 100) { dollars += 1; cents = 0; } // 12.999 rounds up to 13.00
      var words = F.numberToWords(dollars) + (dollars === 1 ? ' Dollar' : ' Dollars');
      return words + (cents ? ' and ' + (cents < 10 ? '0' + cents : cents) + '/100' : '');
    };

    F.formatMoney = function (n) {
      n = Number(n) || 0;
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    /* Classify a cashbook transaction: 'cheque' | 'transfer' | null (no voucher).
       Only actual payments qualify — deposits, zero rows and cancelled/voided
       cheques (the cashbook marks both with category 'Cancelled') are skipped. */
    F.voucherTypeFor = function (txn) {
      if (!txn) return null;
      if (String(txn.category || '') === 'Cancelled') return null;
      if (!(Number(txn.payment) > 0)) return null;
      return String(txn.cheque == null ? '' : txn.cheque).trim() ? 'cheque' : 'transfer';
    };

    /* Expand a quarter's transactions into printable voucher records. */
    F.vouchersFromTransactions = function (transactions) {
      return (Array.isArray(transactions) ? transactions : []).reduce(function (out, t) {
        var type = F.voucherTypeFor(t);
        if (!type) return out;
        out.push({
          txnId: t.id,
          type: type,                                   // 'cheque' | 'transfer'
          date: t.date || '',
          payee: t.details || '',
          detail: t.details || '',
          accountCharged: t.category || '',
          chequeNo: type === 'cheque' ? String(t.cheque).trim() : '',
          amount: Number(t.payment) || 0
        });
        return out;
      }, []);
    };

    /* Next document number: max numeric value found + 1, or the seed when the
       list is empty / non-numeric. Accepts numbers or strings ('12550'). */
    F.nextDocNumber = function (existingNumbers, seed) {
      var max = 0;
      (Array.isArray(existingNumbers) ? existingNumbers : []).forEach(function (n) {
        var v = parseInt(String(n).replace(/[^0-9]/g, ''), 10);
        if (isFinite(v) && v > max) max = v;
      });
      return max ? max + 1 : (Number(seed) || 1);
    };

    /* Line-item total that understands both document styles:
       - standard rows: qty × unit price
       - school/RBF rows: percentage% × budget amount */
    F.lineTotal = function (item, schoolStyle) {
      if (!item) return 0;
      var a = Number(item.qty) || 0, b = Number(item.unitPrice) || 0;
      return schoolStyle ? (a / 100) * b : a * b;
    };

    /* Document totals: subtotal over item rows (description-only rows carry no
       amounts), discount as a percentage, tax as a percentage of the discounted
       balance. Returns every figure the paper layout prints. */
    F.docTotals = function (doc) {
      doc = doc || {};
      var school = doc.template === 'school';
      var subtotal = (Array.isArray(doc.items) ? doc.items : []).reduce(function (s, it) {
        return s + (it && !it.isNote ? F.lineTotal(it, school) : 0);
      }, 0);
      var discountPct = Number(doc.discountPct) || 0;
      var discount = subtotal * discountPct / 100;
      var taxPct = Number(doc.taxPct) || 0;
      var tax = (subtotal - discount) * taxPct / 100;
      var amountDue = subtotal - discount + tax;
      var depositPct = Number(doc.depositPct) || 0;
      return {
        subtotal: subtotal, discount: discount, tax: tax, amountDue: amountDue,
        deposit: depositPct ? amountDue * depositPct / 100 : 0
      };
    };

    return F;
  })();

  root.CESTISCore = Core;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
