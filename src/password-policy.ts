export const passwordMinimumCharacters = 8;
export const passwordMaximumCharacters = 256;
// An HTML input counts UTF-16 code units; a valid 256-code-point password may
// need 512 units. Semantic validation uses code points on both client/server.
export const passwordMaximumUtf16Units = passwordMaximumCharacters * 2;
export function validPasswordLength(value: unknown): value is string {
  return typeof value === "string" &&
    [...value].length >= passwordMinimumCharacters &&
    [...value].length <= passwordMaximumCharacters;
}
