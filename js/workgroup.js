// workgroup.js
// Depends on: config, state, utils, aliases

/* ═══════════════════════════════════════════════════════════════════
   WORK / MOVEMENT PARSING
   ═══════════════════════════════════════════════════════════════════
   A movement marker is one or more roman numeral letters (I, V, X
   only — L, C, D, M are too ambiguous, appearing in catalogue
   abbreviations like D.960 or M.76) OR arabic digits, followed by
   ".", ")", or ":", then whitespace, then a non-space. The leading \s
   ensures a title that *is* a movement (no work prefix) is left
   ungrouped.
   ────────────────────────────────────────────────────────────────── */

const MOVEMENT_RE = /\s(?:[IVX]+[a-z]?[.)]|\d+[a-z]?[.)])\s+\S/;

// A movement title that begins with its own numeral — "I. Allegro",
// "2) Andante", "III: Presto". Symphonies and concertos use this
// form; the track-number column would just repeat what's already in
// the title.
//
// The trailing \s matters: "X" alone (a name, not a marker) doesn't
// match, and neither does "Violin Romance No. 1" — the V doesn't
// reach a separator.
const LEADING_MOVEMENT_NUMBER_RE = /^(?:[IVX]+|\d+)[a-z]?[.):]\s/;

function movementCarriesOwnNumber(title) {
  return LEADING_MOVEMENT_NUMBER_RE.test(title || '');
}

// Find a section label anywhere inside a prefix. "Book 1" matches at
// the start; "Das Wohltemperierte Klavier, Book 1, BWV 846-869"
// matches at the tail. Returns the section string or null.
function extractSection(prefix) {
  const m = prefix.match(
    /\b(act|book|part|volume|vol|disc|disk|cd|scene)\s+(\d+|[IVX]+)([,;].*)?$/i
  );
  return m ? m[0].trim() : null;
}

// Simple lookup — movements never exceed XX in practice.
const ROMAN_NUMERALS = [
  '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'
];

function arabicToRoman(n) {
  if (n >= 1 && n < ROMAN_NUMERALS.length) return ROMAN_NUMERALS[n];
  // Fallback for numbers outside the common range.
  const map = [
    [1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
    [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']
  ];
  let out = '';
  for (const [v, s] of map) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}

// Rewrite a leading arabic movement numeral to roman. Only affects
// `1.`, `2.`, `10)` etc. at the very start of the movement string.
// Roman numerals and unnumbered movements pass through untouched.
function romanizeMovement(movement) {
  const m = movement.match(/^(\d+)([a-z]?)([.):])/);
  if (!m) return movement;
  return arabicToRoman(parseInt(m[1], 10)) + m[2] + m[3]
       + movement.slice(m[0].length);
}

function parseWorkAndMovement(trackNode, albumComposer) {
  const work  = (trackNode.getAttribute('work') || '').trim();
  const title = (trackNode.getAttribute('song')
              || trackNode.getAttribute('name')
              || '').trim();

  // 1. Explicit work tag — authoritative.
  if (work) {
    const escaped = work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRe = new RegExp(`^${escaped}\\s*[:\\-–—]\\s*`);
    const movement = title.replace(prefixRe, '').trim() || title;
    return { work, movement, isSection: false };
  }

  // 2. Movement marker — "Symphony No. 5: I. Allegro",
  //    "Concerto: 1. Allegro", "Op. 78 'Organ': 1a. Adagio".
  const m = title.match(MOVEMENT_RE);
  if (m && m.index > 0) {
    const rawWork  = title.slice(0, m.index).trim();
    const movement = romanizeMovement(title.slice(m.index).trim());

    const cleaned = rawWork
      .replace(/\s+No\.?\s*$/i, '')
      .replace(/[\s\-–—:,]+$/, '')
      .trim();

    const insideLabel = /[A-Za-z]\.$/.test(rawWork);

    if (cleaned && movement && !insideLabel) {
      return { work: cleaned, movement, isSection: false };
    }
  }

  // 3. Spaced-hyphen separator, gated on a catalogue number at the
  //    end of the prefix. Must run BEFORE the colon branches so a
  //    title with both separators — "Symphony No 38, K.504 - Finale:
  //    Presto" — splits at the hyphen, not the inner colon.
  const hyphenMatch = title.match(/^(.*?)\s+-\s+(.+)$/);
  if (hyphenMatch) {
    const prefix = hyphenMatch[1].trim();
    const suffix = hyphenMatch[2].trim();

    const CATALOGUE_END = /\b(?:K|Op|BWV|D|RV|Hob|TH|WoO|HWV|Wq|B)\.?\s*\d+[a-z]?$/i;

    if (prefix && suffix && CATALOGUE_END.test(prefix)) {
      const pc = canonicalComposer(prefix).toLowerCase();
      const ac = canonicalComposer(albumComposer || '').toLowerCase();
      if (albumComposer && pc === ac) {
        return { work: null, movement: title, isSection: false };
      }
      return { work: prefix, movement: suffix, isSection: false };
    }
  }

  // 4. Colon branches. indexOf/lastIndexOf avoid allocating a regex
  //    match array just to count separators.
  const firstColonIdx = title.indexOf(':');
  if (firstColonIdx !== -1) {
    const lastColonIdx = title.lastIndexOf(':');

    // 4a. Section-in-middle: "Outer: Book 1: Movement".
    if (firstColonIdx !== lastColonIdx) {
      const prefixLast = title.slice(0, lastColonIdx).trim();
      const suffixLast = title.slice(lastColonIdx + 1).trim();

      if (prefixLast && suffixLast && extractSection(prefixLast)) {
        return { work: prefixLast, movement: suffixLast, isSection: false };
      }
    }

    // 4b. Default: split at the first colon.
    const prefix = title.slice(0, firstColonIdx).trim();
    const suffix = title.slice(firstColonIdx + 1).trim();

    if (prefix && suffix) {
      const pc = canonicalComposer(prefix).toLowerCase();
      const ac = canonicalComposer(albumComposer || '').toLowerCase();
      if (albumComposer && pc === ac) {
        return { work: null, movement: title, isSection: false };
      }

      const section = extractSection(prefix);
      return {
        work:      section || prefix,
        movement:  suffix,
        isSection: !!section,
      };
    }
  }

  // 5. No structure — render flat.
  return { work: null, movement: title, isSection: false };
}

/* ═══════════════════════════════════════════════════════════════════
   COMPOSER PREFIX EXTRACTION
   ═══════════════════════════════════════════════════════════════════
   Work titles sometimes carry the composer as a prefix —
   "Tchaikovsky: Violin Concerto in D Major, Op. 35". When the album
   has a composer tag, and the prefix matches it, the prefix is
   redundant and gets stripped (displayed as the eyebrow instead).
   When the album has no composer tag, the prefix is the only
   source of composer information — strip and promote it.

   Returns { composer, title }:
     composer — best-known composer for the block (may be '')
     title    — work title, prefix removed when applicable
   ────────────────────────────────────────────────────────────────── */

const COMPOSER_PREFIX_RE = /^(.+?)(?:\s*:\s*|\s+[-–—]\s+)(.+)$/;

function extractComposerPrefix(work, knownComposer) {
  const fallback = { composer: knownComposer || '', title: work };
  if (!work) return fallback;

  const m = work.match(COMPOSER_PREFIX_RE);
  if (!m) return fallback;

  const prefix = m[1].trim();
  const rest   = m[2].trim();
  if (!prefix || !rest) return fallback;

  // If the album already declares a composer, only strip when the
  // prefix resolves to the same name.
  if (knownComposer) {
    const a = canonicalComposer(prefix).toLowerCase();
    const b = canonicalComposer(knownComposer).toLowerCase();
    if (a !== b) return fallback;
  }

  return { composer: prefix, title: rest };
}

/* ═══════════════════════════════════════════════════════════════════
   EFFECTIVE ARTIST
   ═══════════════════════════════════════════════════════════════════
   A track's credited performer: its own `artist` attribute if set,
   otherwise the parent directory's, otherwise the album's. Mirrors
   getTrackComposer but for the performer field.
   ────────────────────────────────────────────────────────────────── */

function effectiveArtist(trackEntry, album) {
  return trackEntry.node.getAttribute('artist') ||
         trackEntry.node.parentNode.getAttribute('artist') ||
         album.artist || '';
}

/* ═══════════════════════════════════════════════════════════════════
   GROUPING
   ═══════════════════════════════════════════════════════════════════
   Returns an ordered array of blocks:

     { work: 'Symphony No. 5', composer: 'Beethoven',
       performer: '...', isSection: false, movements: [...] }
     { work: null, composer: '', performer: null,
       isSection: false, movements: [one] }

   A `work: null` block is a flat track: no header, rendered as-is.
   A block with `isSection: true` renders its work title as a section
   label (Act N, Book N) rather than a full work header.
   Movements are contiguous within a block — if the same work name
   appears twice non-adjacently (rare), it gets two separate headers.
   ────────────────────────────────────────────────────────────────── */

/* Group tracks by work. When `trackEntries` is provided it must be an
   array of `{ track, globalIndex }` pairs — a subset of the album's
   tracks, used when rendering a multi-disc album disc by disc.
   Defaults to the whole album, which is the single-disc case. */
function groupTracksByWork(album, trackEntries) {
  if (!trackEntries) {
    trackEntries = album.tracks.map((t, i) => ({ track: t, globalIndex: i }));
  }

  const blocks = [];
  let current = null;

  trackEntries.forEach(({ track: t, globalIndex }) => {
    const { work, movement, isSection } =
      parseWorkAndMovement(t.node, album.composer);
    const composer = getTrackComposer(t) || '';
    const entry = { track: t, globalIndex, movement };

    if (work === null) {
      blocks.push({
        work: null,
        composer,
        performer: null,
        isSection: false,
        movements: [entry],
      });
      current = null;
      return;
    }

    if (current && current.work === work) {
      current.movements.push(entry);
    } else {
      current = {
        work,
        composer,
        performer: null,
        isSection: !!isSection,
        movements: [entry],
      };
      blocks.push(current);
    }
  });

  // Resolve each work's performer. If every movement credits the
  // same name, that's the work performer; if they diverge (rare),
  // fall back to the album artist.
  for (const b of blocks) {
    if (b.work === null) continue;

    const artists = new Set(
      b.movements.map(e => effectiveArtist(e.track, album))
    );

    b.performer = artists.size === 1
      ? [...artists][0]
      : (album.artist || '');
  }

  return blocks;
}