/**
 * sqlite.test.mjs — self-test for ./sqlite.js (zero dependencies).
 *
 * Every fixture is generated here, byte by byte: a 100-byte file header, a
 * sqlite_master leaf on page 1, table leaves, an interior page, and overflow
 * chain pages. No external .db file is needed.
 *
 * Run: node src/sqlite.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { readDatabase, openDatabase } from './sqlite.js';

/* ======================================================================= *
 * Assertions
 * ======================================================================= */

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${format(expected)} but got ${format(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e} but got ${a}`);
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes ${value.toString('hex').slice(0, 40)}…>`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Run fn and require it to throw an Error whose message mentions `needle`. */
function assertThrows(fn, needle, label) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error(`${label}: expected a thrown Error, but nothing was thrown`);
  if (!(thrown instanceof Error)) throw new Error(`${label}: threw a non-Error value: ${format(thrown)}`);
  const message = thrown.message || '';
  if (needle && !message.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(`${label}: error message ${format(message)} does not mention ${format(needle)}`);
  }
  if (thrown instanceof RangeError) {
    throw new Error(`${label}: a RangeError (out-of-bounds read) escaped instead of a descriptive Error: ${message}`);
  }
  return thrown;
}

/* ======================================================================= *
 * Fixture writer: SQLite file format primitives
 * ======================================================================= */

const MASTER_HEADER_BYTES = 100;

function varintLength(value) {
  let v = BigInt(value);
  let n = 1;
  while (v >= 0x80n && n < 8) {
    v >>= 7n;
    n += 1;
  }
  return n;
}

/** SQLite varint encoder (1..8 bytes; the 9-byte form is not needed here). */
function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('fixture: varints are unsigned');
  const groups = [];
  do {
    groups.unshift(Number(v & 0x7fn));
    v >>= 7n;
  } while (v > 0n);
  if (groups.length > 8) throw new Error('fixture: value too large for the 8-byte varint form');
  return Buffer.from(groups.map((g, i) => (i === groups.length - 1 ? g : g | 0x80)));
}

/** Big-endian two's-complement integer of `size` bytes. */
function encodeSigned(value, size) {
  let v = BigInt(value);
  if (v < 0n) v += 1n << BigInt(size * 8);
  const out = Buffer.alloc(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const encoders = {
  null: () => ({ serialType: 0, data: Buffer.alloc(0) }),
  int: (value, size) => {
    const limits = { 1: 8n, 2: 16n, 3: 24n, 4: 32n, 6: 48n, 8: 64n };
    const types = { 1: 1, 2: 2, 3: 3, 4: 4, 6: 5, 8: 6 };
    let chosen = size;
    if (!chosen) {
      const magnitude = BigInt(value) < 0n ? -BigInt(value) : BigInt(value);
      const bits = magnitude === 0n ? 1 : magnitude.toString(2).length + 1;
      for (const candidate of [1, 2, 3, 4, 6, 8]) {
        if (bits <= Number(limits[candidate])) {
          chosen = candidate;
          break;
        }
      }
      if (!chosen) throw new Error(`fixture: cannot encode integer ${value}`);
    }
    return { serialType: types[chosen], data: encodeSigned(value, chosen) };
  },
  real: (value) => {
    const data = Buffer.alloc(8);
    data.writeDoubleBE(value, 0);
    return { serialType: 7, data };
  },
  text: (value) => {
    const data = Buffer.from(value, 'utf8');
    return { serialType: 13 + 2 * data.length, data };
  },
  blob: (value) => {
    const data = Buffer.from(value);
    return { serialType: 12 + 2 * data.length, data };
  },
  int0: () => ({ serialType: 8, data: Buffer.alloc(0) }),
  int1: () => ({ serialType: 9, data: Buffer.alloc(0) }),
  reserved: (type) => ({ serialType: type, data: Buffer.alloc(0) }),
};

/**
 * Serialise a record payload: [header length varint][serial type varints...]
 * followed by the value bytes in the same order.
 */
function buildRecord(fields) {
  const serialBytes = fields.map((field) => encodeVarint(field.serialType));
  const body = Buffer.concat(fields.map((field) => field.data));
  const serialTotal = serialBytes.reduce((sum, b) => sum + b.length, 0);
  let headerVarintLength = 1;
  while (varintLength(headerVarintLength + serialTotal) !== headerVarintLength) headerVarintLength += 1;
  const headerSize = headerVarintLength + serialTotal;
  assertEqual(headerSize, varintLength(headerSize) + serialTotal, 'fixture: record header size is self-consistent');
  return Buffer.concat([encodeVarint(headerSize), ...serialBytes, body]);
}

/** SQLite's local-payload split (same formulas the reader must implement). */
function localPayloadSize(payloadSize, usableSize) {
  const maxLocal = usableSize - 35;
  const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
  if (payloadSize <= maxLocal) return payloadSize;
  const surplus = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
  return surplus <= maxLocal ? surplus : minLocal;
}

/* ======================================================================= *
 * Fixture writer: B-tree pages
 * ======================================================================= */

class DbBuilder {
  constructor(pageSize = 4096) {
    this.pageSize = pageSize;
    this.usableSize = pageSize; // no reserved bytes in these fixtures
    this.pages = [null]; // pages[n - 1] is page n; page 1 is reserved for sqlite_master
  }

  alloc() {
    this.pages.push(null);
    return this.pages.length;
  }

  setPage(pageNumber, buffer) {
    this.pages[pageNumber - 1] = buffer;
  }

  /**
   * Build a table-leaf cell. When the payload is too large for the page, the
   * spilled bytes are written into freshly allocated overflow pages and the
   * cell ends with the 4-byte first-overflow-page pointer.
   */
  makeRowCell(rowid, payload) {
    const localSize = localPayloadSize(payload.length, this.usableSize);
    const chunks = [];
    if (localSize < payload.length) {
      const rest = payload.subarray(localSize);
      const perPage = this.usableSize - 4;
      for (let i = 0; i < rest.length; i += perPage) chunks.push(rest.subarray(i, i + perPage));
    }

    let overflowPointer = Buffer.alloc(0);
    if (chunks.length > 0) {
      const pageNumbers = chunks.map(() => this.alloc());
      chunks.forEach((chunk, index) => {
        const page = Buffer.alloc(this.pageSize);
        const next = index + 1 < chunks.length ? pageNumbers[index + 1] : 0;
        page.writeUInt32BE(next, 0);
        chunk.copy(page, 4);
        this.setPage(pageNumbers[index], page);
      });
      overflowPointer = Buffer.alloc(4);
      overflowPointer.writeUInt32BE(pageNumbers[0], 0);
    }

    return Buffer.concat([
      encodeVarint(payload.length),
      encodeVarint(rowid),
      payload.subarray(0, localSize),
      overflowPointer,
    ]);
  }

  /** Leaf page (0x0d). `base` is 100 for page 1 (after the file header). */
  buildLeafPage(cellBuffers, base) {
    const page = Buffer.alloc(this.pageSize);
    const pointerBase = base + 8;
    const capacity = this.usableSize - pointerBase;
    let contentTop = this.pageSize;
    const pointers = [];

    for (const cell of cellBuffers) {
      contentTop -= cell.length;
      cell.copy(page, contentTop);
      pointers.push(contentTop);
    }
    if (contentTop < pointerBase + 2 * cellBuffers.length) {
      throw new Error('fixture: leaf page overflows; the test splitter should have made another leaf');
    }
    if (pointers.some((pointer) => pointer < pointerBase + 2 * cellBuffers.length)) {
      throw new Error('fixture: cell content overlaps the pointer array');
    }
    assert(contentTop >= 0 && contentTop + 0 <= this.pageSize, 'fixture: content start inside page');
    assert(capacity > 0, 'fixture: page capacity positive');

    page[base] = 0x0d; // table leaf
    page.writeUInt16BE(0, base + 1); // no freeblocks
    page.writeUInt16BE(cellBuffers.length, base + 3);
    page.writeUInt16BE(contentTop, base + 5); // start of the cell content area
    page[base + 7] = 0; // no fragmented free bytes
    pointers.forEach((pointer, i) => page.writeUInt16BE(pointer, pointerBase + 2 * i));
    return page;
  }

  /** Interior table page (0x05) with `entries` children plus a right-most child. */
  buildInteriorPage(entries, rightMostChild, base = 0) {
    const page = Buffer.alloc(this.pageSize);
    const pointerBase = base + 12;
    const cells = entries.map(({ child, key }) => {
      const keyBytes = encodeVarint(key);
      const cell = Buffer.alloc(4 + keyBytes.length);
      cell.writeUInt32BE(child, 0);
      keyBytes.copy(cell, 4);
      return cell;
    });

    let contentTop = this.pageSize;
    const pointers = [];
    for (const cell of cells) {
      contentTop -= cell.length;
      cell.copy(page, contentTop);
      pointers.push(contentTop);
    }
    if (contentTop < pointerBase + 2 * cells.length) throw new Error('fixture: interior page overflows');

    page[base] = 0x05; // table interior
    page.writeUInt16BE(0, base + 1);
    page.writeUInt16BE(cells.length, base + 3);
    page.writeUInt16BE(contentTop, base + 5);
    page[base + 7] = 0;
    page.writeUInt32BE(rightMostChild, base + 8);
    pointers.forEach((pointer, i) => page.writeUInt16BE(pointer, pointerBase + 2 * i));
    return page;
  }

  /**
   * Build a table from rows ({ rowid, payload }): split into as many leaves as
   * needed, then add an interior root when there is more than one leaf.
   * Returns the root page number.
   */
  buildTable(rows) {
    const capacity = this.usableSize - 8 - 2; // page header + at least one pointer
    const groups = [];
    let current = [];
    let usedBytes = 0;

    for (const row of rows) {
      const cell = this.makeRowCell(row.rowid, row.payload);
      const fits = usedBytes + cell.length + 2 * (current.length + 1) <= capacity;
      if (current.length > 0 && !fits) {
        groups.push(current);
        current = [];
        usedBytes = 0;
      }
      current.push({ rowid: row.rowid, cell });
      usedBytes += cell.length;
    }
    if (current.length > 0) groups.push(current);

    const leaves = groups.map((cells) => {
      const pageNumber = this.alloc();
      this.setPage(pageNumber, this.buildLeafPage(cells.map((entry) => entry.cell), 0));
      return { pageNumber, cells };
    });

    if (leaves.length === 1) return leaves[0].pageNumber;
    if (leaves.length > 200) throw new Error('fixture: too many leaves for a single interior root');

    const root = this.alloc();
    const entries = leaves.slice(0, -1).map((leaf) => ({
      child: leaf.pageNumber,
      key: leaf.cells[leaf.cells.length - 1].rowid,
    }));
    const rightMost = leaves[leaves.length - 1].pageNumber;
    this.setPage(root, this.buildInteriorPage(entries, rightMost, 0));
    return root;
  }

  /** Write the 100-byte file header into page 1 and concatenate all pages. */
  finish() {
    const pageCount = this.pages.length;
    for (let i = 0; i < pageCount; i++) {
      if (this.pages[i] == null) throw new Error(`fixture: page ${i + 1} was never written`);
    }
    const page1 = Buffer.from(this.pages[0]);
    const pageSizeField = this.pageSize === 65536 ? 1 : this.pageSize;

    page1.write('SQLite format 3\u0000', 0, 16, 'latin1'); // 0..15 magic
    page1.writeUInt16BE(pageSizeField, 16); // 16..17 page size (1 means 65536)
    page1[18] = 1; // write version: legacy (rollback journal)
    page1[19] = 1; // read version
    page1[20] = 0; // reserved bytes per page
    page1[21] = 64; // max embedded payload fraction
    page1[22] = 32; // min embedded payload fraction
    page1[23] = 32; // leaf payload fraction
    page1.writeUInt32BE(1, 24); // file change counter
    page1.writeUInt32BE(pageCount, 28); // database size in pages
    page1.writeUInt32BE(0, 32); // first freelist trunk page
    page1.writeUInt32BE(0, 36); // freelist page count
    page1.writeUInt32BE(1, 40); // schema cookie
    page1.writeUInt32BE(4, 44); // schema format number
    page1.writeUInt32BE(0, 48); // default page cache size
    page1.writeUInt32BE(0, 52); // largest root b-tree page
    page1.writeUInt32BE(1, 56); // text encoding: UTF-8
    page1.writeUInt32BE(0, 60); // user version
    page1.writeUInt32BE(0, 64); // incremental vacuum mode
    page1.writeUInt32BE(0, 68); // application id
    page1.writeUInt32BE(1, 92); // version-valid-for
    page1.writeUInt32BE(3045000, 96); // SQLite version number

    this.pages[0] = page1;
    return Buffer.concat(this.pages);
  }
}

/** Add a table entry to sqlite_master (page 1). */
function masterEntries(tables) {
  return tables.map((table, index) => ({
    rowid: index + 1,
    payload: buildRecord([
      encoders.text('table'),
      encoders.text(table.name),
      encoders.text(table.name),
      encoders.int(table.rootPage, 2),
      encoders.text(table.sql),
    ]),
  }));
}

/* ======================================================================= *
 * Fixture construction
 * ======================================================================= */

const BIG_ROW_COUNT = 120;
const OVERFLOW_BLOB = Buffer.alloc(9000);
for (let i = 0; i < OVERFLOW_BLOB.length; i++) OVERFLOW_BLOB[i] = (i * 31 + 7) & 0xff;
const OVERFLOW_TEXT = 'y'.repeat(6000);

const TYPES_SQL =
  'CREATE TABLE t_types (id INTEGER PRIMARY KEY, i1 INTEGER, i2 INTEGER, i3 INTEGER, ' +
  'i4 INTEGER, i6 INTEGER, i8 INTEGER, f REAL, txt TEXT, blob_col BLOB, nul TEXT, ' +
  'zero INTEGER, one INTEGER, res10 INTEGER, res11 INTEGER)';
const ROWID_PREFIX_SQL = 'CREATE TABLE t_rowid_prefix (a TEXT, b INTEGER)';
const BIG_SQL = 'CREATE TABLE t_big (id INTEGER PRIMARY KEY, name TEXT, score REAL)';
const OVERFLOW_SQL = 'CREATE TABLE t_overflow (id INTEGER PRIMARY KEY, blob_col BLOB, txt TEXT)';

function buildFixture(options = {}) {
  const pageSize = options.pageSize || 4096;
  const builder = new DbBuilder(pageSize);
  const tables = [];

  // --- t_types: one row exercising every serial type -----------------------
  const typesRoot = builder.alloc();
  const typesPayload = buildRecord([
    encoders.null(), // id: NULL, replaced by the rowid alias (7)
    encoders.int(127, 1),
    encoders.int(1234, 2),
    encoders.int(8388607, 3), // max 3-byte signed
    encoders.int(123456789, 4),
    encoders.int(2 ** 40 + 5, 6),
    encoders.int(2 ** 52 + 3, 8),
    encoders.real(3.5),
    encoders.text('héllo ✓'),
    encoders.blob(Buffer.from([0x00, 0xff, 0x10, 0x7f])),
    encoders.null(),
    encoders.int0(),
    encoders.int1(),
    encoders.reserved(10),
    encoders.reserved(11),
  ]);
  builder.setPage(typesRoot, builder.buildLeafPage([builder.makeRowCell(7, typesPayload)], 0));
  tables.push({ name: 't_types', rootPage: typesRoot, sql: TYPES_SQL });

  // --- t_rowid_prefix: record carries one more value than columns --------
  const prefixRoot = builder.alloc();
  const prefixPayload = buildRecord([
    encoders.int(42, 1), // leading rowid value
    encoders.text('alpha'),
    encoders.int(5, 1),
  ]);
  builder.setPage(prefixRoot, builder.buildLeafPage([builder.makeRowCell(42, prefixPayload)], 0));
  tables.push({ name: 't_rowid_prefix', rootPage: prefixRoot, sql: ROWID_PREFIX_SQL });

  // --- t_big: enough rows to span several leaves under one interior root --
  const bigRows = [];
  for (let i = 1; i <= BIG_ROW_COUNT; i++) {
    bigRows.push({
      rowid: i,
      payload: buildRecord([
        encoders.null(), // id INTEGER PRIMARY KEY -> rowid alias
        encoders.text(`row-${String(i).padStart(4, '0')}:${'x'.repeat(400)}`),
        encoders.real(i / 4),
      ]),
    });
  }
  const bigRoot = builder.buildTable(bigRows);
  tables.push({ name: 't_big', rootPage: bigRoot, sql: BIG_SQL });

  // --- t_overflow: oversized BLOB and TEXT force overflow chains ----------
  const overflowRows = [
    {
      rowid: 1,
      payload: buildRecord([encoders.null(), encoders.blob(OVERFLOW_BLOB), encoders.text('small')]),
    },
    {
      rowid: 2,
      payload: buildRecord([encoders.null(), encoders.blob(Buffer.from([1, 2, 3])), encoders.text(OVERFLOW_TEXT)]),
    },
  ];
  const overflowRoot = builder.buildTable(overflowRows);
  tables.push({ name: 't_overflow', rootPage: overflowRoot, sql: OVERFLOW_SQL });

  // --- page 1: sqlite_master leaf ---------------------------------------
  builder.setPage(
    1,
    builder.buildLeafPage(masterEntries(tables).map((entry) => builder.makeRowCell(entry.rowid, entry.payload)), MASTER_HEADER_BYTES),
  );

  const buffer = builder.finish();
  return { buffer, tables, bigRowCount: BIG_ROW_COUNT, pageSize };
}

/* ======================================================================= *
 * Test harness
 * ======================================================================= */

const results = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log(`\n${title}`);
}

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}`);
    const message = String((error && error.message) || error).split('\n').join('\n        ');
    console.log(`        ${message}`);
    if (error && error.stack && process.env.SQLITE_TEST_TRACE) console.log(error.stack);
  }
}

/* ======================================================================= *
 * Tests
 * ======================================================================= */

const fixture = buildFixture();
const db = readDatabase(fixture.buffer);

assertEqual(fixture.buffer.length % 4096, 0, 'fixture size is a whole number of pages');

section('Header and schema');

test('header parses: pageSize, page count', () => {
  assertEqual(db.pageSize, 4096, 'pageSize');
  assertEqual(db.pageCount, fixture.buffer.length / 4096, 'pageCount');
});

test('tables() returns the user tables', () => {
  assertDeepEqual(db.tables(), ['t_types', 't_rowid_prefix', 't_big', 't_overflow'], 'tables()');
});

test('columns() returns declared columns in order', () => {
  assertDeepEqual(
    db.columns('t_types'),
    ['id', 'i1', 'i2', 'i3', 'i4', 'i6', 'i8', 'f', 'txt', 'blob_col', 'nul', 'zero', 'one', 'res10', 'res11'],
    'columns(t_types)',
  );
  assertDeepEqual(db.columns('t_big'), ['id', 'name', 'score'], 'columns(t_big)');
  assertDeepEqual(db.columns('t_rowid_prefix'), ['a', 'b'], 'columns(t_rowid_prefix)');
});

section('Serial types');

test('integers: 1, 2, 3, 4, 6 and 8-byte forms', () => {
  const [row] = db.query('t_types');
  assertEqual(row.i1, 127, 'i1 (1-byte)');
  assertEqual(row.i2, 1234, 'i2 (2-byte)');
  assertEqual(row.i3, 8388607, 'i3 (3-byte)');
  assertEqual(row.i4, 123456789, 'i4 (4-byte)');
  assertEqual(row.i6, 2 ** 40 + 5, 'i6 (6-byte)');
  assertEqual(row.i8, 2 ** 52 + 3, 'i8 (8-byte)');
});

test('special integers 0 and 1 decode without payload bytes', () => {
  const [row] = db.query('t_types');
  assertEqual(row.zero, 0, 'zero (serial type 8)');
  assertEqual(row.one, 1, 'one (serial type 9)');
});

test('NULL and reserved serial types 10/11 decode as null', () => {
  const [row] = db.query('t_types');
  assertEqual(row.nul, null, 'nul');
  assertEqual(row.res10, null, 'res10');
  assertEqual(row.res11, null, 'res11');
  assert('nul' in row && 'res10' in row && 'res11' in row, 'null columns are present on the row object');
});

test('float (serial type 7) decodes', () => {
  const [row] = db.query('t_types');
  assertEqual(row.f, 3.5, 'f');
  assertEqual(db.query('t_big', { limit: 5 })[1].score, 0.5, 'negative-free float from t_big');
});

test('TEXT decodes as UTF-8', () => {
  const [row] = db.query('t_types');
  assertEqual(row.txt, 'héllo ✓', 'txt');
});

test('BLOB decodes byte-exact', () => {
  const [row] = db.query('t_types');
  assert(Buffer.isBuffer(row.blob_col), 'blob is a Buffer');
  assertEqual(row.blob_col.toString('hex'), '00ff107f', 'blob bytes');
});

section('Rowid handling');

test('INTEGER PRIMARY KEY surfaces the B-tree rowid in its column', () => {
  const [row] = db.query('t_types');
  assertEqual(row.id, 7, 'id aliased to rowid');
  assertEqual(row.rowid, 7, 'rowid property');
});

test('a record with one extra leading value maps it to rowid', () => {
  const [row] = db.query('t_rowid_prefix');
  assertEqual(row.rowid, 42, 'leading value is exposed as rowid');
  assertEqual(row.a, 'alpha', 'a');
  assertEqual(row.b, 5, 'b');
});

test('rowid is exposed on ordinary tables', () => {
  const [row] = db.query('t_big', { limit: 1 });
  assertEqual(row.rowid, 1, 'rowid of first row');
  assertEqual(row.id, 1, 'INTEGER PRIMARY KEY column');
});

section('Query options');

test('limit caps the number of returned rows', () => {
  assertEqual(db.query('t_big').length, BIG_ROW_COUNT, 'unlimited default');
  assertEqual(db.query('t_big', { limit: 3 }).length, 3, 'limit 3');
  assertEqual(db.query('t_big', { limit: 0 }).length, 0, 'limit 0');
  assertEqual(db.query('t_big', { limit: 5000 }).length, BIG_ROW_COUNT, 'limit above row count');
});

test('where filters rows', () => {
  const rows = db.query('t_big', { where: (row) => row.score > 10 });
  assertEqual(rows.length, BIG_ROW_COUNT - 40, 'rows with score > 10');
  assert(rows.every((row) => row.score > 10), 'all rows satisfy the predicate');
});

test('where and limit combine (limit applied after where)', () => {
  const rows = db.query('t_big', { where: (row) => row.id % 2 === 0, limit: 5 });
  assertDeepEqual(rows.map((row) => row.id), [2, 4, 6, 8, 10], 'first five even ids');
});

test('unknown table throws a descriptive Error', () => {
  assertThrows(() => db.query('nope'), 'no such table', 'query unknown table');
  assertThrows(() => db.columns('nope'), 'no such table', 'columns unknown table');
});

section('Multi-page tables and overflow');

test('multi-page table returns every row exactly once, in B-tree order', () => {
  const rows = db.query('t_big');
  assertEqual(rows.length, BIG_ROW_COUNT, 'row count');
  const ids = rows.map((row) => row.id);
  assertEqual(new Set(ids).size, BIG_ROW_COUNT, 'ids are unique');
  for (let i = 0; i < ids.length; i++) assertEqual(ids[i], i + 1, `row ${i} id`);
  assert(rows.every((row) => row.name.startsWith(`row-${String(row.id).padStart(4, '0')}:`)), 'names match ids');
  assertEqual(db.query('t_big', { where: (row) => row.id === BIG_ROW_COUNT }).length, 1, 'last row is reachable');
});

test('overflow chain returns a large BLOB intact', () => {
  const row = db.query('t_overflow')[0];
  assertEqual(row.id, 1, 'id');
  assertEqual(row.blob_col.length, OVERFLOW_BLOB.length, 'blob length');
  assert(Buffer.compare(row.blob_col, OVERFLOW_BLOB) === 0, 'blob bytes identical');
  assertEqual(row.txt, 'small', 'small text beside the blob');
});

test('overflow chain returns a large TEXT intact', () => {
  const row = db.query('t_overflow')[1];
  assertEqual(row.id, 2, 'id');
  assertEqual(row.txt.length, OVERFLOW_TEXT.length, 'text length');
  assertEqual(row.txt, OVERFLOW_TEXT, 'text content');
  assertEqual(row.blob_col.toString('hex'), '010203', 'small blob beside the text');
});

section('Corrupt input');

test('garbage buffer throws a descriptive Error', () => {
  const error = assertThrows(() => readDatabase(Buffer.alloc(4096, 0xaa)), 'bad file header', 'garbage');
  assert(error.message.includes('magic string'), 'message mentions the magic string');
});

test('empty and too-short buffers throw without an out-of-bounds read', () => {
  assertThrows(() => readDatabase(Buffer.alloc(0)), 'file header', 'empty buffer');
  assertThrows(() => readDatabase(Buffer.alloc(99, 0x00)), 'file header', '99-byte buffer');
});

test('buffer shorter than one page throws a descriptive Error', () => {
  // 1500 bytes has a valid magic + page-size field but cannot hold page 1.
  const error = assertThrows(() => readDatabase(fixture.buffer.subarray(0, 1500)), '4096-byte page', 'short page 1');
  assert(/1500 byte/.test(error.message), 'message states how short the file is');
});

test('a header claiming pages that are not present throws when they are read', () => {
  // One full page plus a fragment: the header still parses, but page 2 is gone.
  const truncated = readDatabase(fixture.buffer.subarray(0, 4096 + 1500));
  assertEqual(truncated.pageCount, 1, 'only whole pages are counted');
  assertDeepEqual(truncated.tables(), ['t_types', 't_rowid_prefix', 't_big', 't_overflow'], 'schema parses');
  assertThrows(() => truncated.query('t_types'), 'past the end of the file', 'missing table root page');
});

test('truncated data page throws on query, naming the page', () => {
  const truncated = readDatabase(fixture.buffer.subarray(0, 4096));
  assertDeepEqual(truncated.tables(), ['t_types', 't_rowid_prefix', 't_big', 't_overflow'], 'schema still parses');
  const error = assertThrows(() => truncated.query('t_big'), 'past the end of the file', 'truncated table page');
  assert(/page \d+/.test(error.message), 'message names the offending page');
});

test('cycle in the B-tree throws instead of looping forever', () => {
  const builder = new DbBuilder();
  const leafPage = builder.alloc();
  builder.setPage(
    leafPage,
    builder.buildLeafPage(
      [builder.makeRowCell(1, buildRecord([encoders.text('only row')]))],
      0,
    ),
  );
  const loopPage = builder.alloc();
  // An interior page with no cells whose right-most child is itself.
  builder.setPage(loopPage, builder.buildInteriorPage([], loopPage, 0));
  builder.setPage(
    1,
    builder.buildLeafPage(
      masterEntries([{ name: 't_loop', rootPage: loopPage, sql: 'CREATE TABLE t_loop (v TEXT)' }]).map((entry) =>
        builder.makeRowCell(entry.rowid, entry.payload),
      ),
      MASTER_HEADER_BYTES,
    ),
  );
  const looping = readDatabase(builder.finish());
  assertThrows(() => looping.query('t_loop'), 'cycle', 'self-referencing interior page');
});

test('readDatabase rejects non-buffer input', () => {
  assertThrows(() => readDatabase('not a buffer'), 'Buffer', 'string input');
});

test('a cell claiming an impossible payload length is rejected, not allocated', () => {
  // Build a leaf page whose first cell has a huuuge payload-size varint.
  const builder = new DbBuilder();
  const root = builder.alloc();
  const page = Buffer.alloc(4096);
  const cellOffset = 4096 - 16;
  page[0] = 0x0d;
  page.writeUInt16BE(1, 3); // one cell
  page.writeUInt16BE(cellOffset, 5);
  page.writeUInt16BE(cellOffset, 8);
  // 9-byte varint form encoding a value far beyond the file size.
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]).copy(page, cellOffset);
  page[cellOffset + 9] = 1; // rowid
  builder.setPage(root, page);
  builder.setPage(
    1,
    builder.buildLeafPage(
      masterEntries([{ name: 't_huge', rootPage: root, sql: 'CREATE TABLE t_huge (v TEXT)' }]).map((entry) =>
        builder.makeRowCell(entry.rowid, entry.payload),
      ),
      MASTER_HEADER_BYTES,
    ),
  );
  const huge = readDatabase(builder.finish());
  assertThrows(() => huge.query('t_huge'), 'payload', 'impossible payload length');
});

section('Filesystem API');

test('openDatabase reads a file, reports WAL presence, and leaves it untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sqlite-test-'));
  const file = path.join(dir, 'Cookies');
  try {
    fs.writeFileSync(file, fixture.buffer);
    const before = fs.statSync(file);

    const noWal = openDatabase(file);
    assertEqual(noWal.hasWal, false, 'no -wal file');
    assertDeepEqual(noWal.tables(), db.tables(), 'tables from disk');
    assertEqual(noWal.query('t_types')[0].txt, 'héllo ✓', 'row from disk');

    fs.writeFileSync(`${file}-wal`, Buffer.alloc(32));
    const withWal = openDatabase(file);
    assertEqual(withWal.hasWal, true, '-wal file detected');
    assertEqual(withWal.query('t_types').length, 1, 'main file still parsed');

    const after = fs.statSync(file);
    assertEqual(after.mtimeMs, before.mtimeMs, 'mtime unchanged');
    assertEqual(after.size, before.size, 'size unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDatabase reports a missing file and a directory descriptively', () => {
  assertThrows(() => openDatabase(path.join(os.tmpdir(), 'dsh-sqlite-does-not-exist.db')), 'cannot open', 'missing file');
  assertThrows(() => openDatabase(os.tmpdir()), 'directory', 'directory path');
});

test('close() is a no-op and repeated queries keep working', () => {
  const local = readDatabase(fixture.buffer);
  assertEqual(local.query('t_big', { limit: 2 }).length, 2, 'query before close');
  local.close();
  assertEqual(local.query('t_big', { limit: 2 }).length, 2, 'query after close');
});

section('Integer precision');

test('large integers round in the default mode (documented JS number limit)', () => {
  const builder = new DbBuilder();
  const root = builder.alloc();
  // 13300000000000001 exceeds Number.MAX_SAFE_INTEGER (9007199254740991), so the
  // fixture value must be written as a BigInt literal to stay exact.
  builder.setPage(
    root,
    builder.buildLeafPage(
      [builder.makeRowCell(1, buildRecord([encoders.int(13300000000000001n, 8)]))],
      0,
    ),
  );
  builder.setPage(
    1,
    builder.buildLeafPage(
      masterEntries([{ name: 't_ts', rootPage: root, sql: 'CREATE TABLE t_ts (ts INTEGER)' }]).map((entry) =>
        builder.makeRowCell(entry.rowid, entry.payload),
      ),
      MASTER_HEADER_BYTES,
    ),
  );
  const buffer = builder.finish();

  const plain = readDatabase(buffer).query('t_ts')[0].ts;
  assertEqual(typeof plain, 'number', 'default mode yields a number');
  // The literal 13300000000000001 is itself unrepresentable as a double, so
  // compare through BigInt: the default mode lands one ULP below the truth.
  assert(BigInt(plain) !== 13300000000000001n, 'default mode rounds (expected, documented)');
  assertEqual(plain, 13300000000000000, 'default mode returns the nearest representable double');

  const exact = readDatabase(buffer, { bigInt: true }).query('t_ts')[0];
  assertEqual(typeof exact.ts, 'bigint', 'bigInt mode yields a BigInt');
  assertEqual(exact.ts, 13300000000000001n, 'bigInt mode is exact');
  assertEqual(exact.rowid, 1n, 'rowid is a BigInt too');
});

section('Page sizes');

test('page size 65536 (stored as 1) is decoded', () => {
  const big = buildFixture({ pageSize: 65536 });
  const bigDb = readDatabase(big.buffer);
  assertEqual(bigDb.pageSize, 65536, 'pageSize 65536');
  assertDeepEqual(bigDb.query('t_types').map((row) => row.id), [7], 'rows readable with a 64 KiB page');
});

/* ======================================================================= *
 * Summary
 * ======================================================================= */

const failures = results.filter((entry) => !entry.ok);
const passed = results.length - failures.length;

console.log('\n' + '-'.repeat(68));
console.log(`SUMMARY: ${passed}/${results.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILED CASES:');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error && failure.error.message}`);
}
console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
console.log('-'.repeat(68));

process.exitCode = failures.length === 0 ? 0 : 1;
