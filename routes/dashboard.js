const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { getPermissionsForUser, allPermissions } = require('../lib/rbac');

const router = express.Router();

router.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));

router.get('/dashboard', requireLogin, (req, res) => {
  const perms = [...getPermissionsForUser(req.user)];

  if (req.user.account_type === 'broker') {
    const loads = db.prepare(`
      SELECT l.*, co.name AS carrier_org_name, s.name AS shipper_name
      FROM loads l LEFT JOIN orgs co ON co.id = l.carrier_org_id LEFT JOIN users s ON s.id = l.shipper_id
      WHERE l.broker_org_id = ? ORDER BY l.id DESC LIMIT 10
    `).all(req.user.org_id);
    const flagged = db.prepare(`
      SELECT l.*, co.name AS carrier_org_name FROM loads l LEFT JOIN orgs co ON co.id = l.carrier_org_id
      WHERE l.broker_org_id = ? AND l.compliance_flag = 1
    `).all(req.user.org_id);
    const counts = db.prepare(`SELECT status, COUNT(*) c FROM loads WHERE broker_org_id = ? GROUP BY status`).all(req.user.org_id);
    return res.render('dashboard_broker', { loads, flagged, counts, perms });
  }

  if (req.user.account_type === 'carrier') {
    const loads = db.prepare(`
      SELECT l.*, bo.name AS broker_org_name, s.name AS shipper_name
      FROM loads l LEFT JOIN orgs bo ON bo.id = l.broker_org_id LEFT JOIN users s ON s.id = l.shipper_id
      WHERE l.carrier_org_id = ? ORDER BY l.id DESC
    `).all(req.user.org_id);
    const compliance = db.prepare(`SELECT * FROM carrier_compliance WHERE org_id = ?`).get(req.user.org_id);
    let expiryWarning = null;
    if (compliance) {
      const daysLeft = Math.ceil((new Date(compliance.insurance_expiry) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) expiryWarning = { level: 'expired', daysLeft };
      else if (daysLeft <= 30) expiryWarning = { level: 'soon', daysLeft };
    }
    return res.render('dashboard_carrier', { loads, compliance, expiryWarning, perms });
  }

  // shipper
  const loads = db.prepare(`
    SELECT l.*, bo.name AS broker_org_name, co.name AS carrier_org_name
    FROM loads l LEFT JOIN orgs bo ON bo.id = l.broker_org_id LEFT JOIN orgs co ON co.id = l.carrier_org_id
    WHERE l.shipper_id = ? ORDER BY l.id DESC
  `).all(req.user.id);
  res.render('dashboard_shipper', { loads });
});

// Stretch: audit log viewer -- broker/carrier admins can see their org's access-denied log
router.get('/admin/audit-log', requireLogin, (req, res) => {
  if (req.user.account_type === 'shipper' || !req.user.is_org_admin) {
    return res.status(403).send('Forbidden: org admin only.');
  }
  const denied = db.prepare(`SELECT * FROM access_denied_log ORDER BY id DESC LIMIT 100`).all();
  const loadEvents = db.prepare(`
    SELECT a.*, u.name as actor_name, l.reference FROM load_audit a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN loads l ON l.id = a.load_id
    WHERE l.broker_org_id = ? OR l.carrier_org_id = ?
    ORDER BY a.id DESC LIMIT 100
  `).all(req.user.org_id, req.user.org_id);
  res.render('audit_log', { denied, loadEvents });
});

module.exports = router;
