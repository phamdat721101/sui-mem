/**
 * pdfExtractor.ts — extract searchable text from a Walrus-stored PDF.
 *
 * Called once per upload (at `/v3/agents/:slug/uploads` confirm) so the
 * extracted text is cached in `task_uploads.extracted_text` and the hot
 * inference path is read-only.
 *
 * SOLID:
 *   - SRP: input is a Walrus blob_id + caps, output is `{ text, status,
 *     pageCount }`. No DB writes, no HTTP, no logging side effects in the
 *     happy path.
 *   - DIP: WalrusStore is constructor-injected; the factory `getPdfExtractor`
 *     wires the env-resolved store.
 *   - OCP: a future PDF lib swap (e.g. `unpdf`) replaces the lazy import
 *     without changing the public surface.
 *
 * Mistake-avoidance:
 *   - Hard 20 MB byte cap (defense-in-depth on top of the route's check).
 *   - 4-concurrent semaphore so a burst of uploads can't blow Node heap.
 *   - AbortController on every parse so a malformed PDF doesn't hang.
 *   - All failure modes are typed `status` codes, never thrown.
 */

import type { WalrusStore } from '@fhe-ai-context/sui-sdk';
import { createWalrusStore } from '@fhe-ai-context/sui-sdk';

export type ExtractStatus =
  | 'ok'
  | 'password_protected'
  | 'no_text'
  | 'extraction_failed'
  | 'timeout'
  | 'too_large'
  | 'not_applicable';

export interface ExtractResult {
  text: string;
  status: ExtractStatus;
  pageCount: number;
}

export interface ExtractOptions {
  pageCap?: number;     // default 100
  charCap?: number;     // default 200_000 chars (~50K Llama tokens)
  timeoutMs?: number;   // default 15_000
}

const MAX_BYTES = 20_971_520; // 20 MB hard ceiling
const DEFAULTS = { pageCap: 100, charCap: 200_000, timeoutMs: 15_000 };
const MIN_TEXT_CHARS = 20; // below this → 'no_text' (image-only scan)

// In-process semaphore: 4 concurrent parses max.
let _running = 0;
const _waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (_running < 4) {
    _running += 1;
    return release;
  }
  await new Promise<void>((resolve) => _waiters.push(resolve));
  _running += 1;
  return release;
}
function release(): void {
  _running -= 1;
  const next = _waiters.shift();
  if (next) next();
}

export class PdfExtractor {
  constructor(private readonly walrus: WalrusStore) {}

  async extract(walrusBlobId: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
    const pageCap = opts.pageCap ?? DEFAULTS.pageCap;
    const charCap = opts.charCap ?? DEFAULTS.charCap;
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

    const releaseSlot = await acquire();
    try {
      let bytes: Uint8Array;
      try {
        bytes = await this.walrus.fetch(walrusBlobId);
      } catch {
        return { text: '', status: 'extraction_failed', pageCount: 0 };
      }
      if (bytes.byteLength > MAX_BYTES) {
        return { text: '', status: 'too_large', pageCount: 0 };
      }

      // Lazy-load pdfjs-dist legacy Node build. The package's main entry is
      // an ESM-only module; legacy/build/pdf.mjs is the Node-friendly variant
      // that doesn't need a worker thread.
      const dynamicImport: (m: string) => Promise<any> = Function('m', 'return import(m)') as any;
      let pdfjs: any;
      try {
        pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
      } catch {
        return { text: '', status: 'extraction_failed', pageCount: 0 };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const task = pdfjs.getDocument({
          data: bytes,
          disableFontFace: true,
          useSystemFonts: false,
          isEvalSupported: false,
          // password '' → triggers PasswordException for protected files
          password: '',
        });
        // pdfjs's getDocument task supports a `destroy()` we wire to the abort.
        ac.signal.addEventListener('abort', () => {
          try { task.destroy(); } catch { /* swallow — we're already failing */ }
        });

        let doc: any;
        try {
          doc = await task.promise;
        } catch (e) {
          const name = (e as { name?: string } | undefined)?.name ?? '';
          if (name === 'PasswordException') {
            return { text: '', status: 'password_protected', pageCount: 0 };
          }
          if (ac.signal.aborted) {
            return { text: '', status: 'timeout', pageCount: 0 };
          }
          return { text: '', status: 'extraction_failed', pageCount: 0 };
        }

        const totalPages = doc.numPages ?? 0;
        const pagesToRead = Math.min(totalPages, pageCap);
        let buf = '';
        for (let p = 1; p <= pagesToRead; p++) {
          if (ac.signal.aborted) {
            return { text: '', status: 'timeout', pageCount: totalPages };
          }
          if (buf.length >= charCap) break;
          try {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            const pageText = (content.items as Array<{ str?: string }>)
              .map((it) => it.str ?? '')
              .join(' ');
            buf += (buf ? '\n\n' : '') + pageText;
          } catch {
            // single-page failure is non-fatal — continue
            continue;
          }
        }
        try { await doc.destroy(); } catch { /* noop */ }

        const text = buf.slice(0, charCap).trim();
        if (text.length < MIN_TEXT_CHARS) {
          return { text: '', status: 'no_text', pageCount: totalPages };
        }
        return { text, status: 'ok', pageCount: totalPages };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      releaseSlot();
    }
  }
}

let _singleton: PdfExtractor | null = null;
export function getPdfExtractor(): PdfExtractor {
  if (_singleton) return _singleton;
  _singleton = new PdfExtractor(createWalrusStore());
  return _singleton;
}

/** Reset singleton — used by smoke tests to inject a mock WalrusStore. */
export function setPdfExtractorForTests(e: PdfExtractor | null): void {
  _singleton = e;
}
