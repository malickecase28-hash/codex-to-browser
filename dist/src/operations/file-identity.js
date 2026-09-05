import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { nodeErrorCode } from "../errors.js";
const DEFAULT_HASH_CHUNK_BYTES = 64 * 1024;
export class OperationFileIdentityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "OperationFileIdentityError";
    }
}
export async function fingerprintOperationFile(sourcePath, displayName, options = {}) {
    if (typeof sourcePath !== "string"
        || sourcePath.length === 0
        || sourcePath.length > 4096
        || /[\u0000-\u001f\u007f]/u.test(sourcePath)) {
        throw new OperationFileIdentityError("invalid_file_path", "Operation input path must be a bounded local path without control characters.");
    }
    const canonicalPath = resolve(sourcePath);
    const normalizedDisplayName = validateDisplayName(displayName ?? basename(canonicalPath));
    const hashed = await hashRegularFile(canonicalPath, options);
    return {
        sourcePath: canonicalPath,
        manifest: {
            displayName: normalizedDisplayName,
            bytes: safeByteCount(hashed.stats.size),
            contentSha256: hashed.sha256
        },
        proof: fileProof(hashed.stats)
    };
}
/**
 * Re-open and stream the file immediately before handoff. The unavoidable gap
 * between this check and the browser accepting the file remains explicit; DOM
 * attachment labels must never be presented as proof of the content hash.
 */
export async function revalidateOperationFile(identity, options = {}) {
    const current = await fingerprintOperationFile(identity.sourcePath, identity.manifest.displayName, options);
    if (current.manifest.bytes !== identity.manifest.bytes ||
        current.manifest.contentSha256 !== identity.manifest.contentSha256 ||
        current.proof.device !== identity.proof.device ||
        current.proof.inode !== identity.proof.inode) {
        throw new OperationFileIdentityError("operation_file_changed", "An operation input file changed after its immutable request identity was established.");
    }
}
async function hashRegularFile(sourcePath, options) {
    assertNotAborted(options.signal);
    const chunkBytes = options.chunkBytes ?? DEFAULT_HASH_CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 16 * 1024 * 1024) {
        throw new OperationFileIdentityError("invalid_hash_chunk_size", "chunkBytes must be between 1 and 16777216 bytes.");
    }
    let pathMetadata;
    try {
        pathMetadata = await lstat(sourcePath, { bigint: true });
    }
    catch (error) {
        throw localFileError(error, "operation_file_unavailable", "The operation input file is unavailable.");
    }
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
        throw new OperationFileIdentityError("operation_file_not_regular", "Operation input must be a regular, non-symlinked file.");
    }
    let handle;
    try {
        handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        throw localFileError(error, "operation_file_unavailable", "The operation input file could not be opened safely.");
    }
    try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
            throw new OperationFileIdentityError("operation_file_changed", "The operation input file changed while it was being opened.");
        }
        const digest = createHash("sha256");
        const stream = handle.createReadStream({
            autoClose: false,
            highWaterMark: chunkBytes,
            signal: options.signal
        });
        try {
            for await (const chunk of stream) {
                const bytes = chunk;
                digest.update(bytes);
                options.onChunk?.(bytes.byteLength);
            }
        }
        catch (error) {
            if (options.signal?.aborted) {
                throw new OperationFileIdentityError("file_hash_aborted", "Operation file hashing was cancelled.");
            }
            throw localFileError(error, "operation_file_read_failed", "The operation input file could not be read completely.");
        }
        const after = await handle.stat({ bigint: true });
        if (!sameOpenFileSnapshot(before, after)) {
            throw new OperationFileIdentityError("operation_file_changed", "The operation input file changed while it was being hashed.");
        }
        return { sha256: digest.digest("hex"), stats: after };
    }
    finally {
        await handle.close();
    }
}
function validateDisplayName(displayName) {
    if (typeof displayName !== "string") {
        throw new OperationFileIdentityError("invalid_file_display_name", "Operation file displayName must be one safe path-free name.");
    }
    const normalized = displayName.normalize("NFC");
    if (normalized.length === 0
        || normalized.length > 512
        || normalized === "."
        || normalized === ".."
        || /[\\/\u0000-\u001f\u007f]/u.test(normalized)) {
        throw new OperationFileIdentityError("invalid_file_display_name", "Operation file displayName must be one safe path-free name.");
    }
    return normalized;
}
function sameOpenFileSnapshot(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function fileProof(stats) {
    return {
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
        size: stats.size.toString(),
        modifiedNs: stats.mtimeNs.toString(),
        changedNs: stats.ctimeNs.toString()
    };
}
function safeByteCount(size) {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new OperationFileIdentityError("operation_file_too_large", "Operation input size exceeds the supported safe integer range.");
    }
    return Number(size);
}
function assertNotAborted(signal) {
    if (signal?.aborted) {
        throw new OperationFileIdentityError("file_hash_aborted", "Operation file hashing was cancelled.");
    }
}
function localFileError(error, code, fallback) {
    if (error instanceof OperationFileIdentityError)
        return error;
    const errno = nodeErrorCode(error);
    const suffix = errno === undefined ? "" : ` (${errno})`;
    return new OperationFileIdentityError(code, `${fallback}${suffix}`);
}
