const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE email = ? AND active = 1`).get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { error: null });
});

// Shipper self-signup only. Broker/Carrier accounts are created via org admin
// bootstrap (seed) + staff invitation flow -- never self-service, since org
// membership must be assigned deliberately. See README "Bootstrap" section.
router.post('/register', (req, res) => {
  const { name, email, password, company } = req.body;
  if (!name || !email || !password) {
    return res.status(400).render('register', { error: 'All fields are required.' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.trim().toLowerCase());
  if (existing) {
    return res.status(400).render('register', { error: 'An account with that email already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const displayName = company ? `${name} (${company})` : name;
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, account_type, org_id, role_id, is_org_admin) VALUES (?,?,?,?,?,?,?)`
  ).run(email.trim().toLowerCase(), hash, displayName, 'shipper', null, null, 0);
  req.session.userId = info.lastInsertRowid;
  res.redirect('/dashboard');
});

module.exports = router;
