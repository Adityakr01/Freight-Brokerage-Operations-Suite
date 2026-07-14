const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin, requirePermission, requireAccountType } = require('../middleware/auth');
const { allPermissions, getPermissionsForUser } = require('../lib/rbac');

const router = express.Router();

router.use('/admin', requireLogin, requireAccountType('broker', 'carrier'));

// ---- Roles ----
router.get('/admin/roles', requirePermission('staff.manage'), (req, res) => {
  const roles = db.prepare(`SELECT * FROM roles WHERE org_id = ? ORDER BY id`).all(req.user.org_id);
  const rolePerms = {};
  for (const r of roles) {
    rolePerms[r.id] = db.prepare(`SELECT permission_key FROM role_permissions WHERE role_id = ?`).all(r.id).map(x => x.permission_key);
  }
  const perms = allPermissions().filter(p => p.applies_to === 'both' || p.applies_to === req.user.account_type);
  res.render('roles', { roles, rolePerms, perms, error: null });
});

router.post('/admin/roles', requirePermission('staff.manage'), (req, res) => {
  const { name } = req.body;
  let permsSelected = req.body.permissions || [];
  if (!Array.isArray(permsSelected)) permsSelected = [permsSelected];
  if (!name || !name.trim()) return res.redirect('/admin/roles');

  const validKeys = new Set(allPermissions().map(p => p.key));
  const tx = db.transaction(() => {
    const roleId = db.prepare(`INSERT INTO roles (org_id, name, is_admin_role) VALUES (?,?,0)`).run(req.user.org_id, name.trim()).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO role_permissions (role_id, permission_key) VALUES (?,?)`);
    for (const key of permsSelected) {
      if (validKeys.has(key)) ins.run(roleId, key);
    }
  });
  try {
    tx();
  } catch (e) {
    const roles = db.prepare(`SELECT * FROM roles WHERE org_id = ? ORDER BY id`).all(req.user.org_id);
    const perms = allPermissions().filter(p => p.applies_to === 'both' || p.applies_to === req.user.account_type);
    return res.status(400).render('roles', { roles, rolePerms: {}, perms, error: 'Role name must be unique within your org.' });
  }
  res.redirect('/admin/roles');
});

// ---- Staff ----
router.get('/admin/staff', requirePermission('staff.manage'), (req, res) => {
  const staff = db.prepare(`
    SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.org_id = ? ORDER BY u.id
  `).all(req.user.org_id);
  const roles = db.prepare(`SELECT * FROM roles WHERE org_id = ?`).all(req.user.org_id);
  res.render('staff', { staff, roles, error: null });
});

router.post('/admin/staff', requirePermission('staff.manage'), (req, res) => {
  const { name, email, password, role_id } = req.body;
  if (!name || !email || !password || !role_id) {
    const staff = db.prepare(`SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.org_id=?`).all(req.user.org_id);
    const roles = db.prepare(`SELECT * FROM roles WHERE org_id = ?`).all(req.user.org_id);
    return res.status(400).render('staff', { staff, roles, error: 'All fields are required.' });
  }
  // role must belong to the same org (org scoping on role assignment)
  const role = db.prepare(`SELECT * FROM roles WHERE id = ? AND org_id = ?`).get(role_id, req.user.org_id);
  if (!role) return res.status(400).send('Invalid role for this org.');

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.trim().toLowerCase());
  if (existing) {
    const staff = db.prepare(`SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.org_id=?`).all(req.user.org_id);
    const roles = db.prepare(`SELECT * FROM roles WHERE org_id = ?`).all(req.user.org_id);
    return res.status(400).render('staff', { staff, roles, error: 'Email already in use.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (email, password_hash, name, account_type, org_id, role_id, is_org_admin) VALUES (?,?,?,?,?,?,0)`
  ).run(email.trim().toLowerCase(), hash, name, req.user.account_type, req.user.org_id, role_id);
  res.redirect('/admin/staff');
});

router.post('/admin/staff/:id/deactivate', requirePermission('staff.manage'), (req, res) => {
  const staffUser = db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
  if (!staffUser) return res.status(404).send('Not found');
  db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(staffUser.id);
  res.redirect('/admin/staff');
});

module.exports = router;
