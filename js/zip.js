/* A ZIP reader with no dependencies.
 *
 * An EPUB is a ZIP, and the browser already ships the hard part: raw DEFLATE
 * lives in DecompressionStream. What is left is walking the central directory,
 * which is a few hundred bytes of fixed-layout records. Doing it by hand keeps
 * the reader free of any third-party code and, more to the point, free of
 * anything that has to be fetched at run time -- this has to work offline on a
 * phone.
 *
 * Only what an EPUB actually uses is implemented: stored and deflated entries,
 * and the Zip64 end-of-directory records that appear once a book gets large.
 */

'use strict';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// The end-of-directory record sits at the very end unless a ZIP comment
// follows it, and a comment can be 64 KiB.
const MAX_EOCD_SEARCH = 66 * 1024;

export class ZipError extends Error {}

function utf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/* Names are UTF-8 when the entry says so, and otherwise nominally CP437.
   Real EPUBs from Japanese publishers use UTF-8 without always setting the
   flag, so try UTF-8 strictly first and only fall back when it is not valid. */
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return utf8(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipArchive {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(
      this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength
    );
    this.entries = new Map();   // name -> record
    this._cache = new Map();    // name -> Uint8Array, for repeat reads
  }

  static async open(source) {
    const buffer = source instanceof ArrayBuffer
      ? source
      : await source.arrayBuffer();
    const archive = new ZipArchive(buffer);
    archive._readDirectory();
    return archive;
  }

  // -- directory ----------------------------------------------------------

  _findEocd() {
    const limit = Math.min(this.bytes.length, MAX_EOCD_SEARCH);
    for (let back = 22; back <= limit; back++) {
      const at = this.bytes.length - back;
      if (at < 0) break;
      if (this.view.getUint32(at, true) === EOCD_SIGNATURE) return at;
    }
    throw new ZipError('ZIP の終端レコードが見つかりません（壊れているか ZIP ではありません）');
  }

  _readDirectory() {
    const eocd = this._findEocd();
    let count = this.view.getUint16(eocd + 10, true);
    let start = this.view.getUint32(eocd + 16, true);

    // Zip64: the 32-bit fields are saturated and the real values live in a
    // separate record pointed at by a locator just before the EOCD.
    if (count === 0xffff || start === 0xffffffff) {
      const locator = eocd - 20;
      if (locator >= 0 && this.view.getUint32(locator, true) === EOCD64_LOCATOR) {
        const at = Number(this.view.getBigUint64(locator + 8, true));
        if (this.view.getUint32(at, true) === EOCD64_SIGNATURE) {
          count = Number(this.view.getBigUint64(at + 32, true));
          start = Number(this.view.getBigUint64(at + 48, true));
        }
      }
    }

    let at = start;
    for (let i = 0; i < count; i++) {
      if (at + 46 > this.bytes.length) break;
      if (this.view.getUint32(at, true) !== CENTRAL_SIGNATURE) break;

      const flags = this.view.getUint16(at + 8, true);
      const method = this.view.getUint16(at + 10, true);
      let compressedSize = this.view.getUint32(at + 20, true);
      let size = this.view.getUint32(at + 24, true);
      const nameLength = this.view.getUint16(at + 28, true);
      const extraLength = this.view.getUint16(at + 30, true);
      const commentLength = this.view.getUint16(at + 32, true);
      let offset = this.view.getUint32(at + 42, true);

      const nameBytes = this.bytes.subarray(at + 46, at + 46 + nameLength);
      const name = decodeName(nameBytes, (flags & 0x800) !== 0);

      if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
        const extra = at + 46 + nameLength;
        [size, compressedSize, offset] = this._readZip64Extra(
          extra, extraLength, size, compressedSize, offset
        );
      }

      this.entries.set(name, { name, method, compressedSize, size, offset });
      at += 46 + nameLength + extraLength + commentLength;
    }

    if (!this.entries.size) throw new ZipError('ZIP に項目がありません');
  }

  _readZip64Extra(at, length, size, compressedSize, offset) {
    const end = at + length;
    while (at + 4 <= end) {
      const id = this.view.getUint16(at, true);
      const chunk = this.view.getUint16(at + 2, true);
      let cursor = at + 4;
      if (id === 0x0001) {
        if (size === 0xffffffff) { size = Number(this.view.getBigUint64(cursor, true)); cursor += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(this.view.getBigUint64(cursor, true)); cursor += 8; }
        if (offset === 0xffffffff) { offset = Number(this.view.getBigUint64(cursor, true)); }
        break;
      }
      at += 4 + chunk;
    }
    return [size, compressedSize, offset];
  }

  // -- access -------------------------------------------------------------

  has(name) {
    return this.entries.has(name);
  }

  names() {
    return Array.from(this.entries.keys());
  }

  sizeOf(name) {
    const entry = this.entries.get(name);
    return entry ? entry.size : 0;
  }

  async read(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const entry = this.entries.get(name);
    if (!entry) throw new ZipError(`ZIP 内に見つかりません: ${name}`);

    // The local header repeats the name and extra field, and its lengths are
    // the authoritative ones for finding where the data starts.
    const at = entry.offset;
    if (this.view.getUint32(at, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`ローカルヘッダが壊れています: ${name}`);
    }
    const nameLength = this.view.getUint16(at + 26, true);
    const extraLength = this.view.getUint16(at + 28, true);
    const start = at + 30 + nameLength + extraLength;
    const raw = this.bytes.subarray(start, start + entry.compressedSize);

    let data;
    if (entry.method === METHOD_STORED) {
      data = raw;
    } else if (entry.method === METHOD_DEFLATE) {
      data = await inflateRaw(raw);
    } else {
      throw new ZipError(`未対応の圧縮方式 (${entry.method}): ${name}`);
    }

    // Chapters get read repeatedly while paging; images once per display.
    // Caching everything would defeat the point of streaming from the ZIP, so
    // only small entries are kept.
    if (data.length <= 512 * 1024) this._cache.set(name, data);
    return data;
  }

  async readText(name) {
    return utf8(await this.read(name));
  }

  /* First bytes of an entry, for classifying a document without inflating a
     whole chapter. Deflate has to run from the start, so this only avoids the
     decode and copy, not the inflate -- still worth it for a 1 MB chapter. */
  async readHead(name, limit = 4096) {
    const data = await this.read(name);
    return utf8(data.subarray(0, limit));
  }

  clearCache() {
    this._cache.clear();
  }
}
