const express = require('express');
const db = require('../db');
const { requireLogin, requirePermission, requireAccountType } = require('../middleware/auth');

const router = express.Router();

router.get('/compliance', requireLogin, requireAccountType('carrier'), requirePermission('compliance.manage'), (req, res) => {
  const record = db.prepare(`SELECT * FROM carrier_compliance WHERE org_id = ?`).get(req.user.org_id);
  res.render('compliance', { record, error: null, saved: req.query.saved === '1' });
});

router.post('/compliance', requireLogin, requireAccountType('carrier'), requirePermission('compliance.manage'), (req, res) => {
  const { mc_number, dot_number, authority_status, insurance_expiry, approved_equipment, approved_commodities } = req.body;
  let equip = Array.isArray(approved_equipment) ? approved_equipment : (approved_equipment ? [approved_equipment] : []);
  let comm = (approved_commodities || '').split(',').map(s => s.trim()).filter(Boolean);

  const existing = db.prepare(`SELECT id FROM carrier_compliance WHERE org_id = ?`).get(req.user.org_id);
  if (existing) {
    db.prepare(`
      UPDATE carrier_compliance
      SET mc_number=?, dot_number=?, authority_status=?, insurance_expiry=?, approved_equipment=?, approved_commodities=?, updated_at=CURRENT_TIMESTAMP
      WHERE org_id = ?
    `).run(mc_number, dot_number, authority_status, insurance_expiry, JSON.stringify(equip), JSON.stringify(comm), req.user.org_id);
  } else {
    db.prepare(`
      INSERT INTO carrier_compliance (org_id, mc_number, dot_number, authority_status, insurance_expiry, approved_equipment, approved_commodities)
      VALUES (?,?,?,?,?,?,?)
    `).run(req.user.org_id, mc_number, dot_number, authority_status, insurance_expiry, JSON.stringify(equip), JSON.stringify(comm));
  }
  res.redirect('/compliance?saved=1');
});

module.exports = router;
