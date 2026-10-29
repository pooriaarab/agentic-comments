/** Control characters and invisible format characters, such as a zero-width space or a right-to-left override. */
export const HIDDEN = /[\p{Cc}\p{Cf}]/u;

/** An id from storage. UUIDs pass. Anything long or odd does not. */
export const ID = /^[\w-]{1,64}$/;

/** A short quote of an untrusted id for an error message. */
export const shown = (value: unknown): string => JSON.stringify(String(value).slice(0, 64));
