require('dotenv').config();
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const path = require('path');

const db = require('./db'); // runs schema + bootstrap on require
const { attachUser } = require('./middleware/auth');
const { getPermissionsForUser } = require('./lib/rbac');


const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');

app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'loadflow-hackathon-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(attachUser);
app.use((req, res, next) => {
  res.locals.perms = req.user ? [...getPermissionsForUser(req.user)] : [];
  res.locals.currentPath = req.path;
  res.locals.roleName = null;
  if (req.user && req.user.role_id) {
    const role = db.prepare(`SELECT name FROM roles WHERE id = ?`).get(req.user.role_id);
    res.locals.roleName = role ? role.name : null;
  }
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/staff'));
app.use(require('./routes/compliance'));
app.use(require('./routes/loads'));

app.use((req, res) => res.status(404).render('404'));

app.listen(PORT, () => {
  console.log(`LoadFlow running at http://localhost:${PORT}`);
});
