const db = require('../db');

/**
 * Returns a Set of permission keys the user holds.
 * Shippers never have permissions (no sub-roles) - always empty set.
 * Permissions are ALWAYS derived from role_permissions -- never hardcoded
 * by role name or account_type.
 */
function getPermissionsForUser(user) {
  if (!user || !user.role_id) return new Set();
  const rows = db.prepare(
    `SELECT permission_key FROM role_permissions WHERE role_id = ?`
  ).all(user.role_id);
  return new Set(rows.map(r => r.permission_key));
}

function hasPermission(user, key) {
  return getPermissionsForUser(user).has(key);
}

function allPermissions() {
  return db.prepare(`SELECT * FROM permissions ORDER BY key`).all();
}

module.exports = { getPermissionsForUser, hasPermission, allPermissions };
