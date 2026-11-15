// pack.ts — git object model, pkt-line codec, packfile read/write.
//
// Node 22 stdlib only (node:crypto, node:zlib). No import of src/store.ts:
// object bytes and pack bytes are pure functions over Buffers; the store is
// only touched by src/git.ts through its structural GitStore interface.
//
// Object ids are SHA-1 over "<type> <len>\0<bytes>", exactly as git computes
// them. Packfiles are version 2, undeltad on write; the reader resolves
// OFS_DELTA (type 6) and REF_DELTA (type 7), including thin packs whose
// REF_DELTA base lives outside the pack (resolveBase callback).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn ref's old/new value. */
export const ZERO_OID = '0'.repeat(40);
/** git's LARGE_PACKET_MAX: largest pkt-line including its 4-byte header. */
export const PKT_LINE_MAX = 65520;
/** Largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest sideband data chunk: pkt-line max minus header minus band byte. */
export const SIDEBAND_MAX_CHUNK = PKT_LINE_MAX - 4 - 1;

/** The four git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact bytes (no header). */
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** The loose-object header "<type> <size>\0" that prefixes hashed bytes. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** git's object id: SHA-1 over the header + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** Full loose-object bytes (header + content). */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries, in stored order. Throws on bad bytes. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buf.length) throw new Error('tree entry has a truncated object id');
    const mode = buf.subarray(off, space).toString('ascii');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as name + '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted git-style. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Header lines other than tree/parent/author/committer, in order. */
  extraHeaders: Array<readonly [string, string]>;
}

/** Parse a commit object; refuses a missing/invalid tree header. */
export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of buf.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildCommitFields {
  tree: string;
  parents?: readonly string[];
  /** Full identity "Name <email>"; defaults to the forge identity. */
  author?: string;
  committer?: string;
  message: string;
  /** Unix seconds; defaults to the store epoch 2025-01-01T00:00:00Z. */
  timestamp?: number;
  timezone?: string;
}

/** Default identity for commits/tags this module builds. */
export const FORGE_IDENTITY = 'Muse <muse@localhost>';
/** 2025-01-01T00:00:00Z, the deterministic epoch shared with the store. */
export const FORGE_EPOCH = 1735689600;

/** Build a commit object's bytes. `message` should end with "\n". */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface BuildTagFields {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}

/** Build an annotated tag object's bytes. `message` should end with "\n". */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? FORGE_EPOCH;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush' | 'delim' | 'response-end' are control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Incremental pkt-line decoder. Push chunks as they arrive; next() returns a
 * packet when one is complete and null when more bytes are needed. Throws on a
 * malformed header or a truncated stream after finish(). takeBuffered()
 * returns every unconsumed byte (used to split a receive-pack command list
 * from the raw pack that follows it).
 */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('pkt-line decoder received bytes after finish()');
    if (!chunk.length) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  finish(): void {
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new Error('pkt-line decoder underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Remove and return every buffered byte. */
  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new Error(`truncated pkt-line: ${this.buffered} trailing byte(s)`);
      }
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header.toString('ascii'))}`);
    }
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (this.buffered < length) {
      if (this.ended) {
        throw new Error(`truncated pkt-line: ${length} announced, ${this.buffered} available`);
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
}

/** Decode a complete buffer into packets; refuses trailing bytes. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  if (decoder.bufferedBytes > 0) throw new Error('trailing bytes after pkt-line stream');
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// sideband (band 1 = pack data, band 2 = progress, band 3 = error)
// ---------------------------------------------------------------------------

/**
 * Frame `data` as sideband band packets: each pkt-line carries one band byte
 * plus at most SIDEBAND_MAX_CHUNK data bytes. Returns the concatenated
 * pkt-line bytes (no trailing flush; callers add one).
 */
export function encodeSideband(band: 1 | 2 | 3, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const parts: Buffer[] = [];
  for (let off = 0; off < body.length; off += SIDEBAND_MAX_CHUNK) {
    const chunk = body.subarray(off, Math.min(body.length, off + SIDEBAND_MAX_CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(encodePktLine(payload));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packfile write (version 2, plain objects, no deltas)
// ---------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObjectInput {
  type: GitObjectType;
  data: Uint8Array;
}

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's.
 * The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

// ---------------------------------------------------------------------------
// packfile read (version 2/3, OFS_DELTA + REF_DELTA, thin-pack aware)
// ---------------------------------------------------------------------------

export interface PackEntry {
  /** Byte offset of this entry's header in the pack. */
  offset: number;
  /** Resolved object type (deltas report their base's type). */
  type: GitObjectType;
  /** Declared inflated size of the entry's own data (delta bytes for deltas). */
  size: number;
  /** The entry's own inflated bytes (delta instructions for delta entries). */
  data: Buffer;
  oid: string;
  delta: { kind: 'ofs' | 'ref'; baseOid: string } | null;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  entries: PackEntry[];
  trailer: string;
  computedTrailer: string;
  checksumOk: boolean;
  deltaCount: number;
  byteLength: number;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out (an object the peer already holds). Every entry's declared size
 * is checked against its inflated bytes; a mismatch is an error. A bad
 * trailer is reported via checksumOk, not thrown.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }

  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk,
    deltaCount,
    byteLength: buffer.length,
  };
}
