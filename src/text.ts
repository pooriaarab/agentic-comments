/** Control characters and invisible format characters, such as a zero-width space or a right-to-left override. */
export const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/** An id from storage. UUIDs pass. Anything long or odd does not. */
export const ID = /^[\w-]{1,64}$/;

/**
 * What a body refuses: control characters (except tab, newline, and carriage return), and invisible
 * format characters such as zero-width spaces, direction controls, soft hyphens, and tag characters.
 * A joiner for emoji or Persian is fine.
 */
export const BODY_FORBIDDEN = /(?![\n\r\t\u200C\u200D])[\p{Cc}\p{Cf}]/u;

/** Variation selectors make a handle that looks like another one. */
export const VARIATION = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

/** An untrusted id made safe to show: cut to 64 characters, with anything but letters, digits, `_` and `-` replaced. */
export const safeId = (value: unknown): string => String(value).slice(0, 64).replace(/[^\p{L}\p{N}_-]/gu, "?");

/** A short quote of an untrusted id for an error message. */
export const shown = (value: unknown): string => JSON.stringify(safeId(value));
