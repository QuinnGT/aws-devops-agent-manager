/** "admin" becomes "Admin": role names are policy keys, shown in sentence case. */
export function roleLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : role;
}
