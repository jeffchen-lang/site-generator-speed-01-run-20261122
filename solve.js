// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers, byte for byte, on every case: the same front matter, template
// dialect, Markdown subset, slug rule and report as makefun-site 1.0.0. Written
// from the spec in its README, reimplemented here for speed:
//
//  - front matter and Markdown are scanned line by line without building
//    token objects; inline rendering is a single pass with a char-code escape
//    table instead of a regex per character.
//  - slugify takes an ASCII fast path (NFKD is the identity there); word
//    counting is a char-code scan over the exact \s set.
//  - templates are parsed once per case and compiled to plain JavaScript
//    functions (new Function), so rendering a page is straight-line code with
//    inlined scope-chain lookups instead of a node-tree walk.
//
// No dependencies, no I/O, no clock, no randomness: run(input) is a pure
// function of its input, exactly like the reference.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

/** HTML escape of a whole string, one pass, no regex. */
const ESC_RE = /[&<>"']/;
function escStr(s) {
  if (!ESC_RE.test(s)) return s;
  let o = '';
  let st = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let e;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    else continue;
    if (i > st) o += s.slice(st, i);
    o += e;
    st = i + 1;
  }
  if (st < s.length) o += s.slice(st);
  return o;
}

/** HTML escape of s[a..b) pushed onto out (one push when nothing escapes). */
function escPush(out, s, a, b) {
  if (b <= a) return;
  const sub = a === 0 && b === s.length ? s : s.slice(a, b);
  if (!ESC_RE.test(sub)) {
    out.push(sub);
    return;
  }
  let o = '';
  let st = 0;
  for (let i = 0; i < sub.length; i++) {
    const c = sub.charCodeAt(i);
    let e;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    else continue;
    if (i > st) o += sub.slice(st, i);
    o += e;
    st = i + 1;
  }
  if (st < sub.length) o += sub.slice(st);
  out.push(o);
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most 64
 *  characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    // NFKD is the identity on ASCII and ASCII holds no combining marks, so
    // the normalisation and mark-stripping steps change nothing here.
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  if (rel.indexOf('/') === -1) {
    // No steps at all: a plain name in the same directory (or the root).
    if (rel === '..') {
      if (dir === '') return null;
      const cut = dir.lastIndexOf('/');
      return cut === -1 ? '' : dir.slice(0, cut);
    }
    if (rel === '.' || rel === '') return dir;
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Scanned in place: the opening line must be
 * exactly `---`, the closing line the next line that is exactly `---`, and the
 * body is everything after it. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-' ||
      (text.length > 3 && text[3] !== '\n')) return { error: 'no front matter' };
  let closeIdx = -1; // index of the '\n' just before the closing `---` line
  let q = text.indexOf('\n---', 3);
  while (q !== -1) {
    const after = q + 4;
    if (after === text.length || text[after] === '\n') { closeIdx = q; break; }
    q = text.indexOf('\n---', q + 1);
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = 4; // start of line 2 (the opening `---` is line 1)
  let lineNo = 2;
  while (lineStart <= closeIdx) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1 || lineEnd > closeIdx) lineEnd = closeIdx;
    const line = text.slice(lineStart, lineEnd);
    // Blank (spaces and tabs only) or a comment (opening on `#`): skipped.
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line[0] !== '#') {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeIdx + 4 === text.length ? text.length : closeIdx + 5;
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  const n = line.length;
  while (h < n && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= n) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < n && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = n;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= s) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  const w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === w0 && (w1 === -1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, appended to `out`; `env.link(target)` is a link's
 * href. Plain text between constructs is scanned by the regex engine, not
 * char by char; each construct is handled exactly as the reference does it.
 */
function inlineInto(s, env, out) {
  const re = /[\\`*\[]/g; // the characters that can open a construct
  let lit = 0; // start of the pending literal run (escaped as a whole on flush)
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash: escapes one of the escapable characters
      if (i + 1 < s.length && isEscapableCode(s.charCodeAt(i + 1))) {
        if (i > lit) escPush(out, s, lit, i);
        const d = s.charCodeAt(i + 1);
        // The escaped character, itself HTML-escaped (only '>' of the set needs it).
        out.push(d === 62 ? '&gt;' : s[i + 1]);
        lit = i + 2;
        re.lastIndex = lit;
      }
      // Any other `\` is itself: it stays in the literal run.
      continue;
    }
    if (c === 96) { // backtick: a code span closed by the next backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > lit) escPush(out, s, lit, i);
        out.push('<code>');
        escPush(out, s, i + 1, j);
        out.push('</code>');
        lit = j + 1;
        re.lastIndex = lit;
      }
      // A backtick with no closer is itself: it stays in the literal run.
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > lit) escPush(out, s, lit, i);
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          lit = j + 2;
          re.lastIndex = lit;
        } else {
          // With no closer, `**` is itself: skip both stars.
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > lit) escPush(out, s, lit, i);
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), env, out);
        out.push('</em>');
        lit = j + 1;
        re.lastIndex = lit;
      }
      // With no closer, `*` is itself: it stays in the literal run.
      continue;
    }
    // c === 91: `[text](target)`, else `[` is itself.
    const k = findUnescaped(s, ']', i + 1);
    const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = t === -1 ? '' : s.slice(k + 2, t);
    if (target !== '' && !/\s/.test(target)) {
      if (i > lit) escPush(out, s, lit, i);
      const href = env.link(target);
      out.push('<a href="');
      escPush(out, href, 0, href.length);
      out.push('">');
      inlineInto(s.slice(i + 1, k), env, out);
      out.push('</a>');
      lit = t + 1;
      re.lastIndex = lit;
    }
    // Otherwise `[` stays in the literal run.
  }
  if (lit < s.length) escPush(out, s, lit, s.length);
}

/** `s` rendered inline, as a string. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's inline
 * HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const L = lines.length;
  const ids = new Set();
  // One shared output array: every block's pieces go straight in, each
  // block followed by its "\n", so the HTML is a single join at the end.
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    // A fence: a line of three backticks and an optional language.
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        i++;
        while (i < L && !FENCE_CLOSE.test(lines[i])) {
          escPush(out, lines[i], 0, lines[i].length);
          out.push('\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    }
    // A heading: 1 to 6 `#`, at least one space or tab, then text.
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        out.push(`<h${heading.depth} id="${id}">`);
        if (heading.depth === 2 || heading.depth === 3) {
          const html = inlineStr(heading.text, env);
          toc.push({ level: heading.depth, id, html });
          out.push(html);
        } else inlineInto(heading.text, env, out);
        out.push(`</h${heading.depth}>\n`);
        i++;
        continue;
      }
    }
    // A thematic break: `---` or `***`, then spaces or tabs only.
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) { out.push('<hr>\n'); i++; continue; }
    }
    // A blockquote: the lines opening on `>`.
    if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = body.map(trimLine).filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // A list: `- `, `* ` or digits and `. `; continuation lines of two or
    // more spaces then a non-space continue the item.
    const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    const bullet = isBullet ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < L) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${ordered[1]}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const parts of items) {
        out.push('<li>');
        inlineInto(parts.join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // A paragraph: lines up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      excerpt = inlineStr(text, env);
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line is taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- scope-chain lookups, specialised by path length (paths here are short)

function L1(sc, a) {
  let s = sc;
  while (s !== null) {
    if (Object.hasOwn(s.vars, a)) return s.vars[a];
    s = s.parent;
  }
  return undefined;
}

function L2(sc, a, b) {
  let s = sc;
  while (s !== null) {
    if (Object.hasOwn(s.vars, a)) {
      const v = s.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      return v[b];
    }
    s = s.parent;
  }
  return undefined;
}

function L3(sc, a, b, c) {
  let s = sc;
  while (s !== null) {
    if (Object.hasOwn(s.vars, a)) {
      let v = s.vars[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      v = v[b];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
      return v[c];
    }
    s = s.parent;
  }
  return undefined;
}

function Lg(sc, path) {
  let s = sc;
  while (s !== null) {
    if (Object.hasOwn(s.vars, path[0])) {
      let v = s.vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    s = s.parent;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A path's lookup call in generated code. */
function lookupCall(path, sc) {
  const segs = path.map((s) => JSON.stringify(s)).join(',');
  if (path.length === 1) return `L1(${sc},${segs})`;
  if (path.length === 2) return `L2(${sc},${segs})`;
  if (path.length === 3) return `L3(${sc},${segs})`;
  return `Lg(${sc},${JSON.stringify(path)})`;
}

/** Emit `nodes` as straight-line code appending to O, in scope `sc`. */
function compileNodes(nodes, sc, parts, uid) {
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(`O.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var') parts.push(`O.push(esc(txt(${lookupCall(n.path, sc)})));`);
    else if (n.kind === 'raw') parts.push(`O.push(txt(${lookupCall(n.path, sc)}));`);
    else if (n.kind === 'if') {
      const l = lookupCall(n.path, sc);
      parts.push(`if(tru(${l})!==${n.not ? 'true' : 'false'}){`);
      compileNodes(n.then, sc, parts, uid);
      if (n.else !== null) {
        parts.push('}else{');
        compileNodes(n.else, sc, parts, uid);
      }
      parts.push('}');
    } else if (n.kind === 'for') {
      const id = uid.next++;
      const l = lookupCall(n.path, sc);
      const sc2 = `sc${id}`;
      parts.push(`{const _xs${id}=${l};if(Array.isArray(_xs${id})){for(let _k${id}=0;_k${id}<_xs${id}.length;_k${id}++){const _x${id}=_xs${id}[_k${id}];const ${sc2}={vars:{[${JSON.stringify(n.name)}]:_x${id},loop:{index:_k${id}+1,first:_k${id}===0,last:_k${id}===_xs${id}.length-1,length:_xs${id}.length}},parent:${sc}};`);
      compileNodes(n.body, sc2, parts, uid);
      parts.push('}}}');
    } else if (n.kind === 'include') {
      const id = uid.next++;
      parts.push(`{const _t${id}=T.get(${JSON.stringify(n.name)});if(_t${id}!==undefined&&dp<${INCLUDE_DEPTH})_t${id}(O,${sc},dp+1,T,L1,L2,L3,Lg,txt,esc,tru);}`);
    }
  }
}

/** A template's node tree compiled to a function (O, sc, dp, T, L1, L2, L3, Lg, txt, esc, tru). */
function compileTemplate(nodes) {
  const parts = [];
  compileNodes(nodes, 'sc', parts, { next: 0 });
  return new Function('O', 'sc', 'dp', 'T', 'L1', 'L2', 'L3', 'Lg', 'txt', 'esc', 'tru', parts.join(''));
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in order; a refused source is reported
  // and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags, grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const slugCache = new Map();
  const slugCached = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) {
      v = slugify(name);
      slugCache.set(name, v);
    }
    return v;
  };
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugCached(name)) && seen.add(slugCached(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugCached(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugCached(name)) ?? { name, slug: slugCached(name), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  for (const p of b.posts) b.cards.set(p, cardOf(p));
  // Pages (non-posts) have no card in b.cards: build one for them.
  const cardFor = (s) => b.cards.get(s) ?? cardOf(s);
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const O = [];
    fn(O, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, b.templates, L1, L2, L3, Lg, textOf, escStr, truthy);
    return O.join('');
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  for (const s of b.sources) {
    const card = cardFor(s);
    b.output[`${s.outDir}/index.html`] = render(s.layout, {
      page: {
        ...card,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      },
    });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesN = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesN} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
