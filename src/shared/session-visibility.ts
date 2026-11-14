/** Hide untitled and internal review rows from the compact list only.
 * Usage totals and the underlying evidence remain unchanged. */
export function isNamedUserSession(row: {title?: string | null; unknownIdentity?: boolean}): boolean {
  const title = row.title?.trim() || "";
  return !row.unknownIdentity && !!title && !/^(?:guardian|guard)[\s_-]*review$/i.test(title);
}
