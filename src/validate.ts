import { CommentsError } from "./errors.js";

export const invalid = (message: string): never => {
  throw new CommentsError("INVALID_INPUT", message);
};

/** An input must be a plain object with only the keys listed. A key that is not listed fails. */
export function exact(input: unknown, allowed: string[], what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid(`${what} must be an object`);
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length > 0) invalid(`${what} does not accept ${extra.join(", ")}`);
  return input as Record<string, unknown>;
}

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const validDate = (value: unknown): value is string =>
  typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** A copy that shares nothing with the original, so a caller cannot change what Yjs holds. */
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Like `copy`, but refuses what JSON would quietly change: `undefined`, NaN, and Infinity. */
export const strictCopy = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) throw new Error("a value is not valid JSON data");
      return v;
    }),
  ) as T;
