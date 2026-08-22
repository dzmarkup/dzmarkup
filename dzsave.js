/* DZ Drop Zone — saving from inside an app
   ========================================================================

   folder.js knows how to file a blob. This is the thin layer the three apps
   actually call: "here is what I made, put it wherever it goes."

   The point is that an app should not have to care whether a folder is
   connected. save() tries the folder and falls back to a download, so the
   Save button does something sensible in Firefox, on a phone, and on a
   machine where nobody has ever picked a folder -- exactly as it did before
   any of this existed.

   Two rules that follow from that, and are worth not breaking:

   - NOTHING HERE MAY THROW INTO AN APP. A folder that has gone away, a
     revoked permission, a full disk: each one falls back to the download
     path and says so. Losing someone's work because the filing cabinet was
     unavailable would be far worse than not having a filing cabinet.
   - THE CHIP IS OPTIONAL FURNITURE. It tells the user where their saves are
     going and offers the one click needed to reconnect. An app that never
     mounts it still saves correctly.

   The chip and the toast are screen-only. Both carry a print rule, because
   DZDocu prints and a floating status pill on a letterhead would be a bug.
*/
(function (global) {
  'use strict';

  var doc = global.document;

  function folder() { return global.DZFolder; }
  function supported() { var f = folder(); return !!f && f.isSupported(); }

  // Resolved once per page load. reconnect(false) is the silent check --
  // safe on load, and it is the whole reason a user who connected on the hub
  // does not have to connect again in each app: the permission is per-origin
  // and the handle is in the same IndexedDB.
  var readied = null;
  function ready() {
    if (readied) return readied;
    readied = new Promise(function (resolve) {
      if (!supported()) return resolve({ supported: false, connected: false, remembered: false });
      folder().reconnect(false).then(function (dir) {
        if (dir) return resolve({ supported: true, connected: true, remembered: true });
        folder().wasConnected().then(function (was) {
          resolve({ supported: true, connected: false, remembered: !!was });
        }, function () { resolve({ supported: true, connected: false, remembered: false }); });
      }, function () {
        resolve({ supported: true, connected: false, remembered: false });
      });
    });
    return readied;
  }

  // A fresh look, for after something changed. ready() caches; this doesn't.
  function status() {
    readied = null;
    return ready();
  }

  // Must be called from a user gesture. Picks a folder if there isn't one,
  // or re-asks for permission on the folder already remembered.
  function connect() {
    if (!supported()) return Promise.reject(new Error('This browser cannot open a folder.'));
    return folder().wasConnected().then(function (was) {
      return was ? folder().reconnect(true).then(function (d) { return d || folder().connect(); })
                 : folder().connect();
    }).then(function (dir) {
      readied = null;
      paintChip();
      return dir;
    });
  }

  // ---------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = name;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return { where: 'download', name: name, path: null };
  }

  /* save(blob, opts) -> Promise<{where, name, path}>

     opts.name    filename, extension included
     opts.family  a detect.js family: image video audio pdf docx text rtf docu
     opts.edited  true for something this app MADE, which is nearly always
                  the case here -- it lands in <Folder>/Edited so an app's
                  output never gets mixed in with the user's originals
     opts.quiet   skip the toast (the caller is reporting it another way)
     opts.forceDownload  the user asked for a file, not filing

     `where` is 'folder' or 'download'. It is never an exception.
  */
  function save(blob, opts) {
    opts = opts || {};
    var name = opts.name || 'file';
    if (opts.forceDownload) {
      var d = download(blob, name);
      if (!opts.quiet) toast('Downloaded ' + name);
      return Promise.resolve(d);
    }
    return ready().then(function (s) {
      if (!s.connected) throw new Error('no folder');
      return folder().put(blob, {
        name: name,
        family: opts.family || 'other',
        edited: opts.edited !== false,
      });
    }).then(function (r) {
      if (!opts.quiet) toast('Saved to ' + r.path);
      return { where: 'folder', name: r.name, path: r.path };
    }, function () {
      // Any failure at all -- no folder, revoked permission, disk full --
      // becomes an ordinary download. The user still gets their file.
      var r = download(blob, name);
      if (!opts.quiet) toast('Downloaded ' + name);
      return r;
    });
  }

  // ---------------------------------------------------------------------
  // Furniture
  // ---------------------------------------------------------------------

  var STYLE_ID = 'dz-save-style';
  var CSS = [
    '.dz-save-chip{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:.5em;',
    'font:600 12px/1 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;letter-spacing:.02em;',
    'padding:.55em .75em;border-radius:999px;border:1px solid rgba(255,255,255,.16);',
    'background:rgba(18,24,34,.86);color:#cfe3ff;backdrop-filter:blur(6px);',
    '-webkit-backdrop-filter:blur(6px);box-shadow:0 4px 18px rgba(0,0,0,.35);',
    'cursor:default;user-select:none;max-width:min(52vw,380px)}',
    '.dz-save-chip[hidden]{display:none}',
    '.dz-save-chip .dz-dot{width:.55em;height:.55em;border-radius:50%;background:#4ade80;flex:0 0 auto;',
    'box-shadow:0 0 0 3px rgba(74,222,128,.18)}',
    '.dz-save-chip.is-off .dz-dot{background:#f2a33c;box-shadow:0 0 0 3px rgba(242,163,60,.18)}',
    '.dz-save-chip .dz-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dz-save-chip button{font:inherit;color:#9fd0ff;background:none;border:0;padding:0;',
    'cursor:pointer;text-decoration:underline;flex:0 0 auto}',
    '.dz-save-chip button:hover{color:#fff}',
    '.dz-save-toast{position:fixed;z-index:2147483001;left:50%;transform:translateX(-50%);',
    'bottom:5.5em;padding:.7em 1.1em;border-radius:10px;background:rgba(18,24,34,.94);',
    'color:#eaf3ff;font:600 13px/1.35 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;',
    'box-shadow:0 8px 28px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12);',
    'opacity:0;transition:opacity .18s ease;pointer-events:none;max-width:min(80vw,520px);',
    'text-align:center}',
    '.dz-save-toast.show{opacity:1}',
    '@media print{.dz-save-chip,.dz-save-toast{display:none !important}}',
  ].join('');

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    var s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  var toastEl = null, toastTimer = null;
  // Every app has furniture along one edge or the other -- DZDocu's
  // magnifier strip and page buttons own its bottom, so it asks for the top.
  var toastPos = { at: 'bottom', offset: '5.5em' };

  function configureToast(opts) {
    opts = opts || {};
    if (opts.at) toastPos.at = opts.at;
    if (opts.offset) toastPos.offset = opts.offset;
    if (toastEl) placeToast();
  }

  // The unused edge must be 'auto', not ''. Clearing it inline just lets the
  // stylesheet's own `bottom` apply again, and a fixed element with both top
  // and bottom set stretches to fill the gap -- which turned the toast into
  // a full-height panel over the artwork.
  function placeToast() {
    var top = toastPos.at === 'top';
    toastEl.style.top = top ? toastPos.offset : 'auto';
    toastEl.style.bottom = top ? 'auto' : toastPos.offset;
  }

  function toast(msg) {
    ensureStyle();
    if (!toastEl) {
      toastEl = doc.createElement('div');
      toastEl.className = 'dz-save-toast';
      toastEl.setAttribute('role', 'status');
      doc.body.appendChild(toastEl);
      placeToast();
    }
    toastEl.textContent = msg;
    // Force a reflow so the class change animates even on a rapid re-toast.
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }

  var chipEl = null, chipOpts = null, chipShown = true;

  // An app with a setup or entry screen doesn't want the chip floating over
  // it -- there's nothing to save yet. showChip(false) parks it without
  // unmounting, so the state survives being toggled every render.
  function showChip(on) {
    chipShown = on !== false;
    paintChip();
  }

  function paintChip() {
    if (!chipEl) return;
    ready().then(function (s) {
      // Unsupported browsers get nothing at all. The hub is where the
      // "this works in Chrome, Edge, Brave and Opera" story is told; a
      // nag in every app would just be noise.
      if (!s.supported || !chipShown) { chipEl.hidden = true; return; }
      chipEl.hidden = false;
      chipEl.classList.toggle('is-off', !s.connected);
      var txt = chipEl.querySelector('.dz-txt');
      var btn = chipEl.querySelector('button');
      if (s.connected) {
        txt.textContent = 'Saving to your folder';
        btn.hidden = true;
      } else {
        txt.textContent = s.remembered ? 'Folder disconnected' : 'Saves download to this device';
        btn.hidden = false;
        btn.textContent = s.remembered ? 'Reconnect' : 'Use a folder';
      }
    });
  }

  /* mountChip({corner, offset}) -- optional. corner is one of
     'bottom-left' (default), 'bottom-right', 'top-left', 'top-right'. */
  function mountChip(opts) {
    opts = opts || {};
    ensureStyle();
    if (!chipEl) {
      chipEl = doc.createElement('div');
      chipEl.className = 'dz-save-chip';
      chipEl.hidden = true;
      chipEl.innerHTML = '<span class="dz-dot"></span><span class="dz-txt"></span><button type="button"></button>';
      chipEl.querySelector('button').addEventListener('click', function () {
        connect().catch(function () { /* the user closed the picker */ });
      });
      doc.body.appendChild(chipEl);
    }
    chipOpts = opts;
    // Separate axes because the apps have furniture in the way: DZDocu's
    // toolbar owns the top 47px and its magnifier strip owns the bottom
    // band, so a single offset can't clear both.
    var offY = opts.offsetY || opts.offset || '14px';
    var offX = opts.offsetX || opts.offset || '14px';
    var corner = opts.corner || 'bottom-left';
    chipEl.style.top = chipEl.style.bottom = chipEl.style.left = chipEl.style.right = '';
    chipEl.style[corner.indexOf('top') === 0 ? 'top' : 'bottom'] = offY;
    chipEl.style[corner.indexOf('left') !== -1 ? 'left' : 'right'] = offX;
    paintChip();
    return chipEl;
  }

  global.DZSave = {
    ready: ready,
    status: status,
    connect: connect,
    save: save,
    download: download,
    toast: toast,
    configureToast: configureToast,
    mountChip: mountChip,
    showChip: showChip,
    refreshChip: paintChip,
    isSupported: supported,
  };
})(window);
