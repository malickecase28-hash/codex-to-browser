/**
 * Accept genuine one-byte typed-array views across JavaScript realms.
 *
 * `instanceof Uint8Array` is realm-sensitive. `ArrayBuffer.isView` checks the
 * internal view slot across realms; the one-byte width and length relation
 * then exclude DataView and wider typed arrays without trusting a type tag.
 */
export declare function isByteArrayView(value: unknown): value is Uint8Array;
/**
 * Accept descriptor-safe plain records across JavaScript realms.
 *
 * Comparing a prototype directly with this realm's `Object.prototype`
 * rejects ordinary objects returned by a VM or browser bridge. A foreign
 * intrinsic Object prototype is still a direct child of `null`; custom class
 * instances have at least one additional layer. Only own data descriptors
 * are accepted, so getters are never invoked by the boundary.
 */
export declare function isPlainDataRecord(value: unknown): value is Record<string, unknown>;
