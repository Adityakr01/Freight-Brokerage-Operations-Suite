<<<<<<< HEAD
=======
# Freight-Brokerage-Operations-Suite

>>>>>>> 8f947abc4a82819a83eb08280b4bbbc27304bd7b
# LoadFlow — Freight Brokerage Operations Suite

A hackathon-scope operations platform for a freight brokerage: post loads, assign
compliant carriers, confirm rates, track pickup-to-delivery, and enforce
permission-based access for Broker staff, Carrier staff, and Shippers.

## Stack

**Node.js + Express + SQLite (better-sqlite3) + server-rendered EJS.**
One-line reason: a hackathon RBAC/compliance demo lives or dies on the
server-side authorization logic being obvious and auditable — a synchronous,
single-process SQL layer (`better-sqlite3`) keeps every permission check and
state transition in one readable code path with no ORM magic or async
race conditions, and EJS avoids standing up a separate SPA build just to
demonstrate role-gated UI. No client-side framework was needed because
nothing here requires optimistic UI — every action is a state transition
that must be confirmed server-side anyway.

## Running it

```bash
npm install
cp .env.example .env
npm start
# → http://localhost:3000
```

Node 18+ recommended. First run creates `data/loadflow.sqlite` and seeds
demo orgs, roles, users, and a couple of sample loads automatically
(see `db/index.js` → `bootstrap()`). Delete `data/loadflow.sqlite*` to reset.

### Demo logins (password for all: `Password123!`)

| Account | Email | Notes |
|---|---|---|
| Broker Admin | admin@summitfreight.test | Full broker permissions, staff/role management |
| Broker Staff | dispatcher@summitfreight.test | "Dispatcher" role: assign carrier + confirm rate only |
| Carrier Admin (compliant) | admin@ironhide.test | Insurance valid, approved for dry_van/reefer |
| Carrier Staff | driver@ironhide.test | "Driver" role: status updates + POD only |
| Carrier Admin (**non-compliant**) | admin@redline.test | Expired insurance — assigning this carrier auto-flags the load |
| Shipper | ops@brightgoods.test | Self-registered account type, sees only its own loads |

Try: log in as the broker admin, open **LF-1001** (already assigned to the
non-compliant carrier), and see the compliance flag block rate confirmation
until you override it or fix the carrier's record.

## RBAC model (as built)

- **Permission catalog** is a fixed table (`permissions`): `load.create`,
  `load.assign_carrier`, `load.override_compliance_flag`, `rate.confirm`,
  `load.update_status`, `load.accept_decline`, `staff.manage`, `pod.upload`,
  `compliance.manage`.
- **Roles** (`roles` + `role_permissions`) are org-scoped bundles of those
  permissions, created through the UI at **Admin → Roles & Permissions**
  — nothing is hardcoded to a role *name*. `lib/rbac.js` is the only place
  that resolves "what can this user do," and it does so purely by joining
  `role_permissions` for the user's `role_id`.
- Every mutating route in `routes/*.js` is wrapped in
  `requirePermission('some.key')` (see `middleware/auth.js`). The UI hides
  buttons a user can't use, but the same check runs again on the server —
  verified in testing by hitting endpoints directly with a lower-privileged
  session (a Carrier "Driver" account gets a 403 calling
  `POST /loads/:id/assign-carrier` even though that route exists).
- **Org scoping**: a Carrier user can only ever load rows where
  `carrier_org_id` matches their own org; Broker users are scoped to
  `broker_org_id`; Shippers to `shipper_id`. This is enforced in
  `middleware/auth.js#scopeLoad`, independent of permission grants — a
  Carrier admin with every permission in the catalog still can't open
  another carrier's load.
- **Permission-denied attempts** are written to `access_denied_log` (see
  that table, or **Admin → Audit Log** in the UI) with the acting user,
  method, path, and reason.

### Bootstrap vs. invited staff

The **first** Broker Admin and Carrier Admin accounts are not created
through a public sign-up form — in a real system that boundary (who gets to
found an org on the platform) would be a sales/verification step, not a
form. Here it's simulated by `db/index.js#bootstrap()`, which seeds two
broker/carrier orgs with an Admin user on first run. From there:

- **Staff** are created by their org's Admin (or anyone holding
  `staff.manage`) at **Admin → Staff**, assigned one of the org's roles.
  There's no email-invite/accept flow — the admin sets a temporary password
  directly, which a production version would replace with an emailed
  invite link.
- **Shippers** self-register at `/register` since they aren't part of an
  org hierarchy — anyone can create a shipper account, and loads are only
  ever linked to a shipper by a Broker explicitly typing their email when
  posting a load.

## Data model highlights

- `loads.status` is a `CHECK`-constrained state machine:
  `Posted → Carrier Assigned → Rate Confirmed → Dispatched → In Transit →
  Delivered → POD Verified → Invoiced/Closed`. Every transition writes a
  timestamped, attributed row to `load_audit` (see `lib/audit.js`).
- `rate_confirmations` is versioned per load (`UNIQUE(load_id, version)`).
  Confirming a new version marks the prior `confirmed` version
  `superseded`; a load always points at the specific version that was
  actually confirmed via `loads.active_rate_confirmation_id`, so it doesn't
  silently follow later edits.
- `carrier_compliance` is one row per carrier org (insurance expiry,
  MC/DOT authority status, approved equipment/commodity JSON arrays).
- Compliance auto-flagging (`lib/compliance.js#checkCompliance`) runs at
  the moment a carrier is assigned, and again is the gate checked before a
  rate confirmation can be confirmed or a load dispatched. A broker with
  `load.override_compliance_flag` can override it, but must supply a
  justification note, and the override is itself an audited event.

## Feature checklist status

**Must-haves — all implemented:**
1. Auth for Broker / Carrier / Shipper, admin-defined roles, server-side
   enforcement, org + object-level scoping
2. Load CRUD, full 8-state machine, audit trail
3. Carrier compliance record CRUD
4. Rate confirmation with versioning
5. Compliance auto-flagging blocking progression past "Carrier Assigned"
6. Dashboards per account type (broker load board + flag alerts, carrier
   assigned loads + actions, shipper own-load status)
7. Search/filter on the broker load board (reference/lane/commodity text
   search, status filter, carrier name filter)

**Stretch — implemented:**
8. POD upload/viewer (text-note based upload for demo purposes; see below)
9. Compliance expiry renewal alerts (carrier dashboard banner, <30 days
   or expired)
10. Audit log viewer (`/admin/audit-log`: load events + permission-denied
    log, org-admin only)

## Assumptions

- One compliance record per carrier **org** (not per truck/driver) — matches
  the brief's "carrier's insurance expiry, MC/DOT authority" framing.
- "Dispatch" and "close/invoice" are broker-permission-gated actions
  (`load.assign_carrier` and `rate.confirm` respectively) rather than new
  catalog entries, to keep the permission catalog to exactly what the brief
  listed.
- Carrier accept/decline is logged and, on decline, reopens the load to
  `Posted` and clears the carrier assignment; it doesn't block the state
  machine on its own (a broker can still dispatch without an explicit
  accept, same as many real TMS flows where verbal/phone confirmation
  happens off-platform).
- POD "upload" stores a text file (uploader, timestamp, delivery note) on
  disk rather than accepting arbitrary binary uploads/multipart, to avoid
  pulling in a file-upload middleware for a hackathon demo — the state
  transition and access-control logic is the same either way.

## What's incomplete / what I'd do with more time

- **Real email invites** for staff instead of admin-set temporary passwords.
- **Actual file upload** (multer + size/type limits) for POD instead of a
  text note, plus image preview.
- **Renewal workflow** for compliance (currently you can see the expiry
  warning and edit the record, but there's no reminder emails / scheduled
  job).
- **Pagination** on the load board and audit log — fine at demo scale,
  not at real volume.
- **Tests**: the RBAC/compliance/state-machine logic was verified with a
  scripted curl regression pass during development (login → create load →
  assign non-compliant carrier → confirm flag blocks rate confirmation →
  override → confirm → dispatch → carrier advances status → POD → close;
  plus negative tests: wrong-permission 403, cross-org 403), but that
  should become an actual automated test suite (Jest + supertest) rather
  than a manual script.
- **Multi-carrier bidding** — the brief describes a single assign-and-confirm
  flow, which is what's built; a real brokerage load board often has
  multiple carriers bidding before one is selected.
- **Rate confirmation PDF export** — versions are tracked in-app but not
  rendered as a document a carrier could countersign.

<<<<<<< HEAD
## AI tool usage note

Built with Claude (Anthropic) as a pair-programming tool: schema and RBAC
middleware were drafted first and reviewed line-by-line before wiring
routes to them (in particular, a real bug was caught and fixed this way —
an early version of the staff-management router accidentally applied its
"broker/carrier only" middleware to *every* route in the app because it was
registered without a path prefix, which silently 403'd shippers out of
their own load pages; found and fixed via the curl regression pass below,
before the routes were committed, by scoping the middleware to `/admin`).
Commit history reflects incremental build order: schema → RBAC/middleware
→ routes → views → styling → docs.
=======
>>>>>>> 8f947abc4a82819a83eb08280b4bbbc27304bd7b
