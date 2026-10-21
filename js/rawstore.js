/* 2초 센서 로그 저장 — 행 수가 많아(하루 43,200행 × 프레스 여러 대) localStorage 대신 IndexedDB 에 프레스마다 한 덩어리로 둡니다.
   IndexedDB 가 막혀 있으면(사생활 보호 창 등) 이번 창의 메모리에만 두고 저장 안 됨을 알립니다. */
(function (root) {
  'use strict';
  var DB = 'data10-01-raw', STORE = 'series', ok = null, dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      try {
        if (!root.indexedDB) throw new Error('no indexedDB');
        var rq = root.indexedDB.open(DB, 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE); };
        rq.onsuccess = function () { ok = true; resolve(rq.result); };
        rq.onerror = function () { ok = false; reject(rq.error); };
      } catch (e) { ok = false; reject(e); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), st = t.objectStore(STORE), out = fn(st);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  root.PressRaw = {
    /* → Promise({ press: series }) */
    loadAll: function () {
      return open().then(function (db) {
        return new Promise(function (resolve) {
          var out = {}, t = db.transaction(STORE, 'readonly'), cur = t.objectStore(STORE).openCursor();
          cur.onsuccess = function () { var c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } };
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { resolve(out); };
        });
      }).catch(function () { return {}; });
    },
    /* map 의 프레스들만 덮어씀 → Promise(true|false) */
    save: function (map) {
      return tx('readwrite', function (st) { Object.keys(map).forEach(function (k) { st.put(map[k], k); }); }).then(function () { return true; }, function () { return false; });
    },
    remove: function (keys) {
      return tx('readwrite', function (st) { keys.forEach(function (k) { st.delete(k); }); }).then(function () { return true; }, function () { return false; });
    },
    clear: function () { return tx('readwrite', function (st) { st.clear(); }).then(function () { return true; }, function () { return false; }); },
    available: function () { return ok; }
  };
})(window);
