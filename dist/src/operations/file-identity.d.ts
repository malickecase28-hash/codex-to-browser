export type OperationFileManifestEntryV1 = {
    displayName: string;
    bytes: number;
    contentSha256: string;
};
export type OperationFileIdentity = {
    /** Ephemeral local input. This value must never be written to the journal. */
    sourcePath: string;
    manifest: OperationFileManifestEntryV1;
    proof: {
        device: string;
        inode: string;
        size: string;
        modifiedNs: string;
        changedNs: string;
    };
};
export type OperationFileHashOptions = {
    signal?: AbortSignal;
    chunkBytes?: number;
    onChunk?: (bytes: number) => void;
};
export declare class OperationFileIdentityError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function fingerprintOperationFile(sourcePath: string, displayName?: string, options?: OperationFileHashOptions): Promise<OperationFileIdentity>;
/**
 * Re-open and stream the file immediately before handoff. The unavoidable gap
 * between this check and the browser accepting the file remains explicit; DOM
 * attachment labels must never be presented as proof of the content hash.
 */
export declare function revalidateOperationFile(identity: OperationFileIdentity, options?: OperationFileHashOptions): Promise<void>;
