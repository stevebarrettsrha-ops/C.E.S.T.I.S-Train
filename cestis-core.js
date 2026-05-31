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
    function drainQueue() { var q = wq; wq = []; for (var i = 0; i < q.length; i++) { writeIDB(q[i].k, q[i].v, q[i].del); } }
    function writeIDB(k, v, del) {
      if (!db) { if (!ready) { wq.push({ k: k, v: v, del: del }); } return; }
      try { var os = db.transaction(STORE, 'readwrite').objectStore(STORE); if (del) { os.delete(k); } else { os.put(v, k); } } catch (e) {}
    }
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

  root.CESTISCore = Core;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
