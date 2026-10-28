/**
 * sqlite.js — a tiny, dependency-free, READ-ONLY SQLite 3 file reader.
 *
 * Why this exists: a DSH plugin needs to inspect a browser/Electron `Cookies`
 * database in place. Opening a live SQLite file with a native binding would
 * create side files, may take locks, and can fail while the browser holds the
 * database. Instead we read the bytes (`fs.readFileSync`) and parse the file
 * format ourselves: header, `sqlite_master`, table B-trees, records, overflow
 * chains. Nothing is ever written, locked, or memory-mapped.
 *
 * Only ordinary rowid tables are supported (no indexes, no WITHOUT ROWID,
 * no WAL replay, no virtual tables).
 *
 * INTEGER PRECISION NOTE: like every JSON-oriented SQLite reader, integers are
 * returned as JS `number`s, which are exact only up to 2^53-1. Chromium stores
 * cookie expiry times as microseconds since 1601 (e.g. 13300000000000000), which
 * exceeds that range and therefore rounds. When exactness matters, pass
 * `readDatabase(buf, { bigInt: true })` to receive `BigInt` for every integer
 * column instead.
 *
 * ESM, Node.js >= 22, zero npm dependencies.
 */

import fs from 'node:fs';
import { Buffer } from 'node:buffer';

const MAGIC = 'SQLite format 3\u0000';
const HEADER_SIZE = 100;
const MAX_BTREE_DEPTH = 64;

/* ------------------------------------------------------------------------- *
 * Bounds-checked byte helpers.
 *
 * Every read in this file goes through one of these, so a corrupt or truncated
 * file always raises a descriptive Error instead of an out-of-bounds read or a
 * silently `undefined` byte.
 * ------------------------------------------------------------------------- */

function fail(message) {
  throw new Error(`sqlite: ${message}`);
}

function checkRange(buf, offset, length, what) {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buf.length
  ) {
    fail(
      `${what}: need ${length} byte(s) at offset ${offset} but only ${buf.length} byte(s) are available ` +
        `(truncated or corrupt database file)`,
    );
  }
}

function u8(buf, offset, what) {
  checkRange(buf, offset, 1, what);
  return buf[offset];
}

function u16(buf, offset, what) {
  checkRange(buf, offset, 2, what);
  return buf.readUInt16BE(offset);
}

function u32(buf, offset, what) {
  checkRange(buf, offset, 4, what);
  return buf.readUInt32BE(offset);
}

/**
 * Convert a BigInt that describes a length/offset into a JS number, refusing
 * values that cannot be represented exactly (corrupt varints are usually huge).
 */
function toSafeNumber(value, what) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${what}: value ${value} is too large to be a valid length or offset`);
  }
  return Number(value);
}

/**
 * SQLite variable-length integer ("varint"), 1..9 bytes, big-endian base-128.
 *
 * The first 8 bytes each contribute 7 bits and set the high bit to say "more
 * bytes follow". A 9th byte, when present, contributes a full 8 bits and
 * terminates the value (so the maximum is 2^64-1).
 *
 * Returns { value: bigint, next: offsetAfterTheVarint }.
 */
function readVarint(buf, offset, what = 'varint') {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    const byte = u8(buf, offset + i, `${what}: byte ${i + 1} at offset ${offset + i}`);
    if (i === 8) {
      value = (value << 8n) | BigInt(byte);
      return { value, next: offset + 9 };
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  // The loop above always returns; this keeps the function total.
  fail(`${what}: malformed variable-length integer at offset ${offset}`);
}

/** Signed big-endian integer of 1/2/3/4/6/8 bytes. */
function readSignedBE(buf, offset, size, what) {
  checkRange(buf, offset, size, what);
  let value = 0n;
  for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(buf[offset + i]);
  if (buf[offset] & 0x80) value -= 1n << BigInt(size * 8);
  return value;
}

/** Decode TEXT payload bytes according to the file's text encoding field. */
function decodeText(buf, offset, length, encoding, what) {
  checkRange(buf, offset, length, what);
  if (encoding === 1) return buf.toString('utf8', offset, offset + length);
  // UTF-16: SQLite stores it little-endian (2) or big-endian (3).
  let slice = Buffer.from(buf.subarray(offset, offset + length));
  if (slice.length % 2 === 1) slice = slice.subarray(0, slice.length - 1);
  if (encoding === 3) slice.swap16();
  return slice.toString('utf16le');
}

/* ------------------------------------------------------------------------- *
 * File header
 * ------------------------------------------------------------------------- */

function parseFileHeader(buffer) {
  if (buffer.length < HEADER_SIZE) {
    fail(
      `file is only ${buffer.length} byte(s) long; a SQLite database needs at least a ` +
        `${HEADER_SIZE}-byte file header`,
    );
  }

  const magic = buffer.toString('latin1', 0, 16);
  if (magic !== MAGIC) {
    const hex = buffer.subarray(0, Math.min(16, buffer.length)).toString('hex');
    fail(
      `bad file header: expected the magic string "SQLite format 3\\u0000" but found ` +
        `${JSON.stringify(magic)} (first bytes: ${hex})`,
    );
  }

  // Offset 16: page size, big-endian u16. The value 1 encodes 65536.
  const rawPageSize = buffer.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    fail(`invalid page size ${pageSize} in header (must be a power of two between 512 and 65536)`);
  }

  // Offset 20: bytes reserved per page for extensions; they are not usable.
  const reservedBytes = buffer[20];
  const usableSize = pageSize - reservedBytes;
  if (usableSize < 480) {
    fail(`invalid usable page size ${usableSize} (page size ${pageSize} minus ${reservedBytes} reserved bytes)`);
  }

  // Offset 56: 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be (0 means "unset"/UTF-8).
  const rawEncoding = buffer.readUInt32BE(56);
  const encoding = rawEncoding === 0 ? 1 : rawEncoding;
  if (encoding !== 1 && encoding !== 2 && encoding !== 3) {
    fail(`unsupported text encoding ${rawEncoding} in header (expected 1, 2 or 3)`);
  }

  const pageCount = Math.floor(buffer.length / pageSize);
  if (pageCount < 1) fail(`file holds ${buffer.length} byte(s), which is less than one ${pageSize}-byte page`);

  return { pageSize, usableSize, reservedBytes, encoding, pageCount };
}

/* ------------------------------------------------------------------------- *
 * Payload sizing / overflow pages
 * ------------------------------------------------------------------------- */

/**
 * How many payload bytes live inside the B-tree page itself.
 *
 * SQLite's documented formulas:
 *   maxLocal = usableSize - 35
 *   minLocal = ((usableSize - 12) * 32 / 255) - 23
 *   surplus  = minLocal + (payloadSize - minLocal) % (usableSize - 4)
 * If payloadSize <= maxLocal it all stays local; otherwise the local part is
 * `surplus` when surplus <= maxLocal, else `minLocal`. The remaining bytes are
 * reached through the overflow chain that starts right after the local bytes.
 */
function localPayloadSize(payloadSize, usableSize) {
  const maxLocal = usableSize - 35;
  const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
  if (payloadSize <= maxLocal) return payloadSize;
  const surplus = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
  return surplus <= maxLocal ? surplus : minLocal;
}

/* ------------------------------------------------------------------------- *
 * Records (the "row" encoding inside a table-leaf cell)
 * ------------------------------------------------------------------------- */

const INT_SIZES = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };

/**
 * Decode one serial-type value. Returns { value, size } where `size` is the
 * number of payload bytes consumed.
 *
 * With `bigInt` set, integer columns come back as BigInt so values beyond
 * 2^53 (Chromium cookie timestamps, for example) stay exact.
 */
function decodeSerialValue(buf, offset, serialType, encoding, what, bigInt = false) {
  const int = (value) => (bigInt ? value : Number(value));
  if (serialType === 0) return { value: null, size: 0 }; // NULL
  if (serialType <= 6) {
    const size = INT_SIZES[serialType];
    return { value: int(readSignedBE(buf, offset, size, what)), size };
  }
  if (serialType === 7) {
    checkRange(buf, offset, 8, what);
    return { value: buf.readDoubleBE(offset), size: 8 }; // IEEE-754 big-endian
  }
  if (serialType === 8) return { value: int(0n), size: 0 }; // integer 0, not stored
  if (serialType === 9) return { value: int(1n), size: 0 }; // integer 1, not stored
  if (serialType === 10 || serialType === 11) return { value: null, size: 0 }; // reserved
  if (serialType % 2 === 0) {
    const size = (serialType - 12) / 2; // BLOB
    checkRange(buf, offset, size, what);
    return { value: Buffer.from(buf.subarray(offset, offset + size)), size };
  }
  const size = (serialType - 13) / 2; // TEXT
  return { value: decodeText(buf, offset, size, encoding, what), size };
}

/**
 * Decode a record payload into an array of column values.
 *
 * Layout: [header-size varint][serial-type varint]* (until header-size)
 *         [value bytes...] in the same order as the serial types.
 * The header size counts the size varint itself.
 */
function parseRecord(payload, encoding, what, options = {}) {
  const bigInt = options.bigInt === true;
  const headerInfo = readVarint(payload, 0, `${what}: record header size`);
  const headerSize = toSafeNumber(headerInfo.value, `${what}: record header size`);
  if (headerSize < headerInfo.next || headerSize > payload.length) {
    fail(
      `${what}: record header length ${headerSize} is out of range ` +
        `(payload is ${payload.length} byte(s), header varint ends at ${headerInfo.next})`,
    );
  }

  const serialTypes = [];
  let cursor = headerInfo.next;
  while (cursor < headerSize) {
    const info = readVarint(payload, cursor, `${what}: serial type #${serialTypes.length + 1}`);
    serialTypes.push(toSafeNumber(info.value, `${what}: serial type`));
    cursor = info.next;
  }

  const values = [];
  let body = headerSize;
  for (let i = 0; i < serialTypes.length; i++) {
    const { value, size } = decodeSerialValue(
      payload,
      body,
      serialTypes[i],
      encoding,
      `${what}: value #${i + 1} (serial type ${serialTypes[i]})`,
      bigInt,
    );
    values.push(value);
    body += size;
  }
  if (body > payload.length) {
    fail(`${what}: record body needs ${body} byte(s) but the payload has ${payload.length}`);
  }
  return values;
}

/* ------------------------------------------------------------------------- *
 * CREATE TABLE parsing (declared column names, rowid alias)
 * ------------------------------------------------------------------------- */

/** Split a SQL fragment on commas that are not inside parens or quotes. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote !== ']' && text[i + 1] === quote) i += 1; // doubled quote escape
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Read the identifier that starts a column definition. */
function parseLeadingIdentifier(text) {
  const source = text.trimStart();
  if (!source) return null;
  const head = source[0];

  if (head === '"' || head === "'" || head === '`') {
    let name = '';
    let i = 1;
    for (; i < source.length; i++) {
      if (source[i] === head) {
        if (source[i + 1] === head) {
          name += head;
          i += 1;
          continue;
        }
        break;
      }
      name += source[i];
    }
    return { name, rest: source.slice(i + 1).trim() };
  }

  if (head === '[') {
    const close = source.indexOf(']');
    if (close < 0) return null;
    return { name: source.slice(1, close), rest: source.slice(close + 1).trim() };
  }

  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(source);
  if (!match) return null;
  return { name: match[0], rest: source.slice(match[0].length).trim() };
}

/**
 * Extract declared column names (and each column's trailing declaration text)
 * from a CREATE TABLE statement. Table-level constraints are skipped.
 */
function parseColumnDefinitions(sql) {
  const open = sql.indexOf('(');
  if (open < 0) return [];

  let depth = 0;
  let quote = null;
  let close = -1;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) {
        if (quote !== ']' && sql[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];

  const definitions = [];
  for (const part of splitTopLevel(sql.slice(open + 1, close))) {
    const item = part.trim();
    if (!item) continue;
    if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(item)) continue; // table constraint
    const parsed = parseLeadingIdentifier(item);
    if (!parsed || !parsed.name) continue;
    definitions.push({ name: parsed.name, rest: parsed.rest });
  }
  return definitions;
}

/**
 * Find the column that is a true `INTEGER PRIMARY KEY` alias for the hidden
 * rowid. SQLite stores that column as NULL in the record and takes the value
 * from the B-tree key, so the reader substitutes the cell rowid back in.
 * (`PRIMARY KEY DESC` is a documented exception: it does *not* alias rowid.)
 */
function findRowidAliasIndex(columnDefinitions) {
  for (let i = 0; i < columnDefinitions.length; i++) {
    const { rest } = columnDefinitions[i];
    if (/\bINTEGER\s+PRIMARY\s+KEY\b/i.test(rest) && !/\bPRIMARY\s+KEY\s+DESC\b/i.test(rest)) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------------- *
 * Database object
 * ------------------------------------------------------------------------- */

function createDatabase(fileBuffer, header, options = {}) {
  const { pageSize, usableSize, encoding } = header;
  const bigInt = options.bigInt === true;

  /** Return page `pageNumber` (1-based) as a Buffer view; never reads past EOF. */
  function getPage(pageNumber) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      fail(`invalid page number ${pageNumber} (pages are numbered from 1)`);
    }
    const start = (pageNumber - 1) * pageSize;
    if (start + pageSize > fileBuffer.length) {
      fail(
        `page ${pageNumber} is past the end of the file: it needs bytes ${start}..${start + pageSize} ` +
          `but the file is only ${fileBuffer.length} byte(s) long (truncated database)`,
      );
    }
    return fileBuffer.subarray(start, start + pageSize);
  }

  /**
   * Read a cell payload, following the overflow chain when the payload does not
   * fit in the page. Chains are 4-byte next-page + up to (usableSize - 4) data.
   */
  function readPayload(page, payloadStart, payloadSize, label, pageNumber) {
    // A corrupt cell can claim an absurd payload length. No record can be larger
    // than the file itself, so reject that before allocating anything.
    if (payloadSize > fileBuffer.length) {
      fail(
        `${label}: cell on page ${pageNumber} claims a ${payloadSize}-byte payload, but the whole ` +
          `file is only ${fileBuffer.length} byte(s) (corrupt payload length)`,
      );
    }

    const localSize = localPayloadSize(payloadSize, usableSize);
    if (localSize === payloadSize) {
      checkRange(page, payloadStart, payloadSize, `${label}: payload of page ${pageNumber}`);
      return Buffer.from(page.subarray(payloadStart, payloadStart + payloadSize));
    }

    checkRange(page, payloadStart, localSize + 4, `${label}: local payload of page ${pageNumber}`);
    const payload = Buffer.allocUnsafe(payloadSize);
    page.copy(payload, 0, payloadStart, payloadStart + localSize);
    let written = localSize;
    let nextPage = page.readUInt32BE(payloadStart + localSize);
    const visited = new Set([pageNumber]);

    while (written < payloadSize) {
      if (nextPage === 0) {
        fail(
          `${label}: overflow chain ended after ${written} of ${payloadSize} payload byte(s) ` +
            `for the cell on page ${pageNumber}`,
        );
      }
      if (visited.has(nextPage)) {
        fail(`${label}: cycle in the overflow page chain (page ${nextPage} seen twice)`);
      }
      visited.add(nextPage);

      const overflowPage = getPage(nextPage);
      const take = Math.min(payloadSize - written, usableSize - 4);
      checkRange(overflowPage, 4, take, `${label}: overflow data on page ${nextPage}`);
      overflowPage.copy(payload, written, 4, 4 + take);
      written += take;
      nextPage = overflowPage.readUInt32BE(0);
    }
    return payload;
  }

  /**
   * Walk a table B-tree in order, calling onRow(rowid, payloadBuffer).
   * Returning false from onRow stops the walk. Guards against cycles, repeated
   * page references and runaway depth.
   */
  function walkTable(rootPage, label, onRow) {
    const visited = new Set();
    let stopped = false;

    const walk = (pageNumber, depth) => {
      if (stopped) return;
      if (depth > MAX_BTREE_DEPTH) {
        fail(
          `${label}: B-tree is deeper than ${MAX_BTREE_DEPTH} levels (page ${pageNumber}); ` +
            `the file is corrupt or the child pointers loop`,
        );
      }
      if (visited.has(pageNumber)) {
        fail(`${label}: cycle detected — page ${pageNumber} is reached twice in the same B-tree`);
      }
      visited.add(pageNumber);

      const page = getPage(pageNumber);
      const base = pageNumber === 1 ? HEADER_SIZE : 0; // page 1 starts after the file header
      checkRange(page, base, 8, `${label}: B-tree header of page ${pageNumber}`);

      const pageType = page[base];
      const cellCount = u16(page, base + 3, `${label}: cell count of page ${pageNumber}`);

      if (pageType === 0x0d) {
        // Leaf table page: [varint payload size][varint rowid][payload]
        const pointerBase = base + 8;
        checkRange(page, pointerBase, cellCount * 2, `${label}: cell pointers of page ${pageNumber}`);
        for (let i = 0; i < cellCount && !stopped; i++) {
          const cellOffset = u16(page, pointerBase + 2 * i, `${label}: cell pointer ${i} of page ${pageNumber}`);
          if (cellOffset < pointerBase + cellCount * 2) {
            fail(
              `${label}: cell ${i} of page ${pageNumber} points at offset ${cellOffset}, ` +
                `inside the page header (content starts at ${pointerBase + cellCount * 2})`,
            );
          }
          if (cellOffset >= usableSize) {
            fail(`${label}: cell ${i} of page ${pageNumber} points at offset ${cellOffset}, beyond the usable area ${usableSize}`);
          }
          const payloadInfo = readVarint(page, cellOffset, `${label}: payload size of page ${pageNumber}, cell ${i}`);
          const payloadSize = toSafeNumber(payloadInfo.value, `${label}: payload size`);
          const rowidInfo = readVarint(page, payloadInfo.next, `${label}: rowid of page ${pageNumber}, cell ${i}`);
          const rowid = Number(rowidInfo.value);
          const payload = readPayload(page, rowidInfo.next, payloadSize, label, pageNumber);
          if (onRow(rowid, payload) === false) stopped = true;
        }
        return;
      }

      if (pageType === 0x05) {
        // Interior table page: [u32 left child][varint key] per cell, plus a
        // right-most child pointer in the header.
        const rightMostChild = u32(page, base + 8, `${label}: right-most child of page ${pageNumber}`);
        const pointerBase = base + 12;
        checkRange(page, pointerBase, cellCount * 2, `${label}: cell pointers of page ${pageNumber}`);
        for (let i = 0; i < cellCount && !stopped; i++) {
          const cellOffset = u16(page, pointerBase + 2 * i, `${label}: cell pointer ${i} of page ${pageNumber}`);
          if (cellOffset < pointerBase + cellCount * 2) {
            fail(`${label}: interior cell ${i} of page ${pageNumber} points into the page header (offset ${cellOffset})`);
          }
          if (cellOffset + 4 > usableSize) {
            fail(`${label}: interior cell ${i} of page ${pageNumber} at offset ${cellOffset} does not fit in the usable area`);
          }
          const child = u32(page, cellOffset, `${label}: child pointer of page ${pageNumber}, cell ${i}`);
          walk(child, depth + 1);
        }
        if (!stopped) walk(rightMostChild, depth + 1);
        return;
      }

      fail(
        `${label}: page ${pageNumber} has B-tree type 0x${pageType.toString(16).padStart(2, '0')}, ` +
          `but only table pages (0x05 interior, 0x0d leaf) are supported`,
      );
    };

    walk(rootPage, 0);
  }

  /* ---- schema ---------------------------------------------------------- */

  const tablesByName = new Map();
  const tableOrder = [];

  walkTable(1, 'sqlite_master', (rowid, payload) => {
    let values;
    try {
      // The schema is always decoded with plain numbers: rootpage, and the
      // integer columns of sqlite_master, are small and internal.
      values = parseRecord(payload, encoding, `sqlite_master row ${rowid}`);
    } catch (error) {
      fail(`could not decode sqlite_master row ${rowid}: ${error.message}`);
    }
    // sqlite_master columns: type, name, tbl_name, rootpage, sql
    const [type, name, , rootPage, sql] = values;
    if (type !== 'table') return true;
    if (typeof name !== 'string' || name.length === 0) return true;
    if (typeof sql !== 'string') return true; // internal/auto indexes have no SQL; tables always do
    if (/^\s*CREATE\s+VIRTUAL\b/i.test(sql)) return true; // virtual tables have no B-tree of their own
    if (!Number.isInteger(rootPage) || rootPage < 1) return true;

    const definitions = parseColumnDefinitions(sql);
    const entry = {
      name,
      rootPage,
      sql,
      columns: definitions.map((definition) => definition.name),
      rowidAliasIndex: findRowidAliasIndex(definitions),
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
    };
    tablesByName.set(name, entry);
    tableOrder.push(name);
    return true;
  });

  /**
   * Turn a decoded record into a row object.
   *
   * Two SQLite record quirks are handled here:
   *  1. Leading rowid value: when a record carries one value more than the
   *     CREATE TABLE declares, the extra leading value is the rowid and is
   *     exposed as `rowid`; the remaining values map positionally.
   *  2. INTEGER PRIMARY KEY alias: SQLite writes NULL in that column and keeps
   *     the real value in the B-tree key, so we put the cell rowid back.
   */
  function mapRecordToRow(table, values, rowid) {
    const columns = table.columns;
    const row = {};

    if (values.length === columns.length + 1) {
      row.rowid = values[0];
      for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i + 1];
      return row;
    }

    const count = Math.min(columns.length, values.length);
    for (let i = 0; i < count; i++) row[columns[i]] = values[i];

    const alias = table.rowidAliasIndex;
    if (
      values.length === columns.length &&
      alias >= 0 &&
      alias < columns.length &&
      row[columns[alias]] === null
    ) {
      row[columns[alias]] = rowid;
    }

    // Expose the B-tree key on every row (unless the table itself declares a
    // column literally named "rowid", in which case the declared value wins).
    if (!Object.prototype.hasOwnProperty.call(row, 'rowid')) row.rowid = rowid;
    return row;
  }

  function getTable(tableName) {
    const table = tablesByName.get(String(tableName));
    if (!table) {
      // A live WAL database can keep its newest schema *and* rows entirely in
      // the -wal file, leaving the main file with an empty sqlite_master. Point
      // that out instead of a bare "no such table", which would look like a bug.
      const hint = database.hasWal
        ? ` (a -wal file is present; this reader never replays the WAL, so the table may ` +
          `only exist there — close the application or checkpoint the database and retry)`
        : '';
      fail(`no such table: ${String(tableName)}${hint}`);
    }
    return table;
  }

  /* ---- public API ------------------------------------------------------ */

  const database = {
    pageSize,
    usableSize,
    pageCount: header.pageCount,
    hasWal: false,

    tables() {
      return tableOrder.slice();
    },

    columns(tableName) {
      return getTable(tableName).columns.slice();
    },

    query(tableName, options) {
      const table = getTable(tableName);
      if (table.withoutRowid) {
        fail(`table "${table.name}" is declared WITHOUT ROWID, which this reader does not support`);
      }
      if (table.columns.length === 0) {
        fail(`table "${table.name}": could not parse any column names from: ${table.sql}`);
      }

      const opts = options == null ? {} : options;
      const rawLimit = opts.limit;
      let limit = Infinity;
      if (rawLimit !== undefined && rawLimit !== null) {
        if (typeof rawLimit !== 'number' || Number.isNaN(rawLimit)) {
          fail(`query("${table.name}"): options.limit must be a number`);
        }
        limit = rawLimit <= 0 ? 0 : Math.floor(rawLimit);
      }
      const where = opts.where;
      if (where != null && typeof where !== 'function') {
        fail(`query("${table.name}"): options.where must be a function`);
      }

      const rows = [];
      if (limit === 0) return rows;

      walkTable(table.rootPage, `table "${table.name}"`, (rowid, payload) => {
        let values;
        try {
          values = parseRecord(payload, encoding, `table "${table.name}" row ${rowid}`, { bigInt });
        } catch (error) {
          fail(`could not decode row ${rowid} of table "${table.name}": ${error.message}`);
        }
        const row = mapRecordToRow(table, values, bigInt ? BigInt(rowid) : rowid);
        if (where && !where(row)) return true;
        rows.push(row);
        return rows.length < limit;
      });

      return rows;
    },

    close() {
      // Nothing to release: the whole file lives in a caller-supplied Buffer.
    },
  };

  return database;
}

/* ------------------------------------------------------------------------- *
 * Public entry points
 * ------------------------------------------------------------------------- */

/**
 * Parse a whole database file held in memory.
 *
 * @param {Buffer|Uint8Array} buffer raw file bytes
 * @param {{ bigInt?: boolean }} [options] `bigInt: true` returns integers as
 *   BigInt (exact beyond 2^53); the default returns plain numbers.
 */
export function readDatabase(buffer, options = {}) {
  if (buffer == null) fail('readDatabase(buffer): buffer is required');
  let fileBuffer;
  if (Buffer.isBuffer(buffer)) fileBuffer = buffer;
  else if (buffer instanceof Uint8Array) fileBuffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  else fail(`readDatabase(buffer): expected a Buffer or Uint8Array, got ${typeof buffer}`);

  const header = parseFileHeader(fileBuffer);
  return createDatabase(fileBuffer, header, options);
}

/**
 * Open a file and parse it. Throws a descriptive Error on unreadable files.
 *
 * @param {string} filePath
 * @param {{ bigInt?: boolean }} [options]
 */
export function openDatabase(filePath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(`cannot open "${filePath}": ${error.message}`);
  }
  if (stat.isDirectory()) fail(`cannot open "${filePath}": it is a directory`);

  let buffer;
  try {
    // Plain read of the current bytes; no locks, no shared memory, no -wal replay.
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    // Preserve the original error as `cause` so callers can tell a busy file
    // (EBUSY / EPERM / EACCES, e.g. a browser holding its cookie store open)
    // from a genuinely corrupt one — the two need different guidance.
    const wrapped = new Error(`sqlite: cannot read "${filePath}": ${error.message}`);
    wrapped.cause = error;
    wrapped.code = error.code;
    throw wrapped;
  }

  const database = readDatabase(buffer, options);
  // A live database may have committed newer pages into the write-ahead log.
  // We intentionally do not parse the WAL, so tell the caller data may be stale.
  database.hasWal = fs.existsSync(`${filePath}-wal`);
  return database;
}
