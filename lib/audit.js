const db = require('../db');

function logAudit(loadId, actorId, event, fromValue, toValue, note) {
  db.prepare(
    `INSERT INTO load_audit (load_id, actor_id, event, from_value, to_value, note) VALUES (?,?,?,?,?,?)`
  ).run(loadId, actorId || null, event, fromValue || null, toValue || null, note || null);
}

function getAuditTrail(loadId) {
  return db.prepare(`
    SELECT a.*, u.name AS actor_name, u.account_type AS actor_type
    FROM load_audit a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.load_id = ?
    ORDER BY a.id ASC
  `).all(loadId);
}

module.exports = { logAudit, getAuditTrail };
