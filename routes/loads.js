const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireLogin, requirePermission, requireAccountType, scopeLoad, logDenied } = require('../middleware/auth');
const { checkCompliance } = require('../lib/compliance');
const { logAudit, getAuditTrail } = require('../lib/audit');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'pod');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function nextReference() {
  const row = db.prepare(`SELECT COUNT(*) c FROM loads`).get();
  return `LF-${1001 + row.c}`;
}

function getLoadFull(id) {
  const load = db.prepare(`
    SELECT l.*, bo.name AS broker_org_name, co.name AS carrier_org_name, s.name AS shipper_name
    FROM loads l
    LEFT JOIN orgs bo ON bo.id = l.broker_org_id
    LEFT JOIN orgs co ON co.id = l.carrier_org_id
    LEFT JOIN users s ON s.id = l.shipper_id
    WHERE l.id = ?
  `).get(id);
  if (!load) return null;
  load.rateConfirmations = db.prepare(`SELECT * FROM rate_confirmations WHERE load_id = ? ORDER BY version DESC`).all(id);
  load.audit = getAuditTrail(id);
  return load;
}

// ---------------------------------------------------------------------------
// BROKER: load board with search/filter (org-scoped)
// ---------------------------------------------------------------------------
router.get('/loads', requireLogin, requireAccountType('broker'), (req, res) => {
  const { status, carrier, q } = req.query;
  let sql = `
    SELECT l.*, co.name AS carrier_org_name, s.name AS shipper_name
    FROM loads l
    LEFT JOIN orgs co ON co.id = l.carrier_org_id
    LEFT JOIN users s ON s.id = l.shipper_id
    WHERE l.broker_org_id = ?
  `;
  const params = [req.user.org_id];
  if (status) { sql += ` AND l.status = ?`; params.push(status); }
  if (carrier) { sql += ` AND co.name LIKE ?`; params.push(`%${carrier}%`); }
  if (q) {
    sql += ` AND (l.reference LIKE ? OR l.origin LIKE ? OR l.destination LIKE ? OR l.commodity LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY l.id DESC`;
  const loads = db.prepare(sql).all(...params);
  const statuses = ['Posted','Carrier Assigned','Rate Confirmed','Dispatched','In Transit','Delivered','POD Verified','Invoiced/Closed'];
  const flaggedCount = loads.filter(l => l.compliance_flag).length;
  res.render('load_board', { loads, statuses, filters: { status, carrier, q }, flaggedCount, perms: res.locals.perms });
});

router.get('/loads/new', requireLogin, requirePermission('load.create'), (req, res) => {
  res.render('load_new', { error: null });
});

router.post('/loads', requireLogin, requirePermission('load.create'), (req, res) => {
  const { origin, destination, pickup_date, delivery_date, equipment_type, commodity, shipper_email } = req.body;
  if (!origin || !destination || !equipment_type || !commodity || !shipper_email) {
    return res.status(400).render('load_new', { error: 'All fields are required.' });
  }
  const shipper = db.prepare(`SELECT * FROM users WHERE email = ? AND account_type = 'shipper'`).get(shipper_email.trim().toLowerCase());
  if (!shipper) {
    return res.status(400).render('load_new', { error: `No shipper account found for ${shipper_email}. Ask them to register first.` });
  }
  const reference = nextReference();
  const info = db.prepare(`
    INSERT INTO loads (reference, broker_org_id, shipper_id, origin, destination, pickup_date, delivery_date, equipment_type, commodity, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?, 'Posted', ?)
  `).run(reference, req.user.org_id, shipper.id, origin, destination, pickup_date || null, delivery_date || null, equipment_type, commodity, req.user.id);
  logAudit(info.lastInsertRowid, req.user.id, 'status_change', null, 'Posted', 'Load posted');
  res.redirect(`/loads/${info.lastInsertRowid}`);
});

// ---------------------------------------------------------------------------
// Load detail (object-level scoped: broker org / carrier org / shipper owner)
// ---------------------------------------------------------------------------
router.get('/loads/:id', requireLogin, scopeLoad, (req, res) => {
  const load = getLoadFull(req.params.id);
  const carriers = req.user.account_type === 'broker'
    ? db.prepare(`SELECT * FROM orgs WHERE type = 'carrier' ORDER BY name`).all()
    : [];
  res.render('load_detail', { load, carriers, error: req.query.error || null });
});

// ---------------------------------------------------------------------------
// BROKER: assign carrier -> runs compliance check -> Carrier Assigned
// ---------------------------------------------------------------------------
router.post('/loads/:id/assign-carrier', requireLogin, requirePermission('load.assign_carrier'), scopeLoad, (req, res) => {
  const load = req.load;
  if (load.status !== 'Posted') return res.redirect(`/loads/${load.id}?error=Load must be in Posted status to assign a carrier.`);
  const { carrier_org_id } = req.body;
  const carrier = db.prepare(`SELECT * FROM orgs WHERE id = ? AND type = 'carrier'`).get(carrier_org_id);
  if (!carrier) return res.redirect(`/loads/${load.id}?error=Invalid carrier.`);

  const { flagged, reasons } = checkCompliance(carrier.id, load.equipment_type, load.commodity);

  db.prepare(`
    UPDATE loads SET carrier_org_id = ?, status = 'Carrier Assigned', compliance_flag = ?, compliance_flag_reason = ?,
      compliance_override_by = NULL, compliance_override_note = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(carrier.id, flagged ? 1 : 0, flagged ? reasons.join(' ') : null, load.id);

  logAudit(load.id, req.user.id, 'carrier_assigned', null, carrier.name, `Assigned to ${carrier.name}`);
  logAudit(load.id, req.user.id, 'status_change', 'Posted', 'Carrier Assigned', null);
  if (flagged) {
    logAudit(load.id, req.user.id, 'compliance_flagged', null, null, reasons.join(' '));
  }
  res.redirect(`/loads/${load.id}`);
});

// ---------------------------------------------------------------------------
// BROKER: override a compliance flag
// ---------------------------------------------------------------------------
router.post('/loads/:id/override-compliance', requireLogin, requirePermission('load.override_compliance_flag'), scopeLoad, (req, res) => {
  const load = req.load;
  if (!load.compliance_flag) return res.redirect(`/loads/${load.id}?error=No active compliance flag to override.`);
  const { note } = req.body;
  if (!note || !note.trim()) return res.redirect(`/loads/${load.id}?error=Override requires a justification note.`);

  db.prepare(`
    UPDATE loads SET compliance_flag = 0, compliance_override_by = ?, compliance_override_note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.user.id, note.trim(), load.id);
  logAudit(load.id, req.user.id, 'compliance_override', 'flagged', 'overridden', note.trim());
  res.redirect(`/loads/${load.id}`);
});

// ---------------------------------------------------------------------------
// BROKER: create a new rate confirmation version (draft)
// ---------------------------------------------------------------------------
router.post('/loads/:id/rate-confirmations', requireLogin, requirePermission('rate.confirm'), scopeLoad, (req, res) => {
  const load = req.load;
  if (!['Carrier Assigned', 'Rate Confirmed'].includes(load.status)) {
    return res.redirect(`/loads/${load.id}?error=Carrier must be assigned before creating a rate confirmation.`);
  }
  const { base_rate, accessorial_labels, accessorial_amounts } = req.body;
  const base = parseFloat(base_rate);
  if (isNaN(base) || base <= 0) return res.redirect(`/loads/${load.id}?error=Base rate must be a positive number.`);

  let labels = accessorial_labels ? (Array.isArray(accessorial_labels) ? accessorial_labels : [accessorial_labels]) : [];
  let amounts = accessorial_amounts ? (Array.isArray(accessorial_amounts) ? accessorial_amounts : [accessorial_amounts]) : [];
  const accessorials = [];
  let accessorialTotal = 0;
  for (let i = 0; i < labels.length; i++) {
    const amt = parseFloat(amounts[i]);
    if (labels[i] && !isNaN(amt)) {
      accessorials.push({ label: labels[i], amount: amt });
      accessorialTotal += amt;
    }
  }
  const total = base + accessorialTotal;

  const maxVersion = db.prepare(`SELECT COALESCE(MAX(version),0) v FROM rate_confirmations WHERE load_id = ?`).get(load.id).v;
  const version = maxVersion + 1;

  const tx = db.transaction(() => {
    // supersede prior confirmed version(s)
    db.prepare(`UPDATE rate_confirmations SET status = 'superseded' WHERE load_id = ? AND status = 'confirmed'`).run(load.id);
    const info = db.prepare(`
      INSERT INTO rate_confirmations (load_id, version, base_rate, accessorials, total, status, created_by)
      VALUES (?,?,?,?,?, 'draft', ?)
    `).run(load.id, version, base, JSON.stringify(accessorials), total, req.user.id);
    return info.lastInsertRowid;
  });
  const rcId = tx();
  logAudit(load.id, req.user.id, 'rate_confirmation_created', null, `v${version} ($${total.toFixed(2)})`, null);
  res.redirect(`/loads/${load.id}?rc=${rcId}`);
});

// BROKER: confirm a specific rate confirmation version -> Rate Confirmed (blocked if compliance_flag)
router.post('/loads/:id/rate-confirmations/:rcId/confirm', requireLogin, requirePermission('rate.confirm'), scopeLoad, (req, res) => {
  const load = req.load;
  if (load.compliance_flag) {
    return res.redirect(`/loads/${load.id}?error=Blocked: unresolved compliance flag. Override or fix carrier compliance first.`);
  }
  const rc = db.prepare(`SELECT * FROM rate_confirmations WHERE id = ? AND load_id = ?`).get(req.params.rcId, load.id);
  if (!rc) return res.redirect(`/loads/${load.id}?error=Rate confirmation not found.`);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE rate_confirmations SET status = 'confirmed', confirmed_by = ? WHERE id = ?`).run(req.user.id, rc.id);
    db.prepare(`UPDATE loads SET status = 'Rate Confirmed', active_rate_confirmation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(rc.id, load.id);
  });
  tx();
  logAudit(load.id, req.user.id, 'rate_confirmed', null, `v${rc.version}`, null);
  logAudit(load.id, req.user.id, 'status_change', load.status, 'Rate Confirmed', null);
  res.redirect(`/loads/${load.id}`);
});

// ---------------------------------------------------------------------------
// BROKER: dispatch (Rate Confirmed -> Dispatched)
// ---------------------------------------------------------------------------
router.post('/loads/:id/dispatch', requireLogin, requirePermission('load.assign_carrier'), scopeLoad, (req, res) => {
  const load = req.load;
  if (load.status !== 'Rate Confirmed') return res.redirect(`/loads/${load.id}?error=Load must be Rate Confirmed before dispatch.`);
  if (load.compliance_flag) return res.redirect(`/loads/${load.id}?error=Blocked by unresolved compliance flag.`);
  db.prepare(`UPDATE loads SET status = 'Dispatched', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(load.id);
  logAudit(load.id, req.user.id, 'status_change', 'Rate Confirmed', 'Dispatched', null);
  res.redirect(`/loads/${load.id}`);
});

// BROKER: close out / invoice (POD Verified -> Invoiced/Closed)
router.post('/loads/:id/close', requireLogin, requirePermission('rate.confirm'), scopeLoad, (req, res) => {
  const load = req.load;
  if (load.status !== 'POD Verified') return res.redirect(`/loads/${load.id}?error=Load must have a verified POD before closing.`);
  db.prepare(`UPDATE loads SET status = 'Invoiced/Closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(load.id);
  logAudit(load.id, req.user.id, 'status_change', 'POD Verified', 'Invoiced/Closed', null);
  res.redirect(`/loads/${load.id}`);
});

// ---------------------------------------------------------------------------
// CARRIER: accept / decline assignment
// ---------------------------------------------------------------------------
router.post('/loads/:id/accept', requireLogin, requirePermission('load.accept_decline'), scopeLoad, (req, res) => {
  const load = req.load;
  logAudit(load.id, req.user.id, 'carrier_accepted', null, null, `${req.user.name} acknowledged assignment`);
  res.redirect(`/loads/${load.id}`);
});

router.post('/loads/:id/decline', requireLogin, requirePermission('load.accept_decline'), scopeLoad, (req, res) => {
  const load = req.load;
  if (!['Carrier Assigned'].includes(load.status)) {
    return res.redirect(`/loads/${load.id}?error=Can only decline while in Carrier Assigned status.`);
  }
  db.prepare(`
    UPDATE loads SET status = 'Posted', carrier_org_id = NULL, compliance_flag = 0, compliance_flag_reason = NULL,
    compliance_override_by = NULL, compliance_override_note = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(load.id);
  logAudit(load.id, req.user.id, 'carrier_declined', 'Carrier Assigned', 'Posted', `${req.user.name} declined the load`);
  res.redirect('/dashboard');
});

// ---------------------------------------------------------------------------
// CARRIER: advance status Dispatched -> In Transit -> Delivered
// ---------------------------------------------------------------------------
const CARRIER_TRANSITIONS = { 'Dispatched': 'In Transit', 'In Transit': 'Delivered' };
router.post('/loads/:id/advance-status', requireLogin, requirePermission('load.update_status'), scopeLoad, (req, res) => {
  const load = req.load;
  const next = CARRIER_TRANSITIONS[load.status];
  if (!next) return res.redirect(`/loads/${load.id}?error=No status advance available from "${load.status}".`);
  db.prepare(`UPDATE loads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(next, load.id);
  logAudit(load.id, req.user.id, 'status_change', load.status, next, null);
  res.redirect(`/loads/${load.id}`);
});

// ---------------------------------------------------------------------------
// CARRIER: upload POD (Delivered -> POD Verified)
// ---------------------------------------------------------------------------
router.post('/loads/:id/pod', requireLogin, requirePermission('pod.upload'), scopeLoad, (req, res) => {
  const load = req.load;
  if (load.status !== 'Delivered') return res.redirect(`/loads/${load.id}?error=POD can only be uploaded once the load is Delivered.`);
  const { pod_note } = req.body;
  const filename = `${load.reference}-POD-${Date.now()}.txt`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), `POD for ${load.reference}\nUploaded by: ${req.user.name}\nDate: ${new Date().toISOString()}\nNote: ${pod_note || '(none)'}\n`);
  db.prepare(`UPDATE loads SET pod_filename = ?, status = 'POD Verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(filename, load.id);
  logAudit(load.id, req.user.id, 'pod_uploaded', 'Delivered', 'POD Verified', pod_note || null);
  res.redirect(`/loads/${load.id}`);
});

router.get('/loads/:id/pod', requireLogin, scopeLoad, (req, res) => {
  const load = req.load;
  if (!load.pod_filename) return res.status(404).send('No POD uploaded yet.');
  res.sendFile(path.join(UPLOAD_DIR, load.pod_filename));
});

module.exports = router;
