/**
 * Internal source-to-file streaming boundary.
 *
 * A provider owns the bytes it yields.  The local output sink must therefore
 * copy a chunk before its first asynchronous effect.  The transfer wrapper
 * already crosses that ownership boundary before it hands a source to the
 * output sink; the weak set lets the sink use that defensive copy directly
 * instead of allocating a second full-sized copy.
 *
 * This module is intentionally not re-exported from the public operations
 * barrel.  Its marker is an implementation detail, not a wire/API contract.
 */
/**
 * Keep one hostile provider allocation well below the 512 MiB artifact cap.
 * Built-in download adapters yield 64 KiB chunks and are unaffected.
 */
export declare const MAX_PROVIDER_CHUNK_BYTES: number;
export declare function copyProviderChunk(value: unknown, maxBytes?: number): Uint8Array;
export declare function isOwnedProviderChunk(value: unknown): value is Uint8Array;
