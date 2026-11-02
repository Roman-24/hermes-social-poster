import { ulid } from 'ulid';

/** ULIDs everywhere: sortable, URL-safe, 26 chars. */
export function newId(): string {
  return ulid();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}
