/* DZ Drop Zone — what is this file?
   ========================================================================

   Identifies a dropped file and pulls out whatever it can tell us about it,
   so the hub can show a report and light up the apps that can open it.

   Everything here runs in the browser against the file the user dropped.
   Nothing is uploaded, and the only library involved is pdf.js, which is
   already on this site for DZDocu and is fetched only when a PDF actually
   turns up.

   Two rules the rest of this file follows:

   * Identify by CONTENT, not by extension. Extensions lie, Windows hides
     them, and several formats here share one (.docx/.xlsx/.pptx/.epub are
     all ZIP files; a .docu is JSON). The extension is only ever used to
     break a tie between formats that really are byte-identical at the head.

   * Never let a detail failure lose the file. Every extractor is wrapped:
     if EXIF is malformed or a video won't decode, we still report name,
     size and type. A file we can barely describe is far better than an
     error where the report should be.
*/
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // Which app can open what.
  //
  // Taken from each app's own file picker `accept` attribute rather than
  // guessed, so this can't drift from what they actually take. If an app's
  // accept list changes, change it here too.
  // ---------------------------------------------------------------------
  var APPS = {
    dzdocu: {
      name: 'DZDocu', href: 'dzdocu/',
      // accept=".docu,image/*,application/pdf,.docx,...,.txt,.rtf"
      families: ['docu', 'image', 'pdf', 'docx', 'text', 'rtf'],
    },
    dzvidstitch: {
      name: 'DZVidStitch', href: 'dzvidstitch/',
      // accept="video/*,image/*,audio/*"
      families: ['video', 'image', 'audio'],
    },
    dzmarkup: {
      name: 'DZMarkup', href: 'dzmarkup/',
      // accept="image/*,.pdf,application/pdf"
      families: ['image', 'pdf'],
    },
  };

  function appsFor(family) {
    return Object.keys(APPS).filter(function (id) {
      return APPS[id].families.indexOf(family) !== -1;
    });
  }

  // ---------------------------------------------------------------------
  // Byte helpers
  // ---------------------------------------------------------------------

  function readBytes(file, start, length) {
    return file.slice(start, Math.min(start + length, file.size)).arrayBuffer()
      .then(function (buf) { return new Uint8Array(buf); });
  }

  // Compare bytes at an offset against a signature. Accepts numbers, or
  // null as a single-byte wildcard for formats with a variable field in
  // the middle of an otherwise fixed header.
  function sigAt(bytes, offset, sig) {
    if (offset + sig.length > bytes.length) return false;
    for (var i = 0; i < sig.length; i++) {
      if (sig[i] === null) continue;
      if (bytes[offset + i] !== sig[i]) return false;
    }
    return true;
  }

  function ascii(bytes, offset, length) {
    var out = '';
    for (var i = 0; i < length && offset + i < bytes.length; i++) {
      out += String.fromCharCode(bytes[offset + i]);
    }
    return out;
  }

  function str(s) {
    return s.split('').map(function (c) { return c.charCodeAt(0); });
  }

  var u16le = function (b, o) { return b[o] | (b[o + 1] << 8); };
  var u32le = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; };
  var u16be = function (b, o) { return (b[o] << 8) | b[o + 1]; };
  var u32be = function (b, o) { return b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); };

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function humanSize(n) {
    if (n < 1024) return n + ' bytes';
    var units = ['KB', 'MB', 'GB', 'TB'], i = -1, v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
  }

  function humanDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return null;
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }

  // Reduce an aspect ratio to something a person recognises. Snaps to the
  // common ones within a small tolerance, because a 1919x1080 screenshot
  // should still read as 16:9 rather than 1919:1080.
  function aspectLabel(w, h) {
    if (!w || !h) return null;
    var known = [[16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [1, 1],
                 [21, 9], [5, 4], [16, 10], [2, 1], [1, 2]];
    var r = w / h;
    for (var i = 0; i < known.length; i++) {
      if (Math.abs(r - known[i][0] / known[i][1]) < 0.012) return known[i][0] + ':' + known[i][1];
    }
    return r.toFixed(2) + ':1';
  }

  // ---------------------------------------------------------------------
  // Type table
  //
  // family  — what the apps route on (see APPS above)
  // label   — what the report calls it
  // ---------------------------------------------------------------------

  var TYPES = [
    // --- images ---
    { id: 'png',  label: 'PNG image',   family: 'image', test: function (b) { return sigAt(b, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); } },
    { id: 'jpeg', label: 'JPEG image',  family: 'image', test: function (b) { return sigAt(b, 0, [0xFF, 0xD8, 0xFF]); } },
    { id: 'gif',  label: 'GIF image',   family: 'image', test: function (b) { return ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'; } },
    { id: 'webp', label: 'WebP image',  family: 'image', test: function (b) { return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP'; } },
    { id: 'bmp',  label: 'BMP image',   family: 'image', test: function (b) { return ascii(b, 0, 2) === 'BM'; } },
    { id: 'tiff', label: 'TIFF image',  family: 'image', test: function (b) { return sigAt(b, 0, [0x49, 0x49, 0x2A, 0x00]) || sigAt(b, 0, [0x4D, 0x4D, 0x00, 0x2A]); } },
    { id: 'ico',  label: 'Icon',        family: 'image', test: function (b) { return sigAt(b, 0, [0x00, 0x00, 0x01, 0x00]); } },
    { id: 'avif', label: 'AVIF image',  family: 'image', test: function (b) { return ascii(b, 4, 4) === 'ftyp' && /^(avif|avis)/.test(ascii(b, 8, 4)); } },
    { id: 'heic', label: 'HEIC image',  family: 'image', test: function (b) { return ascii(b, 4, 4) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)/.test(ascii(b, 8, 4)); } },
    { id: 'psd',  label: 'Photoshop document', family: 'other', test: function (b) { return ascii(b, 0, 4) === '8BPS'; } },

    // --- video ---
    { id: 'mp4',  label: 'MP4 video',   family: 'video', test: function (b) { return ascii(b, 4, 4) === 'ftyp' && /^(isom|iso2|mp41|mp42|avc1|dash|M4V )/.test(ascii(b, 8, 4)); } },
    { id: 'mov',  label: 'QuickTime video', family: 'video', test: function (b) { return ascii(b, 4, 4) === 'ftyp' && /^(qt  )/.test(ascii(b, 8, 4)); } },
    { id: 'webm', label: 'WebM / Matroska video', family: 'video', test: function (b) { return sigAt(b, 0, [0x1A, 0x45, 0xDF, 0xA3]); } },
    { id: 'avi',  label: 'AVI video',   family: 'video', test: function (b) { return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI '; } },
    { id: 'mpeg', label: 'MPEG video',  family: 'video', test: function (b) { return sigAt(b, 0, [0x00, 0x00, 0x01, 0xBA]) || sigAt(b, 0, [0x00, 0x00, 0x01, 0xB3]); } },
    { id: 'flv',  label: 'Flash video', family: 'video', test: function (b) { return ascii(b, 0, 3) === 'FLV'; } },

    // --- audio ---
    { id: 'wav',  label: 'WAV audio',   family: 'audio', test: function (b) { return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE'; } },
    { id: 'flac', label: 'FLAC audio',  family: 'audio', test: function (b) { return ascii(b, 0, 4) === 'fLaC'; } },
    { id: 'mp3',  label: 'MP3 audio',   family: 'audio', test: function (b) { return ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0); } },
    { id: 'm4a',  label: 'M4A audio',   family: 'audio', test: function (b) { return ascii(b, 4, 4) === 'ftyp' && /^(M4A |M4B )/.test(ascii(b, 8, 4)); } },
    // Ogg carries either; the codec inside decides, so it is resolved later.
    { id: 'ogg',  label: 'Ogg media',   family: 'audio', test: function (b) { return ascii(b, 0, 4) === 'OggS'; } },

    // --- documents ---
    { id: 'pdf',  label: 'PDF document', family: 'pdf', test: function (b) { return ascii(b, 0, 5) === '%PDF-'; } },
    { id: 'rtf',  label: 'Rich text document', family: 'rtf', test: function (b) { return ascii(b, 0, 5) === '{\\rtf'; } },
    // The old binary Office formats share one container signature; which
    // application wrote it is buried in the OLE streams, so the extension
    // is the only cheap way to tell them apart.
    { id: 'ole',  label: 'Legacy Office document', family: 'other', test: function (b) { return sigAt(b, 0, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]); } },

    // --- archives (ZIP is resolved further: docx/xlsx/pptx/epub live here) ---
    { id: 'zip',  label: 'ZIP archive', family: 'archive', test: function (b) { return sigAt(b, 0, [0x50, 0x4B]) && (b[2] === 3 || b[2] === 5 || b[2] === 7); } },
    { id: 'gzip', label: 'Gzip archive', family: 'archive', test: function (b) { return sigAt(b, 0, [0x1F, 0x8B]); } },
    { id: '7z',   label: '7-Zip archive', family: 'archive', test: function (b) { return sigAt(b, 0, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]); } },
    { id: 'rar',  label: 'RAR archive', family: 'archive', test: function (b) { return ascii(b, 0, 4) === 'Rar!'; } },
    { id: 'tar',  label: 'TAR archive', family: 'archive', test: function (b) { return ascii(b, 257, 5) === 'ustar'; } },

    // --- fonts ---
    { id: 'woff2', label: 'WOFF2 font', family: 'font', test: function (b) { return ascii(b, 0, 4) === 'wOF2'; } },
    { id: 'woff',  label: 'WOFF font',  family: 'font', test: function (b) { return ascii(b, 0, 4) === 'wOFF'; } },
    { id: 'otf',   label: 'OpenType font', family: 'font', test: function (b) { return ascii(b, 0, 4) === 'OTTO'; } },
    { id: 'ttf',   label: 'TrueType font', family: 'font', test: function (b) { return sigAt(b, 0, [0x00, 0x01, 0x00, 0x00]) || ascii(b, 0, 4) === 'true'; } },
  ];

  // ZIP members that identify what an Office-style ZIP really is.
  var ZIP_KINDS = [
    { id: 'docx', label: 'Word document',       family: 'docx',    has: 'word/document.xml' },
    { id: 'xlsx', label: 'Excel spreadsheet',   family: 'archive', has: 'xl/workbook.xml' },
    { id: 'pptx', label: 'PowerPoint presentation', family: 'archive', has: 'ppt/presentation.xml' },
    { id: 'epub', label: 'EPUB book',           family: 'archive', has: 'META-INF/container.xml' },
  ];

  // ---------------------------------------------------------------------
  // Text sniffing — only reached when nothing binary matched
  // ---------------------------------------------------------------------

  function looksLikeText(bytes) {
    // A NUL in the first block is the classic "this is binary" tell.
    var checked = Math.min(bytes.length, 1024), controls = 0;
    for (var i = 0; i < checked; i++) {
      var c = bytes[i];
      if (c === 0) return false;
      if (c < 9 || (c > 13 && c < 32)) controls++;
    }
    return checked === 0 || controls / checked < 0.05;
  }

  function sniffText(text, ext) {
    var head = text.slice(0, 4096);
    var trimmed = head.replace(/^﻿/, '').trim();

    if (/^<\?xml[^>]*\?>\s*<svg[\s>]/i.test(trimmed) || /^<svg[\s>]/i.test(trimmed)) {
      return { id: 'svg', label: 'SVG image', family: 'image' };
    }
    if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return { id: 'html', label: 'HTML page', family: 'text' };
    }
    if (/^<\?xml/i.test(trimmed)) {
      return { id: 'xml', label: 'XML document', family: 'text' };
    }
    if (/^BEGIN:VCALENDAR/i.test(trimmed)) return { id: 'ics', label: 'Calendar file', family: 'text' };
    if (/^BEGIN:VCARD/i.test(trimmed)) return { id: 'vcf', label: 'Contact card', family: 'text' };

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        var parsed = JSON.parse(text);
        // A .docu is JSON, so it can only be told apart by looking inside.
        // Checked by shape rather than by extension, so a renamed one is
        // still recognised.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            (Array.isArray(parsed.pageIds) || parsed.docWasOpen !== undefined || parsed.pageHtml)) {
          return { id: 'docu', label: 'DZDocu document', family: 'docu', json: parsed };
        }
        return { id: 'json', label: 'JSON data', family: 'text', json: parsed };
      } catch (e) {
        // Looked like JSON and wasn't. Fall through to plain text rather
        // than claiming a type we couldn't confirm.
      }
    }

    if (ext === 'csv' || ext === 'tsv') return { id: ext, label: ext.toUpperCase() + ' table', family: 'text' };
    if (ext === 'md') return { id: 'md', label: 'Markdown document', family: 'text' };
    // A comma-heavy first few lines with a consistent field count is a table
    // even when nobody named it .csv.
    var lines = head.split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 5);
    if (lines.length >= 2) {
      var counts = lines.map(function (l) { return l.split(',').length; });
      if (counts[0] > 1 && counts.every(function (c) { return c === counts[0]; })) {
        return { id: 'csv', label: 'CSV table', family: 'text' };
      }
    }
    return { id: 'txt', label: 'Plain text', family: 'text' };
  }

  // ---------------------------------------------------------------------
  // ZIP reading, with no library
  //
  // Enough of the format to list entries and pull one small member out.
  // Inflation uses DecompressionStream, which every current browser has;
  // where it doesn't exist we still list the entries and just skip the
  // metadata that needed decompressing.
  // ---------------------------------------------------------------------

  function findEocd(bytes) {
    // The end-of-central-directory record sits at the very end, unless
    // there's a trailing comment, so scan backwards over its maximum span.
    for (var i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function readZipIndex(file) {
    var tailLen = Math.min(file.size, 66000);
    return readBytes(file, file.size - tailLen, tailLen).then(function (tail) {
      var eocd = findEocd(tail);
      if (eocd < 0) return null;
      var count = u16le(tail, eocd + 10);
      var cdSize = u32le(tail, eocd + 12);
      var cdOffset = u32le(tail, eocd + 16);
      // Zip64 parks 0xFFFFFFFF here as a marker; reading it as a real
      // offset would send us somewhere meaningless.
      if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) return { entries: [], count: count, zip64: true };

      return readBytes(file, cdOffset, cdSize).then(function (cd) {
        var entries = [], p = 0;
        while (p + 46 <= cd.length && cd[p] === 0x50 && cd[p + 1] === 0x4B && cd[p + 2] === 0x01 && cd[p + 3] === 0x02) {
          var nameLen = u16le(cd, p + 28), extraLen = u16le(cd, p + 30), commentLen = u16le(cd, p + 32);
          entries.push({
            name: ascii(cd, p + 46, nameLen),
            method: u16le(cd, p + 10),
            compressed: u32le(cd, p + 20),
            size: u32le(cd, p + 24),
            offset: u32le(cd, p + 42),
          });
          p += 46 + nameLen + extraLen + commentLen;
        }
        return { entries: entries, count: count || entries.length, zip64: false };
      });
    }).catch(function () { return null; });
  }

  function readZipMember(file, entry) {
    if (!entry || entry.size > 4 * 1024 * 1024) return Promise.resolve(null);
    // The local header repeats the name and extra fields at their own
    // lengths, which is where the data actually starts -- the central
    // directory's lengths do not necessarily match.
    return readBytes(file, entry.offset, 30).then(function (lh) {
      if (!(lh[0] === 0x50 && lh[1] === 0x4B && lh[2] === 0x03 && lh[3] === 0x04)) return null;
      var dataAt = entry.offset + 30 + u16le(lh, 26) + u16le(lh, 28);
      return readBytes(file, dataAt, entry.compressed).then(function (data) {
        if (entry.method === 0) return new TextDecoder().decode(data);
        if (entry.method !== 8 || typeof DecompressionStream === 'undefined') return null;
        var ds = new DecompressionStream('deflate-raw');
        var stream = new Blob([data]).stream().pipeThrough(ds);
        return new Response(stream).text();
      });
    }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------------
  // Per-format detail extraction
  // ---------------------------------------------------------------------

  // Dimensions via the browser's own decoders, which handle every format it
  // can display without us parsing each one. Falls back to <img> where
  // createImageBitmap is unavailable or refuses the format.
  function imageSize(file) {
    var url = URL.createObjectURL(file);
    var done = function (v) { URL.revokeObjectURL(url); return v; };
    var viaImg = function () {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = function () { resolve(null); };
        img.src = url;
      });
    };
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file)
        .then(function (bmp) { var r = { w: bmp.width, h: bmp.height }; bmp.close && bmp.close(); return done(r); })
        .catch(function () { return viaImg().then(done); });
    }
    return viaImg().then(done);
  }

  // PNG's IHDR is fixed-position, so bit depth, colour model and whether an
  // alpha channel exists are all readable without decoding the image.
  function pngExtras(head) {
    var COLOR = { 0: 'Greyscale', 2: 'RGB', 3: 'Indexed colour', 4: 'Greyscale + alpha', 6: 'RGB + alpha' };
    var out = [];
    if (ascii(head, 12, 4) !== 'IHDR') return out;
    out.push(['Colour', (COLOR[head[25]] || 'Unknown') + ', ' + head[24] + '-bit']);
    // An acTL chunk before the first frame is what makes a PNG animated.
    for (var i = 8; i < head.length - 8; ) {
      var len = u32be(head, i), type = ascii(head, i + 4, 4);
      if (type === 'acTL') { out.push(['Animated', u32be(head, i + 8) + ' frames']); break; }
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + len;
      if (len < 0 || i <= 0) break;
    }
    return out;
  }

  // Walks GIF's block structure to count image descriptors, which is what a
  // frame is. Scanning for the 0x2C separator byte instead does NOT work --
  // 0x2C occurs constantly inside LZW-compressed pixel data, and a still
  // image happily reports hundreds of frames. Every block therefore has to
  // be stepped over at its real length.
  function gifFrames(b) {
    var p = 6;                                   // "GIF89a"
    if (p + 7 > b.length) return null;
    var packed = b[p + 4];
    p += 7;                                      // logical screen descriptor
    if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));   // global colour table

    var skipSubBlocks = function () {
      while (p < b.length) {
        var len = b[p++];
        if (!len) return;                        // block terminator
        p += len;
      }
    };

    var frames = 0;
    while (p < b.length) {
      var kind = b[p++];
      if (kind === 0x3B) break;                  // trailer
      if (kind === 0x21) {                       // extension: skip its payload
        p++;                                     // label
        skipSubBlocks();
      } else if (kind === 0x2C) {                // image descriptor -- a frame
        frames++;
        if (p + 9 > b.length) break;
        var local = b[p + 8];
        p += 9;
        if (local & 0x80) p += 3 * (1 << ((local & 7) + 1)); // local colour table
        p++;                                     // LZW minimum code size
        skipSubBlocks();
      } else {
        return null;                             // not a shape we understand
      }
    }
    return frames;
  }

  function gifExtras(bytes) {
    var frames = gifFrames(bytes);
    if (frames === null) return [];
    return [['Animated', frames > 1 ? 'yes, ' + frames + ' frames' : 'no']];
  }

  function webpExtras(head) {
    if (ascii(head, 12, 4) !== 'VP8X') return [];
    var flags = head[20];
    var out = [];
    if (flags & 0x02) out.push(['Animated', 'yes']);
    if (flags & 0x10) out.push(['Transparency', 'yes']);
    return out;
  }

  // --- EXIF ------------------------------------------------------------
  // Only IFD0 and the Exif sub-IFD, which is where everything a person
  // cares about lives. Deliberately tolerant: a malformed tag returns what
  // was read so far rather than throwing the whole report away.
  var EXIF_TAGS = {
    0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0132: 'DateTime',
    0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x013B: 'Artist', 0x8298: 'Copyright',
    0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8827: 'ISO', 0x9003: 'DateTimeOriginal',
    0x920A: 'FocalLength', 0xA434: 'LensModel', 0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension',
  };
  // Tags whose value is a fraction, so a SHORT pair can be read as one.
  var RATIONAL_TAGS = { 0x829A: 1, 0x829D: 1, 0x920A: 1 };
  var ORIENTATION = {
    1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored, 180°',
    5: 'Mirrored, 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored, 90° CW', 8: 'Rotated 90° CCW',
  };

  function parseExif(bytes) {
    var out = {};
    try {
      // Walk the JPEG segment chain to APP1 rather than assuming it is first.
      var p = 2;
      while (p + 4 < bytes.length && bytes[p] === 0xFF) {
        var marker = bytes[p + 1], segLen = u16be(bytes, p + 2);
        if (marker === 0xE1 && ascii(bytes, p + 4, 4) === 'Exif') { p = p + 10; break; }
        if (marker === 0xDA || marker === 0xD9) return out;
        p += 2 + segLen;
      }
      if (p + 8 > bytes.length) return out;

      var tiff = p;
      var be = ascii(bytes, tiff, 2) === 'MM';
      var r16 = be ? u16be : u16le, r32 = be ? u32be : u32le;
      if (r16(bytes, tiff + 2) !== 42) return out;

      var readIfd = function (offset, into) {
        if (offset + 2 > bytes.length) return;
        var n = r16(bytes, offset);
        for (var i = 0; i < n; i++) {
          var e = offset + 2 + i * 12;
          if (e + 12 > bytes.length) return;
          var tag = r16(bytes, e), type = r16(bytes, e + 2), count = r32(bytes, e + 4);
          var name = EXIF_TAGS[tag];
          if (!name) continue;
          var sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
          var byteLen = (sizes[type] || 1) * count;
          var at = byteLen <= 4 ? e + 8 : tiff + r32(bytes, e + 8);
          if (at + Math.min(byteLen, 64) > bytes.length) continue;

          if (type === 2) {
            into[name] = ascii(bytes, at, Math.min(count, 128)).replace(/\0.*$/, '').trim();
          } else if (type === 3 && count === 2 && RATIONAL_TAGS[tag]) {
            // A pair of SHORTs where the spec calls for a RATIONAL. Pillow
            // writes exposure, aperture and focal length this way, and it
            // is common enough on the web to be worth reading rather than
            // rejecting: taken literally the first SHORT alone turns 1/500s
            // into "1s" and f/2.8 into "f/28".
            //
            // Limited to tags that really are fractions. ISO is a SHORT that
            // some cameras write as an array, and dividing that pair would
            // invent a wrong number out of a correct file.
            var n2 = r16(bytes, at), d2 = r16(bytes, at + 2);
            into[name] = d2 ? n2 / d2 : n2;
          } else if (type === 3) {
            into[name] = r16(bytes, at);
          } else if (type === 4) {
            into[name] = r32(bytes, at);
          } else if (type === 5 || type === 10) {
            var num = r32(bytes, at), den = r32(bytes, at + 4);
            into[name] = den ? num / den : null;
          }
        }
      };

      readIfd(tiff + r32(bytes, tiff + 4), out);
      if (out.ExifIFD) readIfd(tiff + out.ExifIFD, out);
    } catch (e) { /* keep whatever was read */ }
    return out;
  }

  function exifRows(exif, dim) {
    var rows = [];
    var camera = [exif.Make, exif.Model].filter(Boolean).join(' ').trim();
    // Manufacturers often repeat the make inside the model ("NIKON D750"),
    // which reads badly once they are joined.
    if (camera && exif.Make && exif.Model && exif.Model.indexOf(exif.Make) === 0) camera = exif.Model;
    if (camera) rows.push(['Camera', camera]);
    if (exif.LensModel) rows.push(['Lens', exif.LensModel]);
    var taken = exif.DateTimeOriginal || exif.DateTime;
    if (taken) rows.push(['Taken', String(taken).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')]);

    var shot = [];
    if (exif.ExposureTime) {
      shot.push(exif.ExposureTime >= 1 ? exif.ExposureTime + 's' : '1/' + Math.round(1 / exif.ExposureTime) + 's');
    }
    if (exif.FNumber) shot.push('f/' + (Math.round(exif.FNumber * 10) / 10));
    if (exif.ISO) shot.push('ISO ' + exif.ISO);
    if (exif.FocalLength) shot.push(Math.round(exif.FocalLength) + 'mm');
    if (shot.length) rows.push(['Settings', shot.join('  ·  ')]);

    if (exif.Orientation && exif.Orientation !== 1) {
      var turn = ORIENTATION[exif.Orientation] || String(exif.Orientation);
      // For the quarter turns, the dimensions reported above are the ones
      // the picture DISPLAYS at -- the browser applies the flag while
      // decoding -- and they are the transpose of what the file stores.
      // Naming both stops that looking like a mistake.
      if (dim && dim.w && exif.Orientation >= 5 && exif.Orientation <= 8) {
        turn += ' — stored as ' + dim.h.toLocaleString() + ' × ' + dim.w.toLocaleString();
      }
      rows.push(['Orientation', turn]);
    }
    if (exif.Artist) rows.push(['Artist', exif.Artist]);
    if (exif.Copyright) rows.push(['Copyright', exif.Copyright]);
    // Only that location data EXISTS -- the coordinates themselves are
    // deliberately not shown or read.
    if (exif.GPSIFD) rows.push(['Location', 'GPS data present']);
    return rows;
  }

  // --- media -----------------------------------------------------------
  function mediaInfo(file, isVideo) {
    return new Promise(function (resolve) {
      var el = document.createElement(isVideo ? 'video' : 'audio');
      var url = URL.createObjectURL(file);
      var settled = false;
      var finish = function (v) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        el.removeAttribute('src');
        resolve(v);
      };
      el.preload = 'metadata';
      el.onloadedmetadata = function () {
        finish({ duration: el.duration, w: el.videoWidth || 0, h: el.videoHeight || 0 });
      };
      el.onerror = function () { finish(null); };
      // A codec the browser can't decode never fires either event, and an
      // unresolved promise here would hang the whole report.
      setTimeout(function () { finish(null); }, 6000);
      el.src = url;
    });
  }

  // --- PDF -------------------------------------------------------------
  // pdf.js is already on this site for DZDocu, so a PDF gets a real page
  // count and its metadata. Loaded on demand: most drops are not PDFs and
  // this is ~320KB plus a worker.
  var pdfLoading = null;
  function ensurePdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfLoading) return pdfLoading;
    pdfLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'dzdocu/assets/pdf.min.js';
      s.onload = function () {
        if (!global.pdfjsLib) return reject(new Error('pdf.js did not register'));
        // pdf.js refuses a worker whose build does not match exactly; this
        // is the worker from the same build, which is why it is taken from
        // the same folder rather than a CDN.
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'dzdocu/assets/pdf.worker.min.js';
        resolve(global.pdfjsLib);
      };
      s.onerror = function () { reject(new Error('could not load pdf.js')); };
      document.head.appendChild(s);
    });
    return pdfLoading;
  }

  function pdfInfo(file) {
    return ensurePdfJs().then(function (lib) {
      return file.arrayBuffer().then(function (buf) {
        return lib.getDocument({ data: buf }).promise;
      });
    }).then(function (doc) {
      var rows = [['Pages', String(doc.numPages)]];
      return doc.getMetadata().then(function (meta) {
        var info = (meta && meta.info) || {};
        if (info.Title) rows.push(['Title', info.Title]);
        if (info.Author) rows.push(['Author', info.Author]);
        if (info.Producer) rows.push(['Made with', info.Producer]);
        if (info.IsEncrypted) rows.push(['Protected', 'yes']);
        return doc.getPage(1);
      }, function () { return doc.getPage(1); }).then(function (page) {
        var vp = page.getViewport({ scale: 1 });
        // PDF units are 72 to the inch, which is what makes this readable
        // as paper sizes rather than as arbitrary numbers.
        var wIn = vp.width / 72, hIn = vp.height / 72;
        var named = pageSizeName(wIn, hIn);
        rows.push(['Page size', (Math.round(wIn * 100) / 100) + ' × ' + (Math.round(hIn * 100) / 100) + ' in' +
          (named ? '  (' + named + ')' : '') + (vp.width > vp.height ? ', landscape' : ', portrait')]);
        return rows;
      }).catch(function () { return rows; });
    });
  }

  function pageSizeName(wIn, hIn) {
    var w = Math.min(wIn, hIn), h = Math.max(wIn, hIn);
    var near = function (a, b) { return Math.abs(a - b) < 0.12; };
    if (near(w, 8.5) && near(h, 11)) return 'Letter';
    if (near(w, 8.5) && near(h, 14)) return 'Legal';
    if (near(w, 11) && near(h, 17)) return 'Tabloid';
    if (near(w, 8.27) && near(h, 11.69)) return 'A4';
    if (near(w, 5.83) && near(h, 8.27)) return 'A5';
    if (near(w, 11.69) && near(h, 16.54)) return 'A3';
    if (near(w, 4) && near(h, 6)) return '4×6 label';
    return null;
  }

  // --- Office ----------------------------------------------------------
  // Word and friends write a summary into docProps/app.xml when they save.
  // It is not always there (files written by other tools often omit it),
  // so everything below is best-effort.
  function officeInfo(file, index) {
    var byName = {};
    index.entries.forEach(function (e) { byName[e.name] = e; });
    var pick = function (n) { return byName[n]; };

    return Promise.all([
      readZipMember(file, pick('docProps/app.xml')),
      readZipMember(file, pick('docProps/core.xml')),
    ]).then(function (res) {
      var app = res[0] || '', core = res[1] || '', rows = [];
      var tag = function (xml, name) {
        var m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>').exec(xml || '');
        return m ? m[1].trim() : null;
      };
      var title = tag(core, 'dc:title');
      var creator = tag(core, 'dc:creator');
      var modified = tag(core, 'dcterms:modified');

      var pages = tag(app, 'Pages'), words = tag(app, 'Words'), chars = tag(app, 'Characters');
      var slides = tag(app, 'Slides'), sheets = null;
      if (pages) rows.push(['Pages', pages]);
      if (slides) rows.push(['Slides', slides]);
      if (words) rows.push(['Words', Number(words).toLocaleString()]);
      if (chars && !words) rows.push(['Characters', Number(chars).toLocaleString()]);
      if (title) rows.push(['Title', title]);
      if (creator) rows.push(['Author', creator]);
      if (tag(app, 'Application')) rows.push(['Made with', tag(app, 'Application')]);
      if (modified) rows.push(['Last saved', modified.replace('T', ' ').replace('Z', ' UTC')]);

      // Sheet names live in the workbook rather than in docProps.
      if (byName['xl/workbook.xml']) {
        return readZipMember(file, byName['xl/workbook.xml']).then(function (wb) {
          var names = [];
          (wb || '').replace(/<sheet[^>]*name="([^"]*)"/g, function (_, n) { names.push(n); return _; });
          if (names.length) {
            rows.push(['Sheets', names.length + (names.length <= 6 ? ':  ' + names.join(', ') : '')]);
          }
          return rows;
        }).catch(function () { return rows; });
      }
      return rows;
    }).catch(function () { return []; });
  }

  // --- text ------------------------------------------------------------
  function textInfo(text, bytes) {
    var rows = [];
    var lines = text.split(/\r\n|\r|\n/).length;
    var words = (text.match(/\S+/g) || []).length;
    rows.push(['Lines', lines.toLocaleString()]);
    rows.push(['Words', words.toLocaleString()]);
    rows.push(['Characters', text.length.toLocaleString()]);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) rows.push(['Encoding', 'UTF-8 with BOM']);
    else if (/[-￿]/.test(text)) rows.push(['Encoding', 'UTF-8']);
    else rows.push(['Encoding', 'ASCII']);
    rows.push(['Line endings', /\r\n/.test(text) ? 'Windows (CRLF)' : /\r/.test(text) ? 'Classic Mac (CR)' : 'Unix (LF)']);
    return rows;
  }

  function docuInfo(json) {
    var rows = [];
    if (Array.isArray(json.pageIds)) rows.push(['Pages', String(json.pageIds.length)]);
    if (json.docTitle) rows.push(['Title', json.docTitle]);
    if (json.defaultSize) {
      rows.push(['Page size', String(json.defaultSize) +
        (json.defaultOrientation ? ', ' + json.defaultOrientation : '')]);
    }
    if (json.savedAt) rows.push(['Saved', new Date(json.savedAt).toLocaleString()]);
    var pdfPages = json.pdfPageIds ? Object.keys(json.pdfPageIds).length : 0;
    if (pdfPages) rows.push(['Imported PDF pages', String(pdfPages)]);
    return rows;
  }

  function archiveInfo(index) {
    if (!index) return [];
    var rows = [['Items', String(index.count)]];
    var total = index.entries.reduce(function (a, e) { return a + e.size; }, 0);
    if (total) rows.push(['Unpacked size', humanSize(total)]);
    var names = index.entries
      .filter(function (e) { return !/\/$/.test(e.name); })
      .slice(0, 5).map(function (e) { return e.name; });
    if (names.length) {
      rows.push(['Contains', names.join(', ') + (index.entries.length > names.length ? ', …' : '')]);
    }
    return rows;
  }

  // ---------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------

  function inspect(file) {
    var result = {
      name: file.name || 'Untitled',
      size: file.size,
      sizeText: humanSize(file.size),
      modified: file.lastModified ? new Date(file.lastModified) : null,
      browserType: file.type || '',
      ext: extOf(file.name),
      id: 'unknown',
      label: 'Unrecognised file',
      family: 'other',
      details: [],
      notes: [],
      apps: [],
    };

    if (file.size === 0) {
      result.label = 'Empty file';
      result.notes.push('This file has no contents.');
      return Promise.resolve(result);
    }

    // 4KB covers every signature here and is enough for PNG chunk walking
    // and the head of a text file, without reading a huge file into memory.
    return readBytes(file, 0, 4096).then(function (head) {
      var match = null;
      for (var i = 0; i < TYPES.length; i++) {
        if (TYPES[i].test(head)) { match = TYPES[i]; break; }
      }

      // Text formats have no signature, so they are only reached once every
      // binary test has declined.
      if (!match && looksLikeText(head)) {
        return file.slice(0, 512 * 1024).text().then(function (text) {
          var t = sniffText(text, result.ext);
          result.id = t.id; result.label = t.label; result.family = t.family;
          if (t.id === 'docu') { result.details = docuInfo(t.json); return result; }
          if (t.id === 'svg') return svgDetails(file, text, result);
          if (t.id === 'json') {
            result.details = [['Top-level keys', Object.keys(t.json || {}).length + ''],
                              ['Characters', text.length.toLocaleString()]];
            return result;
          }
          return file.slice(0, 2 * 1024 * 1024).text().then(function (full) {
            result.details = textInfo(full, head);
            if (file.size > 2 * 1024 * 1024) result.notes.push('Counts are for the first 2 MB.');
            return result;
          });
        });
      }

      if (!match) {
        result.notes.push('The contents do not match any format this page knows.');
        if (result.ext) result.details.push(['Extension', '.' + result.ext]);
        return result;
      }

      result.id = match.id;
      result.label = match.label;
      result.family = match.family;
      return addDetails(file, head, result);
    }).catch(function (err) {
      result.notes.push('Could not read this file: ' + (err && err.message ? err.message : err));
      return result;
    });
  }

  function svgDetails(file, text, result) {
    var m = /<svg[^>]*>/i.exec(text);
    var tagText = m ? m[0] : '';
    var w = /\bwidth="([^"]+)"/i.exec(tagText), h = /\bheight="([^"]+)"/i.exec(tagText);
    var vb = /\bviewBox="([^"]+)"/i.exec(tagText);
    if (w && h) result.details.push(['Size', w[1] + ' × ' + h[1]]);
    else if (vb) {
      var p = vb[1].trim().split(/[\s,]+/);
      if (p.length === 4) result.details.push(['Size', p[2] + ' × ' + p[3] + ' (from viewBox)']);
    }
    if (vb) result.details.push(['viewBox', vb[1]]);
    return result;
  }

  function addDetails(file, head, result) {
    var fam = result.family, id = result.id;

    if (fam === 'image') {
      return imageSize(file).then(function (dim) {
        if (dim && dim.w) {
          result.details.push(['Dimensions', dim.w.toLocaleString() + ' × ' + dim.h.toLocaleString() + ' px']);
          var ar = aspectLabel(dim.w, dim.h);
          if (ar) result.details.push(['Aspect', ar]);
          result.details.push(['Megapixels', (dim.w * dim.h / 1e6).toFixed(1) + ' MP']);
        } else {
          result.notes.push('This browser could not decode the image, so its size is unknown.');
        }
        if (id === 'png') pngExtras(head).forEach(function (r) { result.details.push(r); });
        if (id === 'gif') {
          // Frame counting needs the whole file, not just the head.
          return readBytes(file, 0, Math.min(file.size, 8 * 1024 * 1024)).then(function (all) {
            gifExtras(all).forEach(function (r) { result.details.push(r); });
            return result;
          });
        }
        if (id === 'webp') webpExtras(head).forEach(function (r) { result.details.push(r); });
        if (id === 'jpeg') {
          // EXIF sits early, but some cameras write a large thumbnail into
          // APP1, so read more than the 4KB head.
          return readBytes(file, 0, Math.min(file.size, 256 * 1024)).then(function (big) {
            exifRows(parseExif(big), dim).forEach(function (r) { result.details.push(r); });
            return result;
          });
        }
        if (id === 'heic') result.notes.push('Most browsers cannot display HEIC. Converting to JPEG first is usually easier.');
        return result;
      });
    }

    if (fam === 'video' || fam === 'audio') {
      return mediaInfo(file, fam === 'video').then(function (info) {
        if (!info) {
          result.notes.push('This browser could not decode the media, so length is unknown. It may still open in the app.');
          return result;
        }
        var dur = humanDuration(info.duration);
        if (dur) result.details.push(['Length', dur]);
        if (info.w) {
          result.details.push(['Dimensions', info.w + ' × ' + info.h + ' px']);
          var ar = aspectLabel(info.w, info.h);
          if (ar) result.details.push(['Aspect', ar]);
          var tall = info.h > info.w;
          result.details.push(['Orientation', tall ? 'Portrait (phone video)' : 'Landscape']);
        } else if (fam === 'video') {
          // An Ogg or MP4 container with no video track is really audio.
          result.family = 'audio';
          result.label = result.label.replace('video', 'audio');
        }
        if (info.duration > 0 && file.size) {
          var kbps = (file.size * 8) / info.duration / 1000;
          result.details.push(['Bitrate', kbps > 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : Math.round(kbps) + ' kbps']);
        }
        return result;
      });
    }

    if (fam === 'pdf') {
      result.details.push(['Version', 'PDF ' + ascii(head, 5, 3)]);
      return pdfInfo(file).then(function (rows) {
        rows.forEach(function (r) { result.details.push(r); });
        return result;
      }).catch(function (err) {
        result.notes.push('Could not read inside the PDF (' + (err.message || err) + '), so page count is unknown.');
        return result;
      });
    }

    if (id === 'zip') {
      return readZipIndex(file).then(function (index) {
        if (!index) { result.notes.push('The archive index could not be read.'); return result; }
        var names = {};
        index.entries.forEach(function (e) { names[e.name] = true; });
        var kind = null;
        for (var i = 0; i < ZIP_KINDS.length; i++) {
          if (names[ZIP_KINDS[i].has]) { kind = ZIP_KINDS[i]; break; }
        }
        if (kind) {
          result.id = kind.id; result.label = kind.label; result.family = kind.family;
          return officeInfo(file, index).then(function (rows) {
            rows.forEach(function (r) { result.details.push(r); });
            if (!rows.length) result.notes.push('This file carries no summary information, so there is little to report.');
            if (kind.id === 'xlsx' || kind.id === 'pptx') {
              result.notes.push('None of the three apps open this format.');
            }
            return result;
          });
        }
        archiveInfo(index).forEach(function (r) { result.details.push(r); });
        return result;
      });
    }

    if (fam === 'archive') { archiveInfo(null).forEach(function (r) { result.details.push(r); }); return Promise.resolve(result); }

    if (id === 'ole') {
      // Which Office application wrote it is only recoverable from the OLE
      // streams; the extension is the cheap answer and is usually right.
      var byExt = { doc: 'Word', xls: 'Excel', ppt: 'PowerPoint' };
      if (byExt[result.ext]) {
        result.label = 'Legacy ' + byExt[result.ext] + ' document (.' + result.ext + ')';
      }
      result.notes.push('This is the pre-2007 Office format. Saving it as .docx first will open in DZDocu.');
      return Promise.resolve(result);
    }

    if (fam === 'rtf') {
      return file.slice(0, 1024 * 1024).text().then(function (text) {
        var words = (text.replace(/\{\\[^{}]*\}/g, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').match(/\S+/g) || []).length;
        result.details.push(['Words', 'about ' + words.toLocaleString()]);
        return result;
      }).catch(function () { return result; });
    }

    return Promise.resolve(result);
  }

  // Runs after inspect so it sees the family as finally resolved -- a ZIP
  // that turned out to be a .docx, or a video container holding only audio.
  function withApps(result) {
    result.apps = appsFor(result.family);
    return result;
  }

  function inspectAll(files) {
    return Promise.all(Array.prototype.map.call(files, function (f) {
      return inspect(f).then(withApps);
    }));
  }

  global.DZDetect = {
    inspect: function (f) { return inspect(f).then(withApps); },
    inspectAll: inspectAll,
    apps: APPS,
    humanSize: humanSize,
  };
})(window);
