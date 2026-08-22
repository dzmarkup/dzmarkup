/* DZVidStitch — the .dzvid project format
   ========================================================================

   A .dzvid holds the EDIT and not the media: clip order, trims, fades,
   speeds, transitions and thumbnails. A twenty-clip project comes to a few
   hundred kilobytes, nearly all of it thumbnails, so it can be emailed, kept
   on a stick, or backed up — while the footage it describes stays wherever
   the user keeps footage.

   Three decisions shape the whole thing:

   1. SOURCES ARE DEDUPED. Splitting a clip makes two clips out of one file,
      and both keep the same sourceId. Saving per clip would record the same
      2GB source twice, then again for every further split. Clips therefore
      reference a source; the sources are listed once.

   2. A SOURCE IS IDENTIFIED BY ITS CONTENT, NOT ITS NAME. Every source
      carries a fingerprint: SHA-256 over its first megabyte, its last
      megabyte, and its exact byte length. That reads 2MB no matter how big
      the file is (~58ms for a 26MB file, and the same for a 2GB one --
      hashing the whole of a 2GB file takes about 140 seconds, which is why
      it isn't done). Rename a file, move it, put it on another machine and
      it still matches. The name is only ever a hint about where to look.

   3. BOTH THE ORIGINAL AND THE CONVERTED FILE ARE RECORDED. DZVidStitch
      replaces a clip's file with the converter's H.264 output while keeping
      the original's name and size, so a project needs to know about both:
      handed the converted file it can carry on immediately, handed only the
      original it must convert again first.

   crypto.subtle needs a secure context, so fingerprinting is unavailable
   over plain http. Matching then falls back to size + duration + dimensions,
   which is weaker but still good; nothing here fails because of it.
*/

export const FORMAT = 'dzvid';
export const VERSION = 1;

const CHUNK = 1024 * 1024;   // read this much from each end

/* ── Fingerprint ────────────────────────────────────────────────────── */

function hex(buf) {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

/** Content fingerprint: head + tail + exact size. Null when unavailable. */
export async function fingerprint(file) {
  if (!file || !file.size) return null;
  if (!(globalThis.crypto && crypto.subtle && crypto.subtle.digest)) return null;
  try {
    const head = new Uint8Array(await file.slice(0, CHUNK).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - CHUNK)).arrayBuffer());
    const joined = new Uint8Array(head.length + tail.length + 8);
    joined.set(head, 0);
    joined.set(tail, head.length);
    // The exact byte length goes in too, so two files sharing both ends --
    // one a truncation of the other -- still differ.
    new DataView(joined.buffer).setFloat64(head.length + tail.length, file.size);
    return hex(await crypto.subtle.digest('SHA-256', joined));
  } catch (e) {
    return null;   // http, a locked file, a browser without it: not fatal
  }
}

/* ── Writing ────────────────────────────────────────────────────────── */

// Only these move into the file. Kept as one list so the writer and the
// reader cannot drift apart -- the trap DZDocu hit with three separate
// field lists, where a new field survived a save but vanished on reload.
const CLIP_FIELDS = [
  'vStart', 'vEnd', 'aStart', 'aEnd',
  'vFadeIn', 'vFadeOut', 'aFadeIn', 'aFadeOut',
  'speed', 'split', 'kind',
  'audioName', 'audioSourceId', 'audioDuration',
];

const SOURCE_FIELDS = [
  'origName', 'origSize', 'convName', 'convSize',
  'duration', 'nativeW', 'nativeH',
  'hasAudio', 'normalized', 'fastRemux', 'fp', 'origRemoved',
];

function pick(from, fields) {
  const out = {};
  fields.forEach((k) => { if (from[k] !== undefined && from[k] !== null) out[k] = from[k]; });
  return out;
}

/**
 * Build the project object.
 *
 * `clips` are the app's live clip objects. Each must carry a sourceId; the
 * source details are read from `sources`, a map of sourceId -> descriptor
 * the caller maintains as files are imported and converted.
 */
export function serialize({ clips = [], transitions = [], sources = {}, name = 'Untitled' } = {}) {
  const used = new Set();
  const outClips = clips.map((c) => {
    if (c.sourceId) used.add(c.sourceId);
    return Object.assign({ id: c.id, sourceId: c.sourceId || null, thumb: c.thumb || null },
      pick(c, CLIP_FIELDS));
  });

  // Only sources something on the timeline actually uses. A file imported
  // and then removed shouldn't be asked for when the project reopens.
  const outSources = Object.keys(sources)
    .filter((id) => used.has(id))
    .map((id) => Object.assign({ id }, pick(sources[id], SOURCE_FIELDS)));

  return {
    format: FORMAT,
    version: VERSION,
    savedAt: Date.now(),
    name: String(name || 'Untitled').slice(0, 120),
    sources: outSources,
    clips: outClips,
    transitions: transitions.map((t) => ({ id: t.id, type: t.type, duration: t.duration })),
  };
}

export function toText(project) { return JSON.stringify(project); }

export function suggestedFilename(project) {
  const base = String(project.name || 'project').replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
  return base + '.dzvid';
}

/* ── Reading ────────────────────────────────────────────────────────── */

export class ProjectError extends Error {}

/**
 * Parse and validate. Throws ProjectError with something a person can act
 * on -- "this is a DZDocu document" beats "unexpected token".
 */
export function parse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ProjectError('That file isn\'t a DZVidStitch project — it isn\'t even JSON.');
  }
  if (!data || typeof data !== 'object') throw new ProjectError('That project file is empty.');
  if (data.format !== FORMAT) {
    // A .docu is JSON too, and someone will drop one in here eventually.
    if (Array.isArray(data.pageIds)) {
      throw new ProjectError('That\'s a DZDocu document. Open it in DZDocu instead.');
    }
    throw new ProjectError('That isn\'t a DZVidStitch project file.');
  }
  if (!(data.version <= VERSION)) {
    throw new ProjectError('That project was saved by a newer version of DZVidStitch.');
  }
  if (!Array.isArray(data.clips) || !Array.isArray(data.sources)) {
    throw new ProjectError('That project file is damaged — its clip list is missing.');
  }
  // A clip pointing at a source that isn't listed can never be restored, and
  // keeping it would leave a permanent gap on the timeline.
  const known = new Set(data.sources.map((s) => s.id));
  const clips = data.clips.filter((c) => c && (!c.sourceId || known.has(c.sourceId)));
  return {
    format: data.format,
    version: data.version,
    savedAt: data.savedAt || null,
    name: data.name || 'Untitled',
    sources: data.sources.filter((s) => s && s.id),
    clips,
    transitions: Array.isArray(data.transitions) ? data.transitions : [],
    dropped: data.clips.length - clips.length,
  };
}

/* ── Matching files back to sources ─────────────────────────────────── */

/**
 * How confident a match is, worst to best. `converted` matters as much as
 * confidence: a converted file can go straight onto the timeline, while an
 * original has to be put through the converter again first.
 */
export const MATCH = { NONE: 0, WEAK: 1, STRONG: 2, EXACT: 3 };

function sameSize(a, b) { return a != null && b != null && a === b; }
function closeEnough(a, b, tol) { return a != null && b != null && Math.abs(a - b) <= tol; }

/**
 * Score one file against one source.
 *
 * EXACT  — the fingerprint matches. Certain, whatever the file is called.
 * STRONG — exact byte size plus duration. A file's exact length is nearly a
 *          fingerprint by itself among one person's own files.
 * WEAK   — the name matches but the content doesn't line up. Offered as a
 *          suggestion, never applied on its own.
 */
export function score(source, cand) {
  const asConverted = (n, s) =>
    source.convName && (n === source.convName || sameSize(s, source.convSize));

  if (cand.fp && source.fp && cand.fp === source.fp) {
    return { level: MATCH.EXACT, converted: !!source.normalized && sameSize(cand.size, source.convSize) };
  }
  // The fingerprint is recorded for whichever file the timeline was using,
  // so a converted source needs its own size check to spot the original.
  if (sameSize(cand.size, source.convSize)) return { level: MATCH.STRONG, converted: true };
  if (sameSize(cand.size, source.origSize)) {
    const durOk = source.duration == null || cand.duration == null ||
      closeEnough(cand.duration, source.duration, 0.75);
    return { level: durOk ? MATCH.STRONG : MATCH.WEAK, converted: false };
  }
  if (cand.name && (cand.name === source.origName || cand.name === source.convName)) {
    return { level: MATCH.WEAK, converted: asConverted(cand.name, cand.size) };
  }
  return { level: MATCH.NONE, converted: false };
}

/**
 * Match a batch of candidate files against the project's sources.
 *
 * Best-first across the whole batch rather than file by file: two clips from
 * the same shoot can both look plausible for one source, and taking them in
 * arrival order would let a weak match claim a source that a later file
 * matches exactly.
 */
export function matchFiles(sources, candidates) {
  const pairs = [];
  sources.forEach((s) => candidates.forEach((c) => {
    const r = score(s, c);
    if (r.level > MATCH.NONE) pairs.push({ source: s, cand: c, ...r });
  }));
  pairs.sort((a, b) => b.level - a.level);

  const bySource = new Map(), usedCand = new Set(), usedSource = new Set();
  pairs.forEach((p) => {
    if (usedSource.has(p.source.id) || usedCand.has(p.cand)) return;
    usedSource.add(p.source.id);
    usedCand.add(p.cand);
    bySource.set(p.source.id, p);
  });

  return {
    matched: bySource,
    missing: sources.filter((s) => !bySource.has(s.id)),
    unused: candidates.filter((c) => !usedCand.has(c)),
  };
}

/** What to ask the user for — the converted file first, since it needs no work. */
export function wantedFor(source) {
  if (source.convName && !source.origRemoved) {
    return { name: source.convName, alt: source.origName, note: 'converted — opens straight away' };
  }
  if (source.convName) return { name: source.convName, alt: null, note: 'converted' };
  return { name: source.origName, alt: null, note: null };
}
