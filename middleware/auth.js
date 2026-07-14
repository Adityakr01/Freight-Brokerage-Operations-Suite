const db = require('../db');
const { hasPermission } = require('../lib/rbac');

// Attach req.user from session on every request
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare(`SELECT * FROM users WHERE id = ? AND active = 1`).get(req.session.userId);
    req.user = user || null;
  } else {
    req.user = null;
  }
  res.locals.user = req.user;
  next();
}

function logDenied(req, reason) {
  db.prepare(
    `INSERT INTO access_denied_log (user_id, email, method, path, reason) VALUES (?,?,?,?,?)`
  ).run(req.user ? req.user.id : null, req.user ? req.user.email : (req.body && req.body.email) || null, req.method, req.originalUrl, reason);
  console.warn(`[ACCESS DENIED] ${req.method} ${req.originalUrl} user=${req.user ? req.user.email : 'anon'} reason="${reason}"`);
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) return res.redirect('/login');
    logDenied(req, 'not authenticated');
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Require a specific permission key. Always checked server-side regardless of UI.
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) {
      logDenied(req, `no session, permission required: ${key}`);
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!hasPermission(req.user, key)) {
      logDenied(req, `missing permission: ${key}`);
      return res.status(403).json({ error: `Forbidden: missing permission "${key}"` });
    }
    next();
  };
}

function requireAccountType(...types) {
  return (req, res, next) => {
    if (!req.user || !types.includes(req.user.account_type)) {
      logDenied(req, `account_type not in [${types.join(',')}]`);
      return res.status(403).json({ error: 'Forbidden: wrong account type' });
    }
    next();
  };
}

// Org-admin check (bootstrap Admin role, is_org_admin flag) -- used for staff/role management
function requireOrgAdmin(req, res, next) {
  if (!req.user || !req.user.is_org_admin) {
    logDenied(req, 'requires org admin');
    return res.status(403).json({ error: 'Forbidden: org admin only' });
  }
  next();
}

/**
 * Object-level scoping check for a load. Loads the load by :id (or req.params.loadId),
 * attaches req.load, and enforces:
 *  - broker staff: load.broker_org_id must equal user's org
 *  - carrier staff: load.carrier_org_id must equal user's org (must already be assigned)
 *  - shipper: load.shipper_id must equal user's id
 * Blocks cross-org / cross-account access with 403 + log, independent of permission grants.
 */
function scopeLoad(req, res, next) {
  const id = req.params.id || req.params.loadId;
  const load = db.prepare(`SELECT * FROM loads WHERE id = ?`).get(id);
  if (!load) return res.status(404).json({ error: 'Load not found' });

  const u = req.user;
  let allowed = false;
  if (u.account_type === 'broker' && load.broker_org_id === u.org_id) allowed = true;
  if (u.account_type === 'carrier' && load.carrier_org_id && load.carrier_org_id === u.org_id) allowed = true;
  if (u.account_type === 'shipper' && load.shipper_id === u.id) allowed = true;

  if (!allowed) {
    logDenied(req, `object-scope violation on load ${id}`);
    return res.status(403).json({ error: 'Forbidden: not your organization\'s load' });
  }
  req.load = load;
  next();
}

module.exports = { attachUser, requireLogin, requirePermission, requireAccountType, requireOrgAdmin, scopeLoad, logDenied };
