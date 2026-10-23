// Index of an already-fragmented MP4 (moov with no sample table + many moof/mdat pairs).
// Such files can't be seeked through mp4box until every moof has been parsed, so we walk the
// top-level boxes once, reading only box headers and the small moof boxes (mdat payloads are
// skipped), and record where each fragment starts and which time range it covers.

const CHUNK = 64 * 1024;

/**
 * @param {File} file
 * @param {{scanFrom: number, timescales: Map<number, number>, trexDurations: Map<number, number>}} opts
 * @returns {Promise<{fragments: Array<{offset: number, moofSize: number, end: number, time: number, endTime: number}>, duration: number}>}
 */
export async function indexFragments(file, { scanFrom, timescales, trexDurations }) {
  const reader = new ChunkReader(file);
  const fragments = [];
  let offset = scanFrom;
  while (offset + 8 <= file.size) {
    const head = await reader.read(offset, 16);
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      hdr = 16;
    } else if (size === 0) {
      size = file.size - offset; // box runs to end of file
    }
    if (size < 8) break; // corrupt; stop here and use what we have
    if (type === 'moof') {
      const moof = await reader.read(offset, size);
      const { time, endTime } = parseMoof(moof, hdr, size, timescales, trexDurations);
      fragments.push({ offset, moofSize: size, end: Math.min(offset + size, file.size), time, endTime });
    } else if (type === 'mdat' && fragments.length) {
      const last = fragments[fragments.length - 1];
      if (last.end === offset) last.end = Math.min(offset + size, file.size); // its media data
    }
    offset += size;
  }
  const duration = fragments.reduce((d, f) => Math.max(d, f.endTime), 0);
  return { fragments, duration };
}

/** Last fragment that starts at or before `time` (fragments normally begin on a keyframe). */
export function fragmentAt(fragments, time) {
  let lo = 0;
  let hi = fragments.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fragments[mid].time <= time + 0.001) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * MSE only accepts fragments whose sample data is addressed relative to the moof
 * ("default-base-is-moof"); many muxers instead write an absolute file position in tfhd
 * (base-data-offset). Rewrite such a moof so every trun has an explicit moof-relative data_offset,
 * assuming it will be sent immediately followed by the file's mdat that came right after it.
 *
 * @param {Uint8Array} moof the whole moof box
 * @param {number} fileOffset where the moof starts in the file
 * @param {Map<number, number>} trexSizes track id -> default sample size from moov/mvex/trex
 * @returns {Uint8Array} the original bytes if already MSE-friendly, otherwise a rewritten copy
 */
export function rewriteMoofForMse(moof, fileOffset, trexSizes) {
  const dv = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  const top = [...children(dv, 0, moof.byteLength)][0];
  const trafs = [...children(dv, top.body, top.end)];
  const hasAbsoluteBase = trafs.some(
    (b) => b.type === 'traf' && [...children(dv, b.body, b.end)].some((c) => c.type === 'tfhd' && dv.getUint32(c.body) & 0x01)
  );
  if (!hasAbsoluteBase) return moof;

  // Pass 1: where (relative to the old moof start) each trun's sample data begins, per ISO 14496-12.
  const runStarts = [];
  let prevTrafEnd = 0;
  let firstTraf = true;
  for (const traf of trafs) {
    if (traf.type !== 'traf') continue;
    const kids = [...children(dv, traf.body, traf.end)];
    const tfhd = kids.find((c) => c.type === 'tfhd');
    const flags = dv.getUint32(tfhd.body) & 0xffffff;
    const trackId = dv.getUint32(tfhd.body + 4);
    let q = tfhd.body + 8;
    let base = firstTraf ? 0 : prevTrafEnd;
    if (flags & 0x01) {
      base = Number(dv.getBigUint64(q)) - fileOffset;
      q += 8;
    } else if (flags & 0x020000) {
      base = 0;
    }
    if (flags & 0x02) q += 4;
    if (flags & 0x08) q += 4;
    const defaultSize = flags & 0x10 ? dv.getUint32(q) : trexSizes.get(trackId) ?? 0;
    let cursor = base;
    for (const trun of kids.filter((c) => c.type === 'trun')) {
      const tf = dv.getUint32(trun.body) & 0xffffff;
      const count = dv.getUint32(trun.body + 4);
      let p = trun.body + 8;
      let start = cursor;
      if (tf & 0x01) {
        start = base + dv.getInt32(p);
        p += 4;
      }
      if (tf & 0x04) p += 4;
      let bytes = 0;
      if (tf & 0x200) {
        const fields = [0x100, 0x200, 0x400, 0x800].filter((f) => tf & f);
        const stride = 4 * fields.length;
        const sizeAt = 4 * fields.indexOf(0x200);
        for (let i = 0; i < count; i++) bytes += dv.getUint32(p + i * stride + sizeAt);
      } else {
        bytes = count * defaultSize;
      }
      runStarts.push(start);
      cursor = start + bytes;
    }
    prevTrafEnd = cursor;
    firstTraf = false;
  }

  // Pass 2: rebuild moof with tfhd base offsets removed (default-base-is-moof set) and an explicit
  // data_offset on every trun; offsets are patched in once the new moof size is known.
  const fixups = [];
  const rebuilt = trafs.map((b) => {
    if (b.type !== 'traf') return box(b.type, [moof.subarray(b.body, b.end)]);
    const parts = [...children(dv, b.body, b.end)].map((c) => {
      const body = moof.subarray(c.body, c.end);
      if (c.type === 'tfhd') {
        const flags = dv.getUint32(c.body) & 0xffffff;
        if (!(flags & 0x01)) return box('tfhd', [withFlags(body, flags | 0x020000)]);
        const out = new Uint8Array(body.length - 8);
        out.set(body.subarray(0, 8)); // version/flags + track_ID
        out.set(body.subarray(16), 8); // skip the 8-byte base_data_offset
        return box('tfhd', [withFlags(out, (flags & ~0x01) | 0x020000)]);
      }
      if (c.type === 'trun') {
        const tf = dv.getUint32(c.body) & 0xffffff;
        let out = body;
        if (!(tf & 0x01)) {
          out = new Uint8Array(body.length + 4);
          out.set(body.subarray(0, 8)); // version/flags + sample_count
          out.set(body.subarray(8), 12); // leave room for data_offset
        }
        out = withFlags(out, tf | 0x01);
        fixups.push({ bytes: out, oldStart: runStarts[fixups.length] });
        return box('trun', [out]);
      }
      return box(c.type, [body]);
    });
    return box('traf', parts.flat());
  });
  const parts = box('moof', rebuilt.flat());
  const newSize = parts.reduce((n, p) => n + p.length, 0);
  // In the stream we send, the mdat that followed the old moof now follows the new one.
  for (const { bytes, oldStart } of fixups) {
    new DataView(bytes.buffer, bytes.byteOffset).setInt32(8, newSize + (oldStart - moof.byteLength));
  }
  return concat(parts);
}

/** Copy of a full box's body with its 24-bit flags replaced (version byte kept). */
function withFlags(fullBoxBody, flags) {
  const out = fullBoxBody.slice();
  new DataView(out.buffer).setUint32(0, ((out[0] << 24) | flags) >>> 0);
  return out;
}

function box(type, parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  return [head, ...parts];
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function parseMoof(dv, start, end, timescales, trexDurations) {
  let time = Infinity;
  let endTime = 0;
  for (const traf of children(dv, start, end)) {
    if (traf.type !== 'traf') continue;
    let trackId = 0;
    let defaultDuration;
    let baseTime = 0;
    let total = 0;
    for (const box of children(dv, traf.body, traf.end)) {
      const p = box.body;
      if (box.type === 'tfhd') {
        const flags = dv.getUint32(p) & 0xffffff;
        trackId = dv.getUint32(p + 4);
        let q = p + 8;
        if (flags & 0x01) q += 8; // base-data-offset
        if (flags & 0x02) q += 4; // sample-description-index
        if (flags & 0x08) defaultDuration = dv.getUint32(q);
      } else if (box.type === 'tfdt') {
        baseTime = dv.getUint8(p) === 1 ? Number(dv.getBigUint64(p + 4)) : dv.getUint32(p + 4);
      } else if (box.type === 'trun') {
        const flags = dv.getUint32(p) & 0xffffff;
        const count = dv.getUint32(p + 4);
        let q = p + 8;
        if (flags & 0x01) q += 4; // data-offset
        if (flags & 0x04) q += 4; // first-sample-flags
        if (flags & 0x100) {
          // Per-sample records: duration comes first when present.
          const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
          for (let i = 0; i < count && q + i * stride + 4 <= traf.end; i++) total += dv.getUint32(q + i * stride);
        } else {
          total += count * (defaultDuration ?? trexDurations.get(trackId) ?? 0);
        }
      }
    }
    const scale = timescales.get(trackId) || 1;
    time = Math.min(time, baseTime / scale);
    endTime = Math.max(endTime, (baseTime + total) / scale);
  }
  return { time: Number.isFinite(time) ? time : 0, endTime };
}

function* children(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < hdr) return;
    yield { type: fourcc(dv, o + 4), body: o + hdr, end: Math.min(o + size, end) };
    o += size;
  }
}

function fourcc(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
}

/** Reads file ranges through a 64 KB window, so a moof and the mdat header after it cost one read. */
class ChunkReader {
  constructor(file) {
    this.file = file;
    this.start = -1;
    this.view = null;
  }

  async read(offset, length) {
    const end = Math.min(offset + length, this.file.size);
    if (!this.view || offset < this.start || end > this.start + this.view.byteLength) {
      this.start = offset;
      const buf = await this.file.slice(offset, Math.min(offset + Math.max(CHUNK, length), this.file.size)).arrayBuffer();
      this.view = new DataView(buf);
    }
    // Byte 0 of the returned view is `offset` (shorter than `length` at end of file).
    return new DataView(this.view.buffer, offset - this.start, end - offset);
  }
}
