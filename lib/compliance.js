const db = require('../db');

/**
 * Evaluates a carrier org's compliance record against a load's requirements.
 * Returns { flagged: boolean, reasons: string[] }
 */
function checkCompliance(carrierOrgId, equipmentType, commodity) {
  const record = db.prepare(`SELECT * FROM carrier_compliance WHERE org_id = ?`).get(carrierOrgId);
  const reasons = [];

  if (!record) {
    reasons.push('No compliance record on file for this carrier.');
    return { flagged: true, reasons };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (record.insurance_expiry < today) {
    reasons.push(`Insurance expired on ${record.insurance_expiry}.`);
  }
  if (record.authority_status !== 'active') {
    reasons.push(`MC/DOT authority status is "${record.authority_status}", not active.`);
  }

  const equip = JSON.parse(record.approved_equipment || '[]');
  if (equipmentType && !equip.includes(equipmentType)) {
    reasons.push(`Carrier not approved for equipment type "${equipmentType}".`);
  }

  const commodities = JSON.parse(record.approved_commodities || '[]');
  if (commodity && !commodities.includes(commodity)) {
    reasons.push(`Carrier not approved for commodity "${commodity}".`);
  }

  return { flagged: reasons.length > 0, reasons };
}

module.exports = { checkCompliance };
