/* DZ Drop Zone — the folder
   ========================================================================

   Connects the site to a real folder on the user's disk -- a USB stick,
   Documents, anywhere -- and files what they drop into it by TYPE.

   Filing by type rather than by app is deliberate. A photo is not DZMarkup's
   photo; all three apps can open it. Filed under an app it would either be
   duplicated or arbitrarily assigned, so it lives in Photos/ and every app
   sees the one copy.

   The classification comes from detect.js, the same engine the hub uses to
   decide which app tiles light up. One set of rules for both jobs, so a file
   can't be routed one way and filed another.

   THE FOLDER IS THE SOURCE OF TRUTH. There is no database mirroring it, no
   index to keep in step. The listing is read from disk every time. That is
   what lets someone rename a file, drop clips in from their file manager, or
   delete something, and have the site simply agree -- no sync, no refresh
   button, no orphaned entries.

   File System Access is Chromium-desktop only (Chrome, Edge, Brave, Opera).
   Firefox has said it does not intend to ship the picker, Safari has not,
   and no mobile browser has. isSupported() is the gate; everything here is
   an enhancement and nothing else may depend on it.
*/
(function (global) {
  'use strict';

  // family (from detect.js) -> folder. Anything not listed goes to Other,
  // so an unrecognised file is still filed rather than refused.
  var FOLDER_FOR = {
    image: 'Photos',
    video: 'Videos',
    audio: 'Audio',
    pdf: 'PDFs',
    docx: 'Documents',
    text: 'Documents',
    rtf: 'Documents',
    docu: 'Projects',
    dzvid: 'Projects',
  };
  var OTHER = 'Other';

  // Created on connect so the folder looks deliberate from the first moment,
  // rather than growing folders one at a time as files happen to arrive.
  var TOP = ['Photos', 'Videos', 'Audio', 'Documents', 'PDFs', 'Projects', 'Other'];
  // Where an app's output goes, kept apart from the originals it came from.
  var EDITED = 'Edited';
  var HAS_EDITED = { Photos: 1, Videos: 1, Documents: 1, PDFs: 1 };

  var DB = 'dzdropzone-folder', STORE = 'handles';
  var KEY = 'root';            // the pre-list single handle, migrated on read
  var KEY_LIST = 'folders', KEY_ACTIVE = 'activeId';

  // The marker. Written at the root of every folder the site adopts.
  //
  // It CANNOT be used to find a folder -- no browser will let a page search
  // the disk, and none ever will; a folder only ever arrives by the user
  // picking it in a dialog. What it does instead is let a folder be
  // RECOGNISED once it is picked: the handle is per-browser and stays on
  // this machine, but the marker travels with the drive, so the same USB
  // stick keeps its name and identity when it turns up on another computer.
  // It is also what lets two folders know they are a pair.
  var MARKER = '.dzdropzone.json';

  function isSupported() {
    return typeof global.showDirectoryPicker === 'function';
  }

  // ---------------------------------------------------------------------
  // Remembering the folder between visits
  //
  // A directory handle is structured-cloneable, so IndexedDB can hold it.
  // The PERMISSION is not stored with it -- the browser re-asks on a new
  // visit, which is a security rule and not something to work around. What
  // this buys is one click instead of hunting for the folder again.
  // ---------------------------------------------------------------------

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbPut(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result === undefined ? null : r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbDel(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
      });
    });
  }

  // ---------------------------------------------------------------------
  // The list of folders
  //
  // One record per folder: { id, label, handle, added, lastUsed }. The id
  // comes from the folder's own marker when it has one, so re-picking the
  // same stick updates the record it already had rather than adding a
  // second entry for the same physical folder.
  // ---------------------------------------------------------------------

  var state = null;            // { folders: [], activeId: null }, cached
  var touched = {};            // folder ids whose marker was refreshed this session

  function newId() {
    var b = new Uint8Array(8);
    (global.crypto || {}).getRandomValues
      ? global.crypto.getRandomValues(b)
      : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    return 'f_' + Array.prototype.map.call(b, function (x) {
      return ('0' + x.toString(16)).slice(-2);
    }).join('');
  }

  function loadState() {
    if (state) return Promise.resolve(state);
    return Promise.all([idbGet(KEY_LIST), idbGet(KEY_ACTIVE), idbGet(KEY)])
      .then(function (r) {
        var list = r[0], active = r[1], legacy = r[2];
        if (!Array.isArray(list)) list = [];
        // Anyone who connected a folder before the list existed keeps it,
        // as the first entry, without having to pick it again.
        if (!list.length && legacy) {
          var id = newId();
          list = [{ id: id, label: legacy.name || 'My folder', handle: legacy,
                    added: Date.now(), lastUsed: Date.now() }];
          active = id;
          idbPut(KEY_LIST, list.map(strip)).catch(function () {});
          idbPut(KEY_ACTIVE, active).catch(function () {});
        }
        state = { folders: list, activeId: active || (list[0] && list[0].id) || null };
        return state;
      }).catch(function () {
        state = { folders: [], activeId: null };
        return state;
      });
  }

  // Records go to disk as they are -- handles included, which is the whole
  // point -- but this is where anything non-cloneable would be dropped.
  function strip(rec) {
    return { id: rec.id, label: rec.label, handle: rec.handle,
             added: rec.added, lastUsed: rec.lastUsed };
  }

  function saveState() {
    if (!state) return Promise.resolve();
    return Promise.all([
      idbPut(KEY_LIST, state.folders.map(strip)),
      idbPut(KEY_ACTIVE, state.activeId),
    ]).catch(function () { /* private mode: works, just won't be remembered */ });
  }

  function recordFor(id) {
    if (!state) return null;
    for (var i = 0; i < state.folders.length; i++) {
      if (state.folders[i].id === id) return state.folders[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // The marker file
  // ---------------------------------------------------------------------

  function readMarker(dir) {
    return dir.getFileHandle(MARKER).then(function (fh) {
      return fh.getFile().then(function (f) { return f.text(); });
    }).then(function (t) {
      var o = JSON.parse(t);
      return o && o.dzdropzone ? o : null;
    }).catch(function () { return null; });   // absent, unreadable, or not ours
  }

  function writeMarker(dir, data) {
    return dir.getFileHandle(MARKER, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(JSON.stringify(data, null, 2)).then(function () { return w.close(); });
      });
    }).catch(function () { /* read-only media: the folder still works */ });
  }

  // Not a computer name -- no browser will tell us one. It is "the kind of
  // machine this was last opened on", which is enough to be useful in a
  // sentence and honest about what it is.
  function deviceHint() {
    var d = global.navigator || {};
    return (d.userAgentData && d.userAgentData.platform) || d.platform || 'a computer';
  }

  function markerFor(rec, existing) {
    var now = Date.now();
    return {
      dzdropzone: 1,
      id: rec.id,
      label: rec.label,
      created: (existing && existing.created) || now,
      lastSeen: now,
      lastDevice: deviceHint(),
      // Folders that have been compared against this one. Written by the
      // compare page; kept here so the shape lives in one place.
      pairs: (existing && existing.pairs) || [],
    };
  }

  // ---------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------

  var root = null;

  function ensureStructure(dir) {
    // Sequential rather than parallel: creating directories concurrently in
    // the same parent has raced in practice, and this happens once.
    return TOP.reduce(function (chain, name) {
      return chain.then(function () {
        return dir.getDirectoryHandle(name, { create: true }).then(function (sub) {
          if (!HAS_EDITED[name]) return;
          return sub.getDirectoryHandle(EDITED, { create: true });
        });
      });
    }, Promise.resolve());
  }

  // Must be called from a user gesture -- the picker will not open otherwise.
  //
  // Adds a folder to the list and makes it the active one. Picking a folder
  // the site already knows (same marker) updates that record instead of
  // adding a duplicate, which is what happens every time a USB stick is
  // re-picked on a machine whose stored handle has gone stale.
  function addFolder() {
    if (!isSupported()) return Promise.reject(new Error('This browser cannot open a folder.'));
    return loadState().then(function () {
      return global.showDirectoryPicker({ mode: 'readwrite', id: 'dzdropzone', startIn: 'documents' });
    }).then(function (dir) {
      return ensureStructure(dir).then(function () {
        return readMarker(dir);
      }).then(function (mark) {
        var rec = (mark && recordFor(mark.id)) || null;
        if (rec) {
          rec.handle = dir;                       // a fresh handle for the same folder
          rec.lastUsed = Date.now();
        } else {
          rec = {
            id: (mark && mark.id) || newId(),
            label: (mark && mark.label) || dir.name || 'My folder',
            handle: dir, added: Date.now(), lastUsed: Date.now(),
          };
          state.folders.push(rec);
        }
        state.activeId = rec.id;
        root = dir;
        return writeMarker(dir, markerFor(rec, mark)).then(saveState).then(function () {
          return { dir: dir, record: publicRec(rec), knew: !!mark };
        });
      });
    });
  }

  // Kept because three apps and two rooms call it. Same job as before:
  // "get me a folder", from a user gesture.
  function connect() {
    return addFolder().then(function (r) { return r.dir; });
  }

  function grant(handle, interactive) {
    // Not every FileSystemDirectoryHandle carries the permission methods --
    // they belong to the picker-based API, and a handle from elsewhere can
    // arrive without them. Nothing to ask about in that case.
    if (!handle) return Promise.resolve(null);
    if (typeof handle.queryPermission !== 'function') return Promise.resolve(handle);
    return handle.queryPermission({ mode: 'readwrite' }).then(function (s) {
      if (s === 'granted') return handle;
      if (!interactive) return null;
      return handle.requestPermission({ mode: 'readwrite' }).then(function (asked) {
        return asked === 'granted' ? handle : null;
      });
    }).catch(function () { return null; });
  }

  // Makes one of the remembered folders the active one. Needs a gesture when
  // interactive, because it may have to ask for permission again.
  function useFolder(id, interactive) {
    return loadState().then(function () {
      var rec = recordFor(id);
      if (!rec) return null;
      return grant(rec.handle, interactive).then(function (h) {
        if (!h) return null;
        root = h;
        rec.lastUsed = Date.now();
        state.activeId = rec.id;
        // Refresh the marker so "last seen" means something on the next
        // machine -- but ONCE per session, not on every page load. reconnect()
        // runs on every app open, and a write per open would mean pointless
        // traffic to a USB stick all day. Best effort either way: a read-only
        // stick still works, it just keeps an older date.
        if (!touched[rec.id]) {
          touched[rec.id] = 1;
          readMarker(h).then(function (m) { return writeMarker(h, markerFor(rec, m)); })
            .catch(function () {});
        }
        return saveState().then(function () { return h; });
      });
    });
  }

  function forgetFolder(id) {
    return loadState().then(function () {
      state.folders = state.folders.filter(function (r) { return r.id !== id; });
      if (state.activeId === id) {
        state.activeId = state.folders.length ? state.folders[0].id : null;
        root = null;
      }
      // The marker is deliberately LEFT on disk. Forgetting is this
      // browser's business; the folder itself still belongs to the user and
      // may be picked again here or on another machine.
      return saveState();
    });
  }

  function renameFolder(id, label) {
    return loadState().then(function () {
      var rec = recordFor(id);
      if (!rec) return null;
      rec.label = String(label || '').trim() || rec.label;
      return grant(rec.handle, false).then(function (h) {
        if (h) readMarker(h).then(function (m) { return writeMarker(h, markerFor(rec, m)); })
          .catch(function () {});
        return saveState().then(function () { return publicRec(rec); });
      });
    });
  }

  // Without the handle -- callers get something they can render, and can't
  // accidentally hold a reference that keeps a stale handle alive.
  function publicRec(rec) {
    return { id: rec.id, label: rec.label, added: rec.added, lastUsed: rec.lastUsed };
  }

  // Is the folder actually there, right now?
  //
  // queryPermission CANNOT answer this. It reports what the browser has
  // agreed to, which stays 'granted' for a USB stick that was pulled out an
  // hour ago -- so a permission check alone would report a missing drive as
  // fine and then fail confusingly at the first read. The only way to know
  // is to try to read it, so that is what this does: one entry, discarded.
  function probe(handle) {
    try {
      var it = handle.values();
      return it.next().then(function () { return 'ready'; }, function () { return 'gone'; });
    } catch (e) {
      return Promise.resolve('gone');
    }
  }

  // Every remembered folder with what is actually true of it right now:
  //
  //   ready   -- there, allowed, readable
  //   prompt  -- there as far as we know, but needs one click to allow
  //   denied  -- the browser is refusing
  //   gone    -- permission is fine and the folder still isn't readable,
  //              which in practice means an unplugged stick
  //
  // Telling those apart is the whole point: each one needs different words
  // and a different button, and lumping them together as "not connected" is
  // what made an unplugged USB look like a bug.
  function folders() {
    return loadState().then(function () {
      return Promise.all(state.folders.map(function (rec) {
        var out = publicRec(rec);
        out.active = rec.id === state.activeId;
        var h = rec.handle;
        if (!h) { out.status = 'gone'; return out; }
        if (typeof h.queryPermission !== 'function') {
          return probe(h).then(function (s) { out.status = s; return out; });
        }
        return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
          if (p === 'denied') { out.status = 'denied'; return out; }
          if (p !== 'granted') { out.status = 'prompt'; return out; }
          return probe(h).then(function (s) { out.status = s; return out; });
        }, function () { out.status = 'gone'; return out; });
      }));
    });
  }

  function activeFolder() {
    return loadState().then(function () {
      var rec = recordFor(state.activeId);
      return rec ? publicRec(rec) : null;
    });
  }

  // The handle for any remembered folder, permission and all. This is what
  // the compare page uses to hold TWO folders open at once.
  function handleFor(id, interactive) {
    return loadState().then(function () {
      var rec = recordFor(id);
      return rec ? grant(rec.handle, interactive) : null;
    });
  }

  // Returns the active folder's handle if permission is still granted.
  // `interactive` may prompt, so it needs a user gesture; without it this is
  // a silent check safe to run on page load.
  function reconnect(interactive) {
    return loadState().then(function () {
      if (!state.activeId) return null;
      return useFolder(state.activeId, interactive);
    }).catch(function () { return null; });
  }

  // True when any folder is remembered, whether or not one is usable yet --
  // this is what tells the UI to offer "Reconnect" rather than "Connect".
  function wasConnected() {
    return loadState().then(function (s) { return s.folders.length > 0; });
  }

  // Stops using the active folder without forgetting it. The old behaviour
  // (throw the handle away entirely) is forgetFolder now.
  function disconnect() {
    root = null;
    return loadState().then(function () {
      state.activeId = null;
      return saveState();
    });
  }

  function forgetAll() {
    root = null;
    state = { folders: [], activeId: null };
    return Promise.all([idbDel(KEY), idbDel(KEY_LIST), idbDel(KEY_ACTIVE)]);
  }

  function current() { return root; }

  // ---------------------------------------------------------------------
  // Filing
  // ---------------------------------------------------------------------

  function folderFor(family) { return FOLDER_FOR[family] || OTHER; }

  // Strip anything a file system would object to, without mangling ordinary
  // names. Windows is the strict one, so its rules are the ones applied.
  function safeName(name) {
    var clean = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
    return clean || 'file';
  }

  function splitName(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' };
  }

  function exists(dir, name) {
    return dir.getFileHandle(name).then(function () { return true; }, function () { return false; });
  }

  // "photo.jpg" -> "photo (2).jpg", the way a file manager does it, rather
  // than overwriting or appending a hash nobody can read.
  function freeName(dir, name) {
    return exists(dir, name).then(function (taken) {
      if (!taken) return name;
      var p = splitName(name);
      var attempt = function (n) {
        var candidate = p.base + ' (' + n + ')' + p.ext;
        return exists(dir, candidate).then(function (t) {
          return t ? (n < 999 ? attempt(n + 1) : p.base + '-' + Date.now() + p.ext) : candidate;
        });
      };
      return attempt(2);
    });
  }

  function targetDir(family, edited) {
    if (!root) return Promise.reject(new Error('No folder connected.'));
    var top = folderFor(family);
    return root.getDirectoryHandle(top, { create: true }).then(function (dir) {
      if (!edited || !HAS_EDITED[top]) return { dir: dir, path: top };
      return dir.getDirectoryHandle(EDITED, { create: true })
        .then(function (sub) { return { dir: sub, path: top + '/' + EDITED }; });
    });
  }

  // Writes a Blob/File into the folder its family belongs to. Resolves with
  // where it landed, so the caller can say so rather than guess.
  function put(blob, opts) {
    opts = opts || {};
    var family = opts.family || 'other';
    var name = safeName(opts.name || blob.name || 'file');
    return targetDir(family, opts.edited).then(function (t) {
      return freeName(t.dir, name).then(function (finalName) {
        return t.dir.getFileHandle(finalName, { create: true }).then(function (fh) {
          return fh.createWritable().then(function (w) {
            // The stream writes straight to disk, so a large video never has
            // to be held in memory in one piece.
            return w.write(blob).then(function () { return w.close(); });
          }).then(function () {
            return { name: finalName, folder: t.path, path: t.path + '/' + finalName };
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Reading it back
  //
  // Always from disk. Whatever is there is what is reported -- including
  // files the user put there themselves, which is the point.
  // ---------------------------------------------------------------------

  function readDir(dir, path, depth) {
    var files = [], dirs = [];
    var walk = (async function () {
      for await (var entry of dir.values()) {
        // The marker is bookkeeping, not one of the user's files. It must
        // not appear in the explorer, must not be counted in the totals,
        // and must not turn up as a row in the compare table.
        //
        // .crswap goes with it: createWritable() writes through a swap file
        // beside the target and renames it on close, so one is visible while
        // any write is in flight -- and is left behind outright if a write is
        // interrupted. Never a file the user made, either way.
        if (entry.kind !== 'directory' &&
            (entry.name === MARKER || /\.crswap$/.test(entry.name))) continue;
        if (entry.kind === 'directory') dirs.push(entry);
        else files.push(entry);
      }
    })();
    return walk.then(function () {
      return Promise.all(files.map(function (fh) {
        return fh.getFile().then(function (f) {
          return { kind: 'file', name: f.name, size: f.size, modified: f.lastModified,
                   path: path ? path + '/' + f.name : f.name, handle: fh };
        }, function () { return null; });
      })).then(function (fileInfos) {
        fileInfos = fileInfos.filter(Boolean).sort(function (a, b) { return a.name.localeCompare(b.name); });
        if (depth <= 0) {
          return { name: dir.name, path: path, files: fileInfos, dirs: [] };
        }
        return Promise.all(dirs.sort(function (a, b) { return a.name.localeCompare(b.name); })
          .map(function (d) {
            return readDir(d, path ? path + '/' + d.name : d.name, depth - 1);
          })).then(function (subs) {
            return { name: dir.name, path: path, files: fileInfos, dirs: subs };
          });
      });
    });
  }

  function list(depth) {
    if (!root) return Promise.reject(new Error('No folder connected.'));
    return readDir(root, '', depth === undefined ? 2 : depth);
  }

  // The same walk against any handle, not just the active folder -- which
  // is what comparing two folders needs, since neither of them may be the
  // one currently being filed into.
  function readTree(handle, depth) {
    if (!handle) return Promise.reject(new Error('No folder.'));
    return readDir(handle, '', depth === undefined ? 4 : depth);
  }

  // Every file in a tree as a flat path -> info map. Directories vanish;
  // only the leaves matter when asking what one folder has that another
  // doesn't.
  function flatten(tree) {
    var out = {};
    (function walk(node) {
      node.files.forEach(function (f) { out[f.path] = f; });
      node.dirs.forEach(walk);
    })(tree);
    return out;
  }

  // Copies one file into another folder at the same relative path, creating
  // whatever directories it needs on the way. Overwrites only when the
  // caller passes overwrite:true -- and there is deliberately no delete
  // anywhere in this file's public surface.
  function copyInto(destRoot, path, file, opts) {
    opts = opts || {};
    var parts = path.split('/');
    var name = parts.pop();
    return parts.reduce(function (chain, p) {
      return chain.then(function (d) { return d.getDirectoryHandle(p, { create: true }); });
    }, Promise.resolve(destRoot)).then(function (dir) {
      return dir.getFileHandle(name).then(function () { return true; }, function () { return false; })
        .then(function (exists) {
          if (exists && !opts.overwrite) throw new Error('Already there: ' + path);
          return dir.getFileHandle(name, { create: true });
        });
    }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(file).then(function () { return w.close(); });
      });
    }).then(function () { return { path: path }; });
  }

  function totals(tree) {
    var count = 0, bytes = 0;
    (function walk(node) {
      node.files.forEach(function (f) { count++; bytes += f.size; });
      node.dirs.forEach(walk);
    })(tree);
    return { count: count, bytes: bytes };
  }

  function remove(path) {
    if (!root) return Promise.reject(new Error('No folder connected.'));
    var parts = path.split('/');
    var name = parts.pop();
    return parts.reduce(function (chain, p) {
      return chain.then(function (d) { return d.getDirectoryHandle(p); });
    }, Promise.resolve(root)).then(function (dir) {
      return dir.removeEntry(name);
    });
  }

  // ---------------------------------------------------------------------
  // Is this the same file?
  //
  // Hashes the first and last megabyte plus the exact byte length, which is
  // CONSTANT TIME -- about 8ms whether the file is 3MB or 40MB, where
  // hashing a 2GB video outright takes minutes. Two files agreeing on all
  // three are the same file for every practical purpose; two that differ
  // anywhere in those regions certainly are not.
  //
  // Needs a secure context: crypto.subtle does not exist over plain http.
  // Callers get null rather than an exception, and should fall back to
  // comparing size and date and SAY that is what they are doing.
  //
  // DZVidStitch's project.js carries the same algorithm for matching clips
  // back to a saved edit. If either changes, change both.
  // ---------------------------------------------------------------------

  var EDGE = 1024 * 1024;

  function fingerprint(file) {
    var subtle = (global.crypto || {}).subtle;
    if (!subtle) return Promise.resolve(null);
    var size = file.size;
    var parts = size <= EDGE * 2
      ? [file]
      : [file.slice(0, EDGE), file.slice(size - EDGE)];
    return Promise.all(parts.map(function (b) { return b.arrayBuffer(); }))
      .then(function (bufs) {
        var total = bufs.reduce(function (n, b) { return n + b.byteLength; }, 8);
        var all = new Uint8Array(total);
        var at = 0;
        bufs.forEach(function (b) { all.set(new Uint8Array(b), at); at += b.byteLength; });
        // The length goes INTO the hash, so two files sharing both edges but
        // differing in the middle can still be told apart by size alone.
        new DataView(all.buffer).setFloat64(at, size);
        return subtle.digest('SHA-256', all);
      })
      .then(function (h) {
        return Array.prototype.map.call(new Uint8Array(h), function (x) {
          return ('0' + x.toString(16)).slice(-2);
        }).join('');
      })
      .catch(function () { return null; });
  }

  global.DZFolder = {
    isSupported: isSupported,
    connect: connect,
    reconnect: reconnect,
    wasConnected: wasConnected,
    disconnect: disconnect,
    current: current,
    put: put,
    list: list,
    readTree: readTree,
    flatten: flatten,
    copyInto: copyInto,
    totals: totals,
    remove: remove,
    folderFor: folderFor,
    // the list
    addFolder: addFolder,
    folders: folders,
    useFolder: useFolder,
    forgetFolder: forgetFolder,
    forgetAll: forgetAll,
    renameFolder: renameFolder,
    activeFolder: activeFolder,
    handleFor: handleFor,
    // the marker
    readMarker: readMarker,
    writeMarker: writeMarker,
    MARKER: MARKER,
    fingerprint: fingerprint,
    TOP: TOP,
    EDITED: EDITED,
  };
})(window);
