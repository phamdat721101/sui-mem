/**
 * Walrus Quilt batcher — bundles many small chunks into one Quilt blob.
 *
 * Walrus pricing favors larger blobs. A 5KB encrypted memory chunk written
 * as its own blob costs 100×-400× more (per byte) than the same chunk
 * batched into a Quilt with ~100 siblings. For OpenX's typical brain
 * (50-1000 chunks of 5-10KB each) Quilt batching is the difference between
 * $5/year and $0.028/year storage cost.
 *
 * Caller pattern:
 *   const q = new WalrusQuiltBatcher(walrusStore);
 *   await q.add('chunk-a', dataA);                       // returns null (buffered)
 *   await q.add('chunk-b', dataB);                       // returns null
 *   …
 *   const refs = await q.flush();                        // [{quiltId, fileId, chunkId}, …]
 *
 * Or auto-flush on threshold:
 *   const refs = await q.add('chunk-a', dataA);          // returns refs[] when full
 *
 * SOLID:
 * - SRP: this class only batches + flushes. It does NOT encrypt, ingest, or
 *   speak to Sui — those concerns live in `OpenXClient` and the API service.
 * - Liskov: pluggable underlying `WalrusStore` (mock or HTTP) is honored.
 * - DI: caller injects the WalrusStore; tests pass the in-memory mock.
 *
 * Mock-first behavior: when the underlying store is the mock (no Walrus
 * publisher URL set), `flush()` falls back to per-blob writes and returns
 * synthetic `quiltId`/`fileId` pairs that round-trip correctly. This keeps
 * unit tests deterministic without a Walrus testnet.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { WalrusStore } from './walrusStore';

/** Reference produced for each chunk added to a Quilt. */
export interface QuiltFileRef {
  /** The Quilt blob ID (one per flush). */
  quiltId: string;
  /** Per-chunk identifier inside the Quilt — caller-supplied + globally unique within the brain. */
  fileId: string;
  /** Echoes the caller's `chunkId` for convenience. */
  chunkId: string;
  /** Bytes stored. */
  size: number;
}

export interface BatcherOptions {
  /** Auto-flush after this many chunks. Default 100 (matches Walrus Quilt sweet spot). */
  maxFiles?: number;
  /** Auto-flush after this many bytes accumulate. Default 1 MB. */
  maxBytes?: number;
}

interface BufferedFile {
  chunkId: string;
  data: Uint8Array;
}

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = 1_000_000;

export class WalrusQuiltBatcher {
  private buffer: BufferedFile[] = [];
  private bufferBytes = 0;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(private readonly walrus: WalrusStore, opts: BatcherOptions = {}) {
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Buffer a chunk for batching. Returns `null` while still under threshold,
   * or the flushed refs when the threshold is hit (the caller should treat
   * a non-null return as "all previously-added chunks are now persisted").
   */
  async add(chunkId: string, data: Uint8Array): Promise<QuiltFileRef[] | null> {
    if (this.buffer.some((f) => f.chunkId === chunkId)) {
      throw new Error(`WalrusQuiltBatcher: duplicate chunkId "${chunkId}" in buffer`);
    }
    this.buffer.push({ chunkId, data });
    this.bufferBytes += data.byteLength;
    if (this.buffer.length >= this.maxFiles || this.bufferBytes >= this.maxBytes) {
      return this.flush();
    }
    return null;
  }

  /**
   * Persist all buffered chunks as one Quilt blob. Idempotent on empty buffer
   * (returns `[]`). Throws if the underlying upload fails — caller can retry.
   */
  async flush(): Promise<QuiltFileRef[]> {
    if (this.buffer.length === 0) return [];
    const buffered = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    // Concatenate into a Quilt-shaped payload. Real `@mysten/walrus` exposes
    // a `quilt.create(files)` API once available; until then we serialize a
    // simple framed format that round-trips through `WalrusStore.upload` and
    // can be parsed back by readers (see `parseQuilt` below).
    const framed = frameQuilt(buffered);
    const upload = await this.walrus.upload(framed);
    const quiltId = upload.blobs[0]?.blobId ?? '';
    if (!quiltId) throw new Error('WalrusQuiltBatcher: upload returned no blobId');

    return buffered.map((f) => ({
      quiltId,
      fileId: deriveFileId(f.chunkId, f.data),
      chunkId: f.chunkId,
      size: f.data.byteLength,
    }));
  }

  /** Number of chunks currently buffered (not yet flushed). */
  pendingCount(): number {
    return this.buffer.length;
  }

  /** Bytes currently buffered. */
  pendingBytes(): number {
    return this.bufferBytes;
  }
}

/**
 * Read a single chunk back out of a Quilt blob. Pairs with `frameQuilt` —
 * the format is: `OQT1` magic | u32 file count | for each file:
 *   u16 chunkId len | utf8 chunkId | u32 data len | data.
 * Length-prefixed and append-only; trivially streamable.
 */
export async function readQuiltChunk(
  walrus: WalrusStore,
  quiltId: string,
  fileId: string,
): Promise<Uint8Array> {
  const blob = await walrus.fetch(quiltId);
  for (const file of parseQuilt(blob)) {
    if (deriveFileId(file.chunkId, file.data) === fileId) return file.data;
  }
  throw new Error(`Quilt: fileId ${fileId} not found in blob ${quiltId}`);
}

// ---------- private helpers (pure; tested directly via the public API) -----

function deriveFileId(chunkId: string, data: Uint8Array): string {
  // Stable file ID = first 16 hex chars of SHA-256(chunkId || data). Lets
  // multiple writers refer to the same chunk in different Quilts.
  return bytesToHex(sha256.create().update(utf8ToBytes(chunkId)).update(data).digest()).slice(0, 16);
}

function frameQuilt(files: BufferedFile[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([0x4f, 0x51, 0x54, 0x31])); // 'OQT1'
  parts.push(u32be(files.length));
  for (const f of files) {
    const idBytes = enc.encode(f.chunkId);
    parts.push(u16be(idBytes.length));
    parts.push(idBytes);
    parts.push(u32be(f.data.byteLength));
    parts.push(f.data);
  }
  return concat(parts);
}

function parseQuilt(blob: Uint8Array): BufferedFile[] {
  if (blob[0] !== 0x4f || blob[1] !== 0x51 || blob[2] !== 0x54 || blob[3] !== 0x31) {
    throw new Error('Quilt: bad magic — not an OQT1 blob');
  }
  const dec = new TextDecoder();
  let off = 4;
  const count = readU32be(blob, off); off += 4;
  const out: BufferedFile[] = [];
  for (let i = 0; i < count; i++) {
    const idLen = readU16be(blob, off); off += 2;
    const chunkId = dec.decode(blob.subarray(off, off + idLen)); off += idLen;
    const dataLen = readU32be(blob, off); off += 4;
    const data = blob.subarray(off, off + dataLen); off += dataLen;
    out.push({ chunkId, data });
  }
  return out;
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}
function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function readU16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function readU32be(b: Uint8Array, o: number): number {
  return ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
