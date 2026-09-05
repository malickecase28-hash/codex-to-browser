import type { OperationRequestIdentityInput } from "./types.js";
export declare function canonicalJson(value: unknown): string;
export declare function hmacDigest(key: Uint8Array, domain: string, value: unknown): string;
export declare function operationRequestDigest(key: Uint8Array, input: OperationRequestIdentityInput): string;
