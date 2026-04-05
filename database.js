const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Support Docker volume path
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Create all tables
db.exec(`
  CREATE TABLE IF NOT EXISTS wps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    lead_partner_id INTEGER,
    tenant_id INTEGER,
    FOREIGN KEY (lead_partner_id) REFERENCES partners(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wp_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    lead_partner_id INTEGER,
    FOREIGN KEY (wp_id) REFERENCES wps(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_partner_id) REFERENCES partners(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pic TEXT,
    rate REAL DEFAULT 0,
    type TEXT DEFAULT 'university',
    country TEXT,
    funding_rate REAL DEFAULT 1,
    wp_data TEXT DEFAULT '{}',
    other_cost REAL DEFAULT 0,
    subcontracting REAL DEFAULT 0,
    logo_path TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    contact_position TEXT,
    travel_meetings TEXT DEFAULT '[]',
    travel_dissem TEXT DEFAULT '[]',
    other_costs TEXT DEFAULT '[]',
    subcontracting_costs TEXT DEFAULT '[]',
    tenant_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS partner_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE
  );

  -- NEW: Scraped content table for storing web scraping results
  CREATE TABLE IF NOT EXISTS scraped_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    url_id INTEGER,
    url TEXT NOT NULL,
    content TEXT,
    scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    tenant_id INTEGER,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY (url_id) REFERENCES partner_urls(id) ON DELETE CASCADE
  );

  -- NEW: AI Analysis results table
  CREATE TABLE IF NOT EXISTS partner_ai_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    wp_id INTEGER,
    task_id INTEGER,
    url_id INTEGER,
    analysis_type TEXT NOT NULL,
    content TEXT,
    skills JSON,
    confidence_score REAL,
    analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    model_used TEXT,
    tenant_id INTEGER,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY (wp_id) REFERENCES wps(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (url_id) REFERENCES partner_urls(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','partner')),
    partner_id INTEGER,
    email TEXT,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS partner_wp_skills (
    partner_id INTEGER NOT NULL,
    wp_id INTEGER NOT NULL,
    score REAL NOT NULL,
    rationale TEXT,
    updated_at TEXT,
    PRIMARY KEY (partner_id, wp_id),
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE,
    FOREIGN KEY (wp_id) REFERENCES wps(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wp_assignments (
    wp_id INTEGER NOT NULL,
    partner_id INTEGER NOT NULL,
    PRIMARY KEY (wp_id, partner_id),
    FOREIGN KEY (wp_id) REFERENCES wps(id) ON DELETE CASCADE,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_assignments (
    task_id INTEGER NOT NULL,
    partner_id INTEGER NOT NULL,
    PRIMARY KEY (task_id, partner_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    owner_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tenant_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, user_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migrations: add start_month / end_month to wps and tasks if not present
try { db.exec("ALTER TABLE wps ADD COLUMN start_month INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE wps ADD COLUMN end_month INTEGER DEFAULT 48"); } catch(e) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN start_month INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN end_month INTEGER DEFAULT 48"); } catch(e) {}

// Hash function for passwords
function hash(password) {
  return bcrypt.hashSync(password, 10);
}

// Helper functions
function getPartnerUrls(partnerId) {
  return db.prepare("SELECT * FROM partner_urls WHERE partner_id = ? ORDER BY sort_order").all(partnerId);
}

function getSetting(key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// Get scraped content for a partner
function getScrapedContent(partnerId) {
  return db.prepare("SELECT * FROM scraped_content WHERE partner_id = ? ORDER BY scraped_at DESC").all(partnerId);
}

// Get AI analysis for a partner
function getPartnerAIAnalysis(partnerId) {
  return db.prepare("SELECT * FROM partner_ai_analysis WHERE partner_id = ? ORDER BY analyzed_at DESC").all(partnerId);
}

module.exports = { db, hash, getPartnerUrls, getSetting, setSetting, getScrapedContent, getPartnerAIAnalysis };
