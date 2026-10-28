import * as zlib from 'node:zlib';
import { ClassifiedProviderError } from './provider-errors.js';

export type RequestCompression = 'none' | 'gzip' | 'zstd';

export function parseRequestCompression(value: unknown): RequestCompression {
  if (value === undefined) return 'none';
  if (value === 'none' || value === 'gzip' || value === 'zstd') return value;
  throw new ClassifiedProviderError('CLAUDE_MEM_CUSTOM_REQUEST_COMPRESSION must be "none", "gzip", or "zstd"', { kind: 'setup_required', cause: undefined });
}

/** Compress the final JSON body, including any fields changed by a retry. */
export async function encodeJsonRequestBody(
  value: Record<string, unknown>,
  compression: RequestCompression = 'none',
): Promise<{ body: string | Uint8Array<ArrayBuffer>; headers: Record<string, string> }> {
  const json = JSON.stringify(value);
  const encoding = parseRequestCompression(compression);
  if (encoding === 'none') return { body: json, headers: {} };

  // Look up zstd at call time: older supported runtimes can still use none/gzip.
  const compress = encoding === 'gzip' ? zlib.gzip : zlib.zstdCompress;
  if (typeof compress !== 'function') {
    throw new ClassifiedProviderError(`${encoding} request compression is unavailable in this runtime; upgrade the runtime or choose another compression option`, { kind: 'setup_required', cause: undefined });
  }
  try {
    const body = await new Promise<Buffer<ArrayBuffer>>((resolve, reject) => {
      compress(json, (error, result) => error ? reject(error) : resolve(result));
    });
    return { body, headers: { 'Content-Encoding': encoding } };
  } catch (cause) {
    throw new ClassifiedProviderError(`${encoding} request compression failed`, { kind: 'setup_required', cause });
  }
}
