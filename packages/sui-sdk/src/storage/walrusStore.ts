/**
 * Walrus content storage adapter.
 *
 * Two implementations behind the same `WalrusStore` interface:
 *   - **mock** (default): in-memory Map keyed by SHA-256(data). Works offline,
 *     deterministic blobIds, used for tests and local development.
 *   - **http**: PUT/GET against a real Walrus aggregator + publisher. Selected
 *     when `WALRUS_PUBLISHER_URL` and `WALRUS_AGGREGATOR_URL` are configured.
 *
 * SOLID:
 * - Liskov: both implementations satisfy `WalrusStore` exactly. Callers cannot
 *   tell which is in use; they only see `{ blobId, size }`.
 * - Open/Closed: future Walrus client SDKs (e.g. `@mysten/walrus`) plug in by
 *   adding a third `WalrusStore` implementation; the interface is stable.
 * - Dependency Inversion: callers depend on `WalrusStore`, not on `fetch` or
 *   any specific HTTP client.
 *
 * "Do not repeat sample mistake": every external HTTP call goes through
 * `resilientCall` from `@fhe-ai-context/runtime-utils`. There is no bare `fetch`
 * to Walrus anywhere in the codebase.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import {
  resilientCall,
  signResumeToken,
  verifyResumeToken,
  type ResilientLogger,
} from '@fhe-ai-context/runtime-utils';

/** Reference to a single blob stored in Walrus. */
export interface WalrusBlobRef {
  /** Stable identifier (sha256 hex in mock; Walrus blobId in http). */
  blobId: string;
  /** Bytes stored. */
  size: number;
}

export interface UploadOptions {
  /** Bytes per chunk for large uploads. Default 1 MB. */
  chunkBytes?: number;
  /** Resume token returned by a previous partial upload — only missing chunks are sent. */
  resumeToken?: string;
  /** Called with progress fraction 0..1 after each chunk. */
  onProgress?: (fraction: number) => void;
  /** Logger for resilient-call retries. */
  logger?: ResilientLogger;
}

export interface UploadResult {
  /** All chunk refs in upload order; reassemble = concat(chunks). */
  blobs: WalrusBlobRef[];
  /** Total bytes uploaded across all chunks. */
  totalBytes: number;
  /**
   * Present when the upload failed partway. Pass back via
   * `UploadOptions.resumeToken` to continue from where it stopped.
   */
  resumeToken?: string;
}

export interface WalrusStore {
  upload(data: Uint8Array, opts?: UploadOptions): Promise<UploadResult>;
  fetch(blobId: string): Promise<Uint8Array>;
}

interface WalrusConfig {
  publisherUrl?: string;
  aggregatorUrl?: string;
}

/**
 * Path component of the Walrus HTTP API. Mysten renamed `/v1/store` to
 * `/v1/blobs` (PUT) and `/v1/{blobId}` to `/v1/blobs/{blobId}` (GET) — kept
 * here as a single named constant so a future rename is one-line work and
 * a path drift in one place cannot diverge from the other.
 */
const WALRUS_BLOBS_PATH = '/v1/blobs';

/** Resume payload — kept opaque to callers. */
interface ResumePayload {
  uploadId: string;
  uploaded: WalrusBlobRef[];
  totalChunks: number;
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function chunk(data: Uint8Array, size: number): Uint8Array[] {
  if (data.byteLength <= size) return [data];
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.byteLength; i += size) {
    out.push(data.subarray(i, Math.min(i + size, data.byteLength)));
  }
  return out;
}

// ---------- Mock implementation --------------------------------------------

class MockWalrusStore implements WalrusStore {
  private readonly store = new Map<string, Uint8Array>();

  async upload(data: Uint8Array, opts: UploadOptions = {}): Promise<UploadResult> {
    const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const chunks = chunk(data, chunkBytes);
    const totalChunks = chunks.length;

    let uploadedChunks: WalrusBlobRef[] = [];
    let startIndex = 0;
    let uploadId = bytesToHex(randomBytes(16));

    if (opts.resumeToken) {
      const resumed = verifyResumeToken<ResumePayload>(opts.resumeToken);
      if (resumed.totalChunks !== totalChunks) {
        throw new Error('resume token mismatched chunk count — payload changed');
      }
      uploadedChunks = resumed.uploaded;
      startIndex = resumed.uploaded.length;
      uploadId = resumed.uploadId;
    }

    let totalBytes = uploadedChunks.reduce((s, b) => s + b.size, 0);

    for (let i = startIndex; i < chunks.length; i++) {
      const c = chunks[i];
      const ref = await resilientCall(
        { name: 'walrus-mock-upload', logger: opts.logger },
        async () => {
          const blobId = sha256Hex(c);
          this.store.set(blobId, c);
          return { blobId, size: c.byteLength };
        },
      );
      uploadedChunks.push(ref);
      totalBytes += ref.size;
      opts.onProgress?.((i + 1) / totalChunks);
    }

    return { blobs: uploadedChunks, totalBytes };
  }

  async fetch(blobId: string): Promise<Uint8Array> {
    const found = this.store.get(blobId);
    if (!found) throw new Error(`mock walrus: blob ${blobId} not found`);
    return found;
  }
}

// ---------- HTTP implementation --------------------------------------------

class HttpWalrusStore implements WalrusStore {
  constructor(private readonly cfg: Required<WalrusConfig>) {}

  async upload(data: Uint8Array, opts: UploadOptions = {}): Promise<UploadResult> {
    const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const chunks = chunk(data, chunkBytes);
    const totalChunks = chunks.length;

    let uploadedChunks: WalrusBlobRef[] = [];
    let startIndex = 0;
    let uploadId = bytesToHex(randomBytes(16));

    if (opts.resumeToken) {
      const resumed = verifyResumeToken<ResumePayload>(opts.resumeToken);
      if (resumed.totalChunks !== totalChunks) {
        throw new Error('resume token mismatched chunk count — payload changed');
      }
      uploadedChunks = resumed.uploaded;
      startIndex = resumed.uploaded.length;
      uploadId = resumed.uploadId;
    }

    let totalBytes = uploadedChunks.reduce((s, b) => s + b.size, 0);

    for (let i = startIndex; i < chunks.length; i++) {
      const c = chunks[i];
      try {
        const ref = await resilientCall(
          { name: 'walrus-http-upload', logger: opts.logger },
          async () => {
            const res = await fetch(`${this.cfg.publisherUrl}${WALRUS_BLOBS_PATH}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: new Blob([c as unknown as BlobPart]),
            });
            if (!res.ok) throw new Error(`walrus publisher ${res.status}`);
            const json = (await res.json()) as { newlyCreated?: { blobObject?: { blobId?: string } } };
            const blobId = json.newlyCreated?.blobObject?.blobId;
            if (!blobId) throw new Error('walrus publisher: missing blobId in response');
            return { blobId, size: c.byteLength };
          },
        );
        uploadedChunks.push(ref);
        totalBytes += ref.size;
        opts.onProgress?.((i + 1) / totalChunks);
      } catch (err) {
        // Hand the caller a resume token so they can retry the missing chunks.
        const resumeToken = signResumeToken<ResumePayload>({
          uploadId,
          uploaded: uploadedChunks,
          totalChunks,
        });
        const wrapped = new Error(
          `walrus upload aborted at chunk ${i}/${totalChunks}: ${(err as Error).message}`,
        );
        (wrapped as Error & { resumeToken?: string }).resumeToken = resumeToken;
        throw wrapped;
      }
    }
    return { blobs: uploadedChunks, totalBytes };
  }

  async fetch(blobId: string): Promise<Uint8Array> {
    return resilientCall({ name: 'walrus-http-fetch' }, async () => {
      const res = await fetch(`${this.cfg.aggregatorUrl}${WALRUS_BLOBS_PATH}/${blobId}`);
      if (!res.ok) throw new Error(`walrus aggregator ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }
}

// ---------- Factory --------------------------------------------------------

/**
 * Pick an implementation based on env / explicit config.
 *   - When `publisherUrl` + `aggregatorUrl` are provided (or both env vars set), uses HTTP.
 *   - Otherwise returns the in-memory mock — safe for tests and offline development.
 */
export function createWalrusStore(cfg: WalrusConfig = {}): WalrusStore {
  const publisherUrl = cfg.publisherUrl ?? process.env.WALRUS_PUBLISHER_URL;
  const aggregatorUrl = cfg.aggregatorUrl ?? process.env.WALRUS_AGGREGATOR_URL;
  if (publisherUrl && aggregatorUrl) {
    return new HttpWalrusStore({ publisherUrl, aggregatorUrl });
  }
  return new MockWalrusStore();
}
