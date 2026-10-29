/** Control characters and invisible format characters, such as a zero-width space or a right-to-left override. */
export const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/** An id from storage. UUIDs pass. Anything long or odd does not. */
export const ID = /^[\w-]{1,64}$/;

/** Zero-width characters and direction controls. A body refuses them. A joiner for emoji or Persian is fine. */
export const INVISIBLE = /[\u200B\u2060\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** An untrusted id made safe to show: cut to 64 characters, with anything but letters, digits, `_` and `-` replaced. */
export const safeId = (value: unknown): string => String(value).slice(0, 64).replace(/[^\p{L}\p{N}_-]/gu, "?");

/** A short quote of an untrusted id for an error message. */
export const shown = (value: unknown): string => JSON.stringify(safeId(value));
