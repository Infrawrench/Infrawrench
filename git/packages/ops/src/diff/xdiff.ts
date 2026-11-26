/**
 * The line diff, as git's xdiff does it. A textbook Myers diff finds *a*
 * shortest edit script; git finds a particular one, shaped by heuristics
 * that discard unmatchable lines first, stop a search that costs too much,
 * and then slide each change to where a person would put it. Hunks, line
 * counts, blame and merge results only match git when all of that is
 * reproduced, so this file follows xprepare.c, xdiffi.c and xhistogram.c
 * step by step rather than being clever on its own.
 *
 * Lines are compared as class numbers (`classifyLines`). A change mask has
 * one byte per line, set when the line is deleted (file one) or added
 * (file two).
 */
import { type IgnoreWhitespace, type Lines, classifyLines } from "./lines";

export type DiffAlgorithm = "myers" | "histogram";

export interface LineDiffOptions {
  /** `myers` is what `git diff` and `git blame` use; `histogram` is what `git merge` uses. */
  readonly algorithm?: DiffAlgorithm;
  readonly ignoreWhitespace?: IgnoreWhitespace;
  /** Slide changes by indentation and blank lines, as git does by default. */
  readonly indentHeuristic?: boolean;
}

/** One run of changed lines: `chg1` lines deleted at `i1` in the old file, `chg2` added at `i2` in the new. */
export interface Change {
  readonly i1: number;
  readonly i2: number;
  readonly chg1: number;
  readonly chg2: number;
}

const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const KPDIS_RUN = 4;
const MAX_COST_MIN = 256;
const HEUR_MIN_COST = 256;
const SNAKE_CNT = 20;
const K_HEUR = 4;
const LINE_MAX = 0x7fffffff;

/** A power of two near the square root, the way xdiff sizes its cut-offs. */
function bogosqrt(n: number): number {
  let i = 1;
  for (; n > 0; n = Math.floor(n / 4)) i <<= 1;
  return i;
}

/** Whether a line that matches too many others sits in a run that is better discarded whole. */
function cleanMultimatch(dis: Uint8Array, i: number, s: number, e: number): boolean {
  if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW;
  if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW;
  let rdis0 = 0;
  let rpdis0 = 1;
  for (let r = 1; i - r >= s; r++) {
    const d = dis[i - r]!;
    if (d === 0) rdis0++;
    else if (d === 2) rpdis0++;
    else break;
  }
  if (rdis0 === 0) return false;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (let r = 1; i + r <= e; r++) {
    const d = dis[i + r]!;
    if (d === 0) rdis1++;
    else if (d === 2) rpdis1++;
    else break;
  }
  if (rdis1 === 0) return false;
  rdis1 += rdis0;
  rpdis1 += rpdis0;
  return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

interface Side {
  /** Class of each line that survived the clean-up. */
  ha: Int32Array;
  /** Where each surviving line is in the file. */
  rindex: Int32Array;
  nreff: number;
  /** The file's change mask and the offset of this range in it. */
  rchg: Uint8Array;
  base: number;
}

interface Split {
  i1: number;
  i2: number;
  minLo: boolean;
  minHi: boolean;
}

interface Env {
  readonly mxcost: number;
  readonly kvd: Int32Array;
  readonly kvdf: number;
  readonly kvdb: number;
}

/** Finds a point on a shortest path through the box, or a good enough one when the search gets expensive. */
function split(
  ha1: Int32Array,
  off1: number,
  lim1: number,
  ha2: Int32Array,
  off2: number,
  lim2: number,
  needMin: boolean,
  spl: Split,
  env: Env,
): void {
  const kvd = env.kvd;
  const F = env.kvdf;
  const B = env.kvdb;
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const fmid = off1 - off2;
  const bmid = lim1 - lim2;
  const odd = ((fmid - bmid) & 1) !== 0;
  let fmin = fmid;
  let fmax = fmid;
  let bmin = bmid;
  let bmax = bmid;

  kvd[F + fmid] = off1;
  kvd[B + bmid] = lim1;

  for (let ec = 1; ; ec++) {
    let gotSnake = false;

    // The diagonal range grows by one each way, and shrinks instead where it would leave the box.
    if (fmin > dmin) kvd[F + --fmin - 1] = -1;
    else ++fmin;
    if (fmax < dmax) kvd[F + ++fmax + 1] = -1;
    else --fmax;

    for (let d = fmax; d >= fmin; d -= 2) {
      let i1 = kvd[F + d - 1]! >= kvd[F + d + 1]! ? kvd[F + d - 1]! + 1 : kvd[F + d + 1]!;
      const prev1 = i1;
      let i2 = i1 - d;
      while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) {
        i1++;
        i2++;
      }
      if (i1 - prev1 > SNAKE_CNT) gotSnake = true;
      kvd[F + d] = i1;
      if (odd && bmin <= d && d <= bmax && kvd[B + d]! <= i1) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }

    if (bmin > dmin) kvd[B + --bmin - 1] = LINE_MAX;
    else ++bmin;
    if (bmax < dmax) kvd[B + ++bmax + 1] = LINE_MAX;
    else --bmax;

    for (let d = bmax; d >= bmin; d -= 2) {
      let i1 = kvd[B + d - 1]! < kvd[B + d + 1]! ? kvd[B + d - 1]! : kvd[B + d + 1]! - 1;
      const prev1 = i1;
      let i2 = i1 - d;
      while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) {
        i1--;
        i2--;
      }
      if (prev1 - i1 > SNAKE_CNT) gotSnake = true;
      kvd[B + d] = i1;
      if (!odd && fmin <= d && d <= fmax && i1 <= kvd[F + d]!) {
        spl.i1 = i1;
        spl.i2 = i2;
        spl.minLo = spl.minHi = true;
        return;
      }
    }

    if (needMin) continue;

    // Past a cost threshold, a diagonal that has run far with a long snake is taken as the split.
    if (gotSnake && ec > HEUR_MIN_COST) {
      let best = 0;
      for (let d = fmax; d >= fmin; d -= 2) {
        const dd = d > fmid ? d - fmid : fmid - d;
        const i1 = kvd[F + d]!;
        const i2 = i1 - d;
        const v = i1 - off1 + (i2 - off2) - dd;
        if (
          v > K_HEUR * ec &&
          v > best &&
          off1 + SNAKE_CNT <= i1 &&
          i1 < lim1 &&
          off2 + SNAKE_CNT <= i2 &&
          i2 < lim2
        ) {
          for (let k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) {
            if (k === SNAKE_CNT) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = true;
        spl.minHi = false;
        return;
      }

      best = 0;
      for (let d = bmax; d >= bmin; d -= 2) {
        const dd = d > bmid ? d - bmid : bmid - d;
        const i1 = kvd[B + d]!;
        const i2 = i1 - d;
        const v = lim1 - i1 + (lim2 - i2) - dd;
        if (
          v > K_HEUR * ec &&
          v > best &&
          off1 < i1 &&
          i1 <= lim1 - SNAKE_CNT &&
          off2 < i2 &&
          i2 <= lim2 - SNAKE_CNT
        ) {
          for (let k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) {
            if (k === SNAKE_CNT - 1) {
              best = v;
              spl.i1 = i1;
              spl.i2 = i2;
              break;
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = false;
        spl.minHi = true;
        return;
      }
    }

    // Enough: take the furthest-reaching path so far, whichever direction got further.
    if (ec >= env.mxcost) {
      let fbest = -1;
      let fbest1 = -1;
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = Math.min(kvd[F + d]!, lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2;
          fbest1 = i1;
        }
      }

      let bbest = LINE_MAX;
      let bbest1 = LINE_MAX;
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = Math.max(off1, kvd[B + d]!);
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2;
          bbest1 = i1;
        }
      }

      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        spl.i1 = fbest1;
        spl.i2 = fbest - fbest1;
        spl.minLo = true;
        spl.minHi = false;
      } else {
        spl.i1 = bbest1;
        spl.i2 = bbest - bbest1;
        spl.minLo = false;
        spl.minHi = true;
      }
      return;
    }
  }
}

/** Divide and conquer over the box, marking whatever falls outside a common run as changed. */
function compare(
  one: Side,
  off1: number,
  lim1: number,
  two: Side,
  off2: number,
  lim2: number,
  needMin: boolean,
  env: Env,
): void {
  const ha1 = one.ha;
  const ha2 = two.ha;
  // The second half is a loop rather than a call, which keeps the depth to the first halves.
  for (;;) {
    while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) {
      off1++;
      off2++;
    }
    while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) {
      lim1--;
      lim2--;
    }
    if (off1 === lim1) {
      for (; off2 < lim2; off2++) two.rchg[two.base + two.rindex[off2]!] = 1;
      return;
    }
    if (off2 === lim2) {
      for (; off1 < lim1; off1++) one.rchg[one.base + one.rindex[off1]!] = 1;
      return;
    }
    const spl: Split = { i1: 0, i2: 0, minLo: false, minHi: false };
    split(ha1, off1, lim1, ha2, off2, lim2, needMin, spl, env);
    compare(one, off1, spl.i1, two, off2, spl.i2, spl.minLo, env);
    off1 = spl.i1;
    off2 = spl.i2;
    needMin = spl.minHi;
  }
}

/**
 * Myers over two runs of classes, writing into the masks at the given
 * offsets. Lines with no match on the other side, and lines with so many
 * matches that they say nothing, are set aside first; that is where most
 * of the difference from a plain shortest edit script comes from.
 */
function myers(
  ha1: Int32Array,
  ha2: Int32Array,
  rchg1: Uint8Array,
  base1: number,
  rchg2: Uint8Array,
  base2: number,
): void {
  const n1 = ha1.length;
  const n2 = ha2.length;

  const len1 = new Map<number, number>();
  const len2 = new Map<number, number>();
  for (let i = 0; i < n1; i++) len1.set(ha1[i]!, (len1.get(ha1[i]!) ?? 0) + 1);
  for (let i = 0; i < n2; i++) len2.set(ha2[i]!, (len2.get(ha2[i]!) ?? 0) + 1);

  let dstart = 0;
  const shared = Math.min(n1, n2);
  while (dstart < shared && ha1[dstart] === ha2[dstart]) dstart++;
  let tail = 0;
  while (tail < shared - dstart && ha1[n1 - 1 - tail] === ha2[n2 - 1 - tail]) tail++;
  const dend1 = n1 - tail - 1;
  const dend2 = n2 - tail - 1;

  const dis1 = new Uint8Array(n1 + 1);
  const dis2 = new Uint8Array(n2 + 1);
  let mlim = Math.min(bogosqrt(n1), MAX_EQLIMIT);
  for (let i = dstart; i <= dend1; i++) {
    const nm = len2.get(ha1[i]!) ?? 0;
    dis1[i] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
  }
  mlim = Math.min(bogosqrt(n2), MAX_EQLIMIT);
  for (let i = dstart; i <= dend2; i++) {
    const nm = len1.get(ha2[i]!) ?? 0;
    dis2[i] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
  }

  const keep = (
    ha: Int32Array,
    dis: Uint8Array,
    dend: number,
    rchg: Uint8Array,
    base: number,
  ): Side => {
    const kept = new Int32Array(dend - dstart + 1);
    const rindex = new Int32Array(dend - dstart + 1);
    let nreff = 0;
    for (let i = dstart; i <= dend; i++) {
      if (dis[i] === 1 || (dis[i] === 2 && !cleanMultimatch(dis, i, dstart, dend))) {
        rindex[nreff] = i;
        kept[nreff] = ha[i]!;
        nreff++;
      } else {
        rchg[base + i] = 1;
      }
    }
    return { ha: kept, rindex, nreff, rchg, base };
  };
  const one = keep(ha1, dis1, dend1, rchg1, base1);
  const two = keep(ha2, dis2, dend2, rchg2, base2);

  const ndiags = one.nreff + two.nreff + 3;
  const env: Env = {
    mxcost: Math.max(bogosqrt(ndiags), MAX_COST_MIN),
    kvd: new Int32Array(2 * ndiags + 2),
    kvdf: two.nreff + 1,
    kvdb: ndiags + two.nreff + 1,
  };
  compare(one, 0, one.nreff, two, 0, two.nreff, false, env);
}

interface Region {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
}

/**
 * The histogram step: index file one's lines by how often they occur, then
 * find the longest run in common that goes through the rarest line. Line
 * numbers here are 1-based, as in xhistogram.c. Returns 1 when the region
 * has common lines but all of them occur too often to anchor on.
 */
function findLcs(
  ha1: Int32Array,
  ha2: Int32Array,
  lcs: Region,
  line1: number,
  count1: number,
  line2: number,
  count2: number,
): number {
  const MAX_CHAIN = 64;
  const end1 = line1 + count1 - 1;
  const end2 = line2 + count2 - 1;
  const recordOf = new Map<number, number>();
  const recPtr: number[] = [];
  const recCnt: number[] = [];
  const nextPtr = new Int32Array(count1);
  const lineRec = new Int32Array(count1);

  for (let ptr = end1; line1 <= ptr; ptr--) {
    const cls = ha1[ptr - 1]!;
    let rec = recordOf.get(cls);
    if (rec === undefined) {
      rec = recPtr.length;
      recordOf.set(cls, rec);
      recPtr.push(ptr);
      recCnt.push(1);
    } else {
      nextPtr[ptr - line1] = recPtr[rec]!;
      recPtr[rec] = ptr;
      recCnt[rec] = recCnt[rec]! + 1;
    }
    lineRec[ptr - line1] = rec;
  }

  let cnt = MAX_CHAIN + 1;
  let hasCommon = false;

  for (let bPtr = line2; bPtr <= end2;) {
    let bNext = bPtr + 1;
    const rec = recordOf.get(ha2[bPtr - 1]!);
    if (rec !== undefined) {
      if (recCnt[rec]! > cnt) {
        hasCommon = true;
      } else {
        hasCommon = true;
        let as = recPtr[rec]!;
        for (;;) {
          let np = nextPtr[as - line1]!;
          let bs = bPtr;
          let ae = as;
          let be = bs;
          let rc = recCnt[rec]!;

          while (line1 < as && line2 < bs && ha1[as - 2] === ha2[bs - 2]) {
            as--;
            bs--;
            if (1 < rc) rc = Math.min(rc, recCnt[lineRec[as - line1]!]!);
          }
          while (ae < end1 && be < end2 && ha1[ae] === ha2[be]) {
            ae++;
            be++;
            if (1 < rc) rc = Math.min(rc, recCnt[lineRec[ae - line1]!]!);
          }

          if (bNext <= be) bNext = be + 1;
          if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) {
            lcs.begin1 = as;
            lcs.begin2 = bs;
            lcs.end1 = ae;
            lcs.end2 = be;
            cnt = rc;
          }

          if (np === 0) break;
          let done = false;
          while (np <= ae) {
            np = nextPtr[np - line1]!;
            if (np === 0) {
              done = true;
              break;
            }
          }
          if (done) break;
          as = np;
        }
      }
    }
    bPtr = bNext;
  }

  return hasCommon && MAX_CHAIN < cnt ? 1 : 0;
}

/**
 * Lines the histogram step may scan, per line of the two files. Each step
 * scans its whole region to find one common run, so when every run it
 * finds is a single line at the start (one file is the other with every
 * second line moved to the end) the steps add up to the square of the
 * length: 100 000 such lines took over three minutes. Real diffs stay far
 * below this; past it, what is left is diffed by Myers, whose own
 * heuristics bound its cost, and the result is a correct diff that may
 * differ from git's.
 */
const HISTOGRAM_WORK_PER_LINE = 64;
const HISTOGRAM_WORK_MIN = 1_000_000;

function histogram(
  ha1: Int32Array,
  ha2: Int32Array,
  rchg1: Uint8Array,
  rchg2: Uint8Array,
  line1: number,
  count1: number,
  line2: number,
  count2: number,
  budget: { work: number },
): void {
  for (;;) {
    if (count1 <= 0 && count2 <= 0) return;
    if (count1 === 0) {
      while (count2-- > 0) rchg2[line2++ - 1] = 1;
      return;
    }
    if (count2 === 0) {
      while (count1-- > 0) rchg1[line1++ - 1] = 1;
      return;
    }
    budget.work -= count1 + count2;
    if (budget.work < 0) {
      myers(
        ha1.subarray(line1 - 1, line1 - 1 + count1),
        ha2.subarray(line2 - 1, line2 - 1 + count2),
        rchg1,
        line1 - 1,
        rchg2,
        line2 - 1,
      );
      return;
    }
    const lcs: Region = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
    if (findLcs(ha1, ha2, lcs, line1, count1, line2, count2) === 1) {
      // Too repetitive to anchor on: this region gets the classic diff, on its own terms.
      myers(
        ha1.subarray(line1 - 1, line1 - 1 + count1),
        ha2.subarray(line2 - 1, line2 - 1 + count2),
        rchg1,
        line1 - 1,
        rchg2,
        line2 - 1,
      );
      return;
    }
    if (lcs.begin1 === 0 && lcs.begin2 === 0) {
      while (count1-- > 0) rchg1[line1++ - 1] = 1;
      while (count2-- > 0) rchg2[line2++ - 1] = 1;
      return;
    }
    histogram(ha1, ha2, rchg1, rchg2, line1, lcs.begin1 - line1, line2, lcs.begin2 - line2, budget);
    const last1 = line1 + count1 - 1;
    const last2 = line2 + count2 - 1;
    count1 = last1 - lcs.end1;
    line1 = lcs.end1 + 1;
    count2 = last2 - lcs.end2;
    line2 = lcs.end2 + 1;
  }
}

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

/** A file as the compaction pass sees it: classes, a mask with a guard byte at each end, and the text. */
interface Compacted {
  readonly ha: Int32Array;
  readonly n: number;
  /** `mask[i + 1]` is line `i`; the guards at 0 and n + 1 stay clear. */
  readonly mask: Uint8Array;
  readonly lines: Lines;
  readonly from: number;
}

/** Indentation in columns, or -1 for a line of nothing but whitespace. */
function indentOf(file: Compacted, index: number): number {
  const lines = file.lines;
  const end = lines.starts[file.from + index + 1]!;
  let ret = 0;
  for (let i = lines.starts[file.from + index]!; i < end; i++) {
    const c = lines.data[i]!;
    if (c === 0x20) ret += 1;
    else if (c === 0x09) ret += 8 - (ret % 8);
    else if (c !== 0x0a && c !== 0x0b && c !== 0x0c && c !== 0x0d) return ret;
    if (ret >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

interface Score {
  effectiveIndent: number;
  penalty: number;
}

/** How bad it would look to start or end a change right before line `at`. */
function scoreSplit(file: Compacted, at: number, score: Score): void {
  const endOfFile = at >= file.n;
  const indent = endOfFile ? -1 : indentOf(file, at);

  let preBlank = 0;
  let preIndent = -1;
  for (let i = at - 1; i >= 0; i--) {
    preIndent = indentOf(file, i);
    if (preIndent !== -1) break;
    preBlank += 1;
    if (preBlank === MAX_BLANKS) {
      preIndent = 0;
      break;
    }
  }

  let postBlankRun = 0;
  let postIndent = -1;
  for (let i = at + 1; i < file.n; i++) {
    postIndent = indentOf(file, i);
    if (postIndent !== -1) break;
    postBlankRun += 1;
    if (postBlankRun === MAX_BLANKS) {
      postIndent = 0;
      break;
    }
  }

  if (preIndent === -1 && preBlank === 0) score.penalty += 1;
  if (endOfFile) score.penalty += 21;

  const postBlank = indent === -1 ? 1 + postBlankRun : 0;
  const totalBlank = preBlank + postBlank;
  score.penalty += -30 * totalBlank;
  score.penalty += 6 * postBlank;

  const effective = indent !== -1 ? indent : postIndent;
  const anyBlanks = totalBlank !== 0;
  score.effectiveIndent += effective;

  if (effective === -1 || preIndent === -1) {
    // Nothing to compare the indentation with.
  } else if (effective > preIndent) {
    score.penalty += anyBlanks ? 10 : -4;
  } else if (effective === preIndent) {
    // Same level as the line before: neither better nor worse.
  } else if (postIndent !== -1 && postIndent > effective) {
    // Less indented than before but followed by more: probably the start of a block.
    score.penalty += anyBlanks ? 17 : 24;
  } else {
    score.penalty += anyBlanks ? 17 : 23;
  }
}

function scoreCompare(a: Score, b: Score): number {
  const indents =
    (a.effectiveIndent > b.effectiveIndent ? 1 : 0) -
    (a.effectiveIndent < b.effectiveIndent ? 1 : 0);
  return 60 * indents + (a.penalty - b.penalty);
}

interface Group {
  start: number;
  end: number;
}

function groupNext(file: Compacted, g: Group): boolean {
  if (g.end === file.n) return false;
  g.start = g.end + 1;
  for (g.end = g.start; file.mask[g.end + 1]; g.end++);
  return true;
}

function groupPrevious(file: Compacted, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; file.mask[g.start]; g.start--);
  return true;
}

function slideDown(file: Compacted, g: Group): boolean {
  if (g.end < file.n && file.ha[g.start] === file.ha[g.end]) {
    file.mask[g.start++ + 1] = 0;
    file.mask[g.end++ + 1] = 1;
    while (file.mask[g.end + 1]) g.end++;
    return true;
  }
  return false;
}

function slideUp(file: Compacted, g: Group): boolean {
  if (g.start > 0 && file.ha[g.start - 1] === file.ha[g.end - 1]) {
    file.mask[--g.start + 1] = 1;
    file.mask[--g.end + 1] = 0;
    while (file.mask[g.start]) g.start--;
    return true;
  }
  return false;
}

function broken(): never {
  throw new Error("line diff: change groups fell out of step");
}

/**
 * Slides each run of changes within the lines it could equally well cover:
 * first to line up with a change in the other file, otherwise to the place
 * the indentation says a person would have put it.
 */
function compact(file: Compacted, other: Compacted, indentHeuristic: boolean): void {
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  while (file.mask[g.end + 1]) g.end++;
  while (other.mask[go.end + 1]) go.end++;

  for (;;) {
    if (g.end !== g.start) {
      let groupSize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupSize = g.end - g.start;
        endMatchingOther = -1;
        while (slideUp(file, g)) if (!groupPrevious(other, go)) broken();
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!slideDown(file, g)) break;
          if (!groupNext(other, go)) broken();
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupSize !== g.end - g.start);

      if (g.end === earliestEnd) {
        // It could not move at all.
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!slideUp(file, g)) broken();
          if (!groupPrevious(other, go)) broken();
        }
      } else if (indentHeuristic) {
        let bestShift = -1;
        let best: Score = { effectiveIndent: 0, penalty: 0 };
        let shift = earliestEnd;
        if (g.end - groupSize - 1 > shift) shift = g.end - groupSize - 1;
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) {
          shift = g.end - INDENT_HEURISTIC_MAX_SLIDING;
        }
        for (; shift <= g.end; shift++) {
          const score: Score = { effectiveIndent: 0, penalty: 0 };
          scoreSplit(file, shift, score);
          scoreSplit(file, shift - groupSize, score);
          if (bestShift === -1 || scoreCompare(score, best) <= 0) {
            best = score;
            bestShift = shift;
          }
        }
        while (g.end > bestShift) {
          if (!slideUp(file, g)) broken();
          if (!groupPrevious(other, go)) broken();
        }
      }
    }
    if (!groupNext(file, g)) break;
    if (!groupNext(other, go)) broken();
  }
}

export interface RangeDiff {
  /** Bytes set for deleted lines of the first range, one per line. */
  readonly removed: Uint8Array;
  /** Bytes set for added lines of the second range. */
  readonly added: Uint8Array;
  /** The same thing as runs, in order, with indices relative to the ranges. */
  readonly changes: Change[];
}

/** Diffs `aCount` lines of `a` from `aFrom` against `bCount` lines of `b` from `bFrom`. */
export function diffLineRanges(
  a: Lines,
  aFrom: number,
  aCount: number,
  b: Lines,
  bFrom: number,
  bCount: number,
  options: LineDiffOptions = {},
): RangeDiff {
  const { ha1, ha2 } = classifyLines(
    a,
    aFrom,
    aCount,
    b,
    bFrom,
    bCount,
    options.ignoreWhitespace ?? "none",
  );
  // One guard byte before and after, which the sliding code reads instead of checking bounds.
  const mask1 = new Uint8Array(aCount + 2);
  const mask2 = new Uint8Array(bCount + 2);
  const rchg1 = mask1.subarray(1);
  const rchg2 = mask2.subarray(1);
  if (options.algorithm === "histogram") {
    const work = Math.max(HISTOGRAM_WORK_MIN, HISTOGRAM_WORK_PER_LINE * (aCount + bCount));
    histogram(ha1, ha2, rchg1, rchg2, 1, aCount, 1, bCount, { work });
  } else {
    myers(ha1, ha2, rchg1, 0, rchg2, 0);
  }

  const one: Compacted = { ha: ha1, n: aCount, mask: mask1, lines: a, from: aFrom };
  const two: Compacted = { ha: ha2, n: bCount, mask: mask2, lines: b, from: bFrom };
  const indent = options.indentHeuristic ?? true;
  compact(one, two, indent);
  compact(two, one, indent);

  const changes: Change[] = [];
  let i1 = 0;
  let i2 = 0;
  while (i1 < aCount || i2 < bCount) {
    if (rchg1[i1] || rchg2[i2]) {
      const s1 = i1;
      const s2 = i2;
      while (rchg1[i1]) i1++;
      while (rchg2[i2]) i2++;
      changes.push({ i1: s1, i2: s2, chg1: i1 - s1, chg2: i2 - s2 });
    } else {
      i1++;
      i2++;
    }
  }
  return { removed: rchg1.subarray(0, aCount), added: rchg2.subarray(0, bCount), changes };
}

/** Diffs two whole files. */
export function diffLines(a: Lines, b: Lines, options: LineDiffOptions = {}): RangeDiff {
  return diffLineRanges(a, 0, a.count, b, 0, b.count, options);
}
