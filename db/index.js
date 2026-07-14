const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'loadflow.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('broker','carrier')),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Carrier compliance record: one per carrier org
CREATE TABLE IF NOT EXISTS carrier_compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL UNIQUE REFERENCES orgs(id),
  mc_number TEXT,
  dot_number TEXT,
  authority_status TEXT NOT NULL DEFAULT 'active' CHECK (authority_status IN ('active','revoked','pending')),
  insurance_expiry TEXT NOT NULL, -- ISO date
  approved_equipment TEXT NOT NULL DEFAULT '[]', -- JSON array e.g. ["dry_van","reefer"]
  approved_commodities TEXT NOT NULL DEFAULT '[]', -- JSON array
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Permission catalog (fixed, seeded once)
CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('broker','carrier','both'))
);

-- Roles: org-scoped bundles of permissions, admin-defined
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  is_admin_role INTEGER NOT NULL DEFAULT 0, -- built-in org Admin role (full perms), still permission-driven
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  permission_key TEXT NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

-- Users: broker/carrier staff belong to an org+role; shippers have org_id NULL, role NULL
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('broker','carrier','shipper')),
  org_id INTEGER REFERENCES orgs(id), -- NULL for shipper
  role_id INTEGER REFERENCES roles(id), -- NULL for shipper
  is_org_admin INTEGER NOT NULL DEFAULT 0, -- convenience flag; admin still gets full-perm role
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Loads
CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE, -- human friendly e.g. LF-1001
  broker_org_id INTEGER NOT NULL REFERENCES orgs(id),
  shipper_id INTEGER NOT NULL REFERENCES users(id),
  carrier_org_id INTEGER REFERENCES orgs(id), -- NULL until assigned
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  pickup_date TEXT,
  delivery_date TEXT,
  equipment_type TEXT NOT NULL, -- dry_van, reefer, flatbed...
  commodity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Posted' CHECK (status IN
    ('Posted','Carrier Assigned','Rate Confirmed','Dispatched','In Transit','Delivered','POD Verified','Invoiced/Closed')),
  compliance_flag INTEGER NOT NULL DEFAULT 0, -- 1 = blocked
  compliance_flag_reason TEXT,
  compliance_override_by INTEGER REFERENCES users(id),
  compliance_override_note TEXT,
  active_rate_confirmation_id INTEGER,
  pod_filename TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Rate confirmations: versioned per load
CREATE TABLE IF NOT EXISTS rate_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id),
  version INTEGER NOT NULL,
  base_rate REAL NOT NULL,
  accessorials TEXT NOT NULL DEFAULT '[]', -- JSON array of {label, amount}
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','superseded')),
  confirmed_by INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(load_id, version)
);

-- Full audit trail: state changes + key events, always attributed & timestamped
CREATE TABLE IF NOT EXISTS load_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  load_id INTEGER NOT NULL REFERENCES loads(id),
  actor_id INTEGER REFERENCES users(id),
  event TEXT NOT NULL, -- e.g. "status_change", "carrier_assigned", "rate_confirmed", "compliance_flagged", "compliance_override"
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Permission-denied log (server-side enforcement audit)
CREATE TABLE IF NOT EXISTS access_denied_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  email TEXT,
  method TEXT,
  path TEXT,
  reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------------------------------------------------------------------------
// SEED: permission catalog (idempotent)
// ---------------------------------------------------------------------------
const PERMISSIONS = [
  ['load.create', 'Post new loads', 'broker'],
  ['load.assign_carrier', 'Assign a carrier to a load', 'broker'],
  ['load.override_compliance_flag', 'Override a compliance block on a load', 'broker'],
  ['rate.confirm', 'Confirm a rate confirmation version', 'broker'],
  ['load.update_status', 'Advance load status (carrier side actions)', 'carrier'],
  ['load.accept_decline', 'Accept or decline an assigned load', 'carrier'],
  ['staff.manage', 'Create staff accounts and manage roles', 'both'],
  ['pod.upload', 'Upload proof of delivery', 'carrier'],
  ['compliance.manage', 'Create/update carrier compliance record', 'carrier'],
];

const insertPerm = db.prepare(`INSERT OR IGNORE INTO permissions (key, description, applies_to) VALUES (?,?,?)`);
const seedPerms = db.transaction(() => {
  for (const p of PERMISSIONS) insertPerm.run(...p);
});
seedPerms();

// ---------------------------------------------------------------------------
// BOOTSTRAP: first Broker Admin + Carrier Admin + a demo shipper + sample data
// Only runs once (checks if any org exists).
// ---------------------------------------------------------------------------
function bootstrap() {
  const orgCount = db.prepare(`SELECT COUNT(*) c FROM orgs`).get().c;
  if (orgCount > 0) return; // already bootstrapped

  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const insertOrg = db.prepare(`INSERT INTO orgs (type, name) VALUES (?,?)`);
  const insertRole = db.prepare(`INSERT INTO roles (org_id, name, is_admin_role) VALUES (?,?,?)`);
  const insertRolePerm = db.prepare(`INSERT INTO role_permissions (role_id, permission_key) VALUES (?,?)`);
  const insertUser = db.prepare(`INSERT INTO users (email, password_hash, name, account_type, org_id, role_id, is_org_admin) VALUES (?,?,?,?,?,?,?)`);
  const insertCompliance = db.prepare(`INSERT INTO carrier_compliance (org_id, mc_number, dot_number, authority_status, insurance_expiry, approved_equipment, approved_commodities) VALUES (?,?,?,?,?,?,?)`);

  const tx = db.transaction(() => {
    // --- Broker org + Admin ---
    const brokerOrgId = insertOrg.run('broker', 'Summit Freight Brokerage').lastInsertRowid;
    const brokerAdminRoleId = insertRole.run(brokerOrgId, 'Admin', 1).lastInsertRowid;
    ['load.create','load.assign_carrier','load.override_compliance_flag','rate.confirm','staff.manage']
      .forEach(p => insertRolePerm.run(brokerAdminRoleId, p));
    const brokerAdminId = insertUser.run(
      'admin@summitfreight.test', hash('Password123!'), 'Bailey Summit', 'broker', brokerOrgId, brokerAdminRoleId, 1
    ).lastInsertRowid;

    // Example admin-defined broker roles
    const dispatcherRoleId = insertRole.run(brokerOrgId, 'Dispatcher', 0).lastInsertRowid;
    ['load.assign_carrier','rate.confirm'].forEach(p => insertRolePerm.run(dispatcherRoleId, p));
    const opsLeadRoleId = insertRole.run(brokerOrgId, 'Ops Lead', 0).lastInsertRowid;
    ['load.create','load.assign_carrier','rate.confirm','load.override_compliance_flag'].forEach(p => insertRolePerm.run(opsLeadRoleId, p));

    const dispatcherId = insertUser.run(
      'dispatcher@summitfreight.test', hash('Password123!'), 'Dana Dispatcher', 'broker', brokerOrgId, dispatcherRoleId, 0
    ).lastInsertRowid;

    // --- Carrier org (compliant) + Admin ---
    const carrierOrgId = insertOrg.run('carrier', 'Ironhide Trucking LLC').lastInsertRowid;
    const carrierAdminRoleId = insertRole.run(carrierOrgId, 'Admin', 1).lastInsertRowid;
    ['load.update_status','load.accept_decline','pod.upload','staff.manage','compliance.manage']
      .forEach(p => insertRolePerm.run(carrierAdminRoleId, p));
    insertUser.run(
      'admin@ironhide.test', hash('Password123!'), 'Casey Ironhide', 'carrier', carrierOrgId, carrierAdminRoleId, 1
    ).lastInsertRowid;

    const driverRoleId = insertRole.run(carrierOrgId, 'Driver', 0).lastInsertRowid;
    ['load.update_status','pod.upload'].forEach(p => insertRolePerm.run(driverRoleId, p));
    const carrierDispatchRoleId = insertRole.run(carrierOrgId, 'Carrier Dispatch', 0).lastInsertRowid;
    ['load.accept_decline','load.update_status'].forEach(p => insertRolePerm.run(carrierDispatchRoleId, p));

    insertUser.run(
      'driver@ironhide.test', hash('Password123!'), 'Riley Driver', 'carrier', carrierOrgId, driverRoleId, 0
    );

    insertCompliance.run(
      carrierOrgId, 'MC-778812', 'DOT-4451290', 'active',
      '2027-06-30', JSON.stringify(['dry_van','reefer']), JSON.stringify(['general','frozen_foods'])
    );

    // --- A second carrier org that is NON-compliant, to demo flagging ---
    const badCarrierOrgId = insertOrg.run('carrier', 'Redline Logistics').lastInsertRowid;
    const badAdminRoleId = insertRole.run(badCarrierOrgId, 'Admin', 1).lastInsertRowid;
    ['load.update_status','load.accept_decline','pod.upload','staff.manage','compliance.manage']
      .forEach(p => insertRolePerm.run(badAdminRoleId, p));
    insertUser.run(
      'admin@redline.test', hash('Password123!'), 'Jordan Redline', 'carrier', badCarrierOrgId, badAdminRoleId, 1
    );
    insertCompliance.run(
      badCarrierOrgId, 'MC-100234', 'DOT-9981123', 'active',
      '2025-01-15', // expired insurance (past date) -> should trigger flag
      JSON.stringify(['dry_van']), JSON.stringify(['general'])
    );

    // --- Shipper (no sub-roles) ---
    const shipperId = insertUser.run(
      'ops@brightgoods.test', hash('Password123!'), 'Morgan Bright (Bright Goods Co.)', 'shipper', null, null, 0
    ).lastInsertRowid;

    // --- Sample loads ---
    const insertLoad = db.prepare(`
      INSERT INTO loads (reference, broker_org_id, shipper_id, origin, destination, pickup_date, delivery_date, equipment_type, commodity, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertAudit = db.prepare(`INSERT INTO load_audit (load_id, actor_id, event, from_value, to_value, note) VALUES (?,?,?,?,?,?)`);

    const load1 = insertLoad.run(
      'LF-1001', brokerOrgId, shipperId, 'Dallas, TX', 'Memphis, TN', '2026-07-20', '2026-07-21',
      'dry_van', 'general', 'Posted', brokerAdminId
    ).lastInsertRowid;
    insertAudit.run(load1, brokerAdminId, 'status_change', null, 'Posted', 'Load posted');

    const load2 = insertLoad.run(
      'LF-1002', brokerOrgId, shipperId, 'Atlanta, GA', 'Orlando, FL', '2026-07-18', '2026-07-19',
      'reefer', 'frozen_foods', 'Posted', dispatcherId
    ).lastInsertRowid;
    insertAudit.run(load2, dispatcherId, 'status_change', null, 'Posted', 'Load posted');
  });

  tx();
  console.log('[bootstrap] Seed data created. See README for demo logins.');
}

bootstrap();

module.exports = db;
