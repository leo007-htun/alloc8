const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const { Resend } = require('resend');
const { db, hash, getPartnerUrls, getSetting, setSetting, getScrapedContent, getPartnerAIAnalysis } = require('./database');
const Bytez = require('bytez.js');
const bytezSdk = new Bytez('c83895ef7c4ccca7c35e864c70115b8d');

// Import scraper and analyzer modules
const { scrapePartner, scrapeAllPartners } = require('./scraper/simple-scraper');
const { queueAnalysis, analyzePartner, getPartnerAnalysis, isPartnerAnalyzing } = require('./analyzer');

// Resend email configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_GKPT2uXk_3nyTBW298JjSykpTUB5g6b3b';
const resend = new Resend(RESEND_API_KEY);

// Default from email (must be verified domain with Resend)
// For testing, you can use 'onboarding@resend.dev' or your own verified domain
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@alloc8.org';

console.log('Resend email client configured');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure settings table exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Set default indirect cost percentage if not exists
  const existing = db.prepare("SELECT 1 FROM settings WHERE key = 'indirect_cost_percentage' LIMIT 1").get();
  if (!existing) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('indirect_cost_percentage', '25')").run();
    console.log('Created default indirect_cost_percentage setting');
  }
  // Set default project duration months if not exists
  const existingDuration = db.prepare("SELECT 1 FROM settings WHERE key = 'project_duration_months' LIMIT 1").get();
  if (!existingDuration) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('project_duration_months', '48')").run();
    console.log('Created default project_duration_months setting');
  }
  console.log('Settings table ready');
} catch (err) {
  console.error('Error initializing settings table:', err);
}

const upload = multer({
  dest: path.join(__dirname, 'public', 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png') cb(null, true);
    else cb(new Error('Only PNG files are allowed'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'praise-budget-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    if (role && req.session.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function getAssignments() {
  const wpRows = db.prepare("SELECT wp_id, partner_id FROM wp_assignments").all();
  const taskRows = db.prepare("SELECT task_id, partner_id FROM task_assignments").all();
  const wpAssign = {};
  const taskAssign = {};
  wpRows.forEach(r => {
    if (!wpAssign[r.wp_id]) wpAssign[r.wp_id] = [];
    wpAssign[r.wp_id].push(r.partner_id);
  });
  taskRows.forEach(r => {
    if (!taskAssign[r.task_id]) taskAssign[r.task_id] = [];
    taskAssign[r.task_id].push(r.partner_id);
  });
  return { wpAssign, taskAssign };
}

function getWpsWithTasks(tenantId) {
  const wpQuery = tenantId
    ? "SELECT * FROM wps WHERE tenant_id = ? ORDER BY sort_order"
    : "SELECT * FROM wps ORDER BY sort_order";
  const wps = tenantId
    ? db.prepare(wpQuery).all(tenantId)
    : db.prepare(wpQuery).all();
  
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY wp_id, sort_order").all();
  
  const partnerQuery = tenantId
    ? "SELECT id, name FROM partners WHERE tenant_id = ?"
    : "SELECT id, name FROM partners";
  const partners = tenantId
    ? db.prepare(partnerQuery).all(tenantId)
    : db.prepare(partnerQuery).all();
  
  const partnerMap = {};
  partners.forEach(p => partnerMap[p.id] = p.name);
  const { wpAssign, taskAssign } = getAssignments();

  wps.forEach(wp => {
    wp.assigned_partner_ids = wpAssign[wp.id] || [];
    wp.assigned_names = wp.assigned_partner_ids.map(id => partnerMap[id]).filter(Boolean);
    wp.lead_name = wp.assigned_names.join(', ') || '—';
    wp.tasks = tasks.filter(t => t.wp_id === wp.id).map(t => {
      const ids = taskAssign[t.id] || [];
      const names = ids.map(id => partnerMap[id]).filter(Boolean);
      return { ...t, assigned_partner_ids: ids, assigned_names: names, lead_name: names.join(', ') || '—' };
    });
  });
  return wps;
}

function getPartnerWps(partnerId) {
  // Get partner's tenant to filter WPs
  const partner = db.prepare("SELECT tenant_id FROM partners WHERE id = ?").get(partnerId);
  const tenantId = partner?.tenant_id;
  const wps = getWpsWithTasks(tenantId);
  return wps.filter(wp => {
    if (wp.assigned_partner_ids.includes(partnerId)) return true;
    return wp.tasks.some(t => t.assigned_partner_ids.includes(partnerId));
  }).map(wp => {
    const isWpLead = wp.assigned_partner_ids.includes(partnerId);
    const visibleTasks = isWpLead
      ? wp.tasks
      : wp.tasks.filter(t => t.assigned_partner_ids.includes(partnerId));
    return { ...wp, tasks: visibleTasks, isWpLead };
  });
}

function parseWpData(str) {
  try { return JSON.parse(str || '{}'); } catch (e) { return {}; }
}

function parseTravelData(str) {
  try { return JSON.parse(str || '[]'); } catch (e) { return []; }
}

function parseOtherCosts(str) {
  try { return JSON.parse(str || '[]'); } catch (e) { return []; }
}

function parseSubcontractingCosts(str) {
  try { return JSON.parse(str || '[]'); } catch (e) { return []; }
}

function getPartnerById(id) {
  const p = db.prepare("SELECT * FROM partners WHERE id = ?").get(id);
  if (p) {
    p.wp_data = parseWpData(p.wp_data);
    p.travel_meetings = parseTravelData(p.travel_meetings);
    p.travel_dissem = parseTravelData(p.travel_dissem);
    p.other_costs = parseOtherCosts(p.other_costs);
    p.subcontracting_costs = parseSubcontractingCosts(p.subcontracting_costs);
    p.urls = getPartnerUrls(id);
  }
  return p;
}

function getAllPartners(tenantId) {
  const query = tenantId 
    ? "SELECT * FROM partners WHERE tenant_id = ? ORDER BY id"
    : "SELECT * FROM partners ORDER BY id";
  const partners = tenantId 
    ? db.prepare(query).all(tenantId)
    : db.prepare(query).all();
  partners.forEach(p => {
    p.wp_data = parseWpData(p.wp_data);
    p.travel_meetings = parseTravelData(p.travel_meetings);
    p.travel_dissem = parseTravelData(p.travel_dissem);
    p.other_costs = parseOtherCosts(p.other_costs);
    p.subcontracting_costs = parseSubcontractingCosts(p.subcontracting_costs);
    p.urls = getPartnerUrls(p.id);
  });
  return partners;
}

function removeTaskFromPartners(taskId) {
  const partners = getAllPartners();
  partners.forEach(p => {
    const data = p.wp_data;
    if (data[taskId] !== undefined) {
      delete data[taskId];
      db.prepare("UPDATE partners SET wp_data = ? WHERE id = ?").run(JSON.stringify(data), p.id);
    }
  });
}

const analyzingLock = new Set();

async function fetchUrlText(url, maxChars = 1200) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, maxChars);
  } catch (e) {
    return null;
  }
}

async function analyzePartnerSkills(partnerId) {
  if (analyzingLock.has(partnerId)) return { partnerId, skipped: true };
  analyzingLock.add(partnerId);
  try {
    // Clear old skill scores before running new analysis
    db.prepare("DELETE FROM partner_wp_skills WHERE partner_id = ?").run(partnerId);
    
    const partner = getPartnerById(partnerId);
    if (!partner) throw new Error('Partner not found');
    const wps = db.prepare("SELECT id, name FROM wps ORDER BY sort_order").all();
    const validWpIds = new Set(wps.map(w => w.id));

    if (!partner.urls || partner.urls.length === 0) {
      return { partnerId, analyzed: 0 };
    }

    const urlContents = [];
    for (const u of partner.urls) {
      const content = await fetchUrlText(u.url);
      urlContents.push({ url: u.url, description: u.description || '', content: content || '[Could not fetch content]' });
    }

    const urlBlocks = urlContents.map((u, i) => `URL ${i + 1}: ${u.url}\nDescription: ${u.description}\nContent excerpt: ${u.content}`).join('\n---\n');
    const wpLines = wps.map(w => `${w.id}: ${w.name}`).join('\n');

    const prompt = `You are a strict evaluator rating a consortium partner for project Work Packages.
BASE YOUR SCORES ONLY ON THE URL CONTENT PROVIDED BELOW.
If the URL content does not clearly demonstrate expertise directly related to a Work Package, give a LOW score (1.0-2.0).
Do NOT assume the partner is good at everything because they are a university or company. Be critical and evidence-based.

Partner: ${partner.name}
Type: ${partner.type}

Evidence (URL content excerpts):
${urlBlocks}

Work Packages to rate (1.0 = no relevance, 5.0 = highly relevant):
${wpLines}

Reply with ONLY Work Package ID and score on separate lines like:
1:2.0
2:4.5
No other text.`;

    const model = bytezSdk.model("Qwen/Qwen3-0.6B");
    let inserted = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await model.run([{ role: "user", content: prompt }]);
      if (result.error) {
        if (attempt === 3) throw new Error(result.error.message || JSON.stringify(result.error));
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      let text = result.output;
      if (typeof text === 'object' && text !== null) {
        text = text.content || text.text || JSON.stringify(text);
      }
      if (typeof text !== 'string') text = String(text);
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
      text = text.trim();

      const now = new Date().toISOString();
      db.prepare("DELETE FROM partner_wp_skills WHERE partner_id = ?").run(partnerId);
      const insertStmt = db.prepare("INSERT INTO partner_wp_skills (partner_id, wp_id, score, rationale, updated_at) VALUES (?, ?, ?, ?, ?)");
      const lines = text.split('\n');
      let batchInserted = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(':')) continue;
        const [idPart, scorePart] = trimmed.split(':');
        const wpId = parseInt(idPart.trim());
        const score = parseFloat(scorePart.trim());
        if (isNaN(wpId) || isNaN(score) || !validWpIds.has(wpId)) continue;
        insertStmt.run(partnerId, wpId, score, '', now);
        batchInserted++;
      }
      inserted += batchInserted;
      if (inserted >= wps.length) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
    return { partnerId, analyzed: inserted };
  } finally {
    analyzingLock.delete(partnerId);
  }
}

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.partnerId = user.partner_id;
  
  // Get user's tenants
  const memberships = db.prepare(`
    SELECT t.id, t.name, tm.role as tenant_role
    FROM tenants t
    JOIN tenant_memberships tm ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.active = 1
  `).all(user.id);
  
  // Set current tenant (first one, or based on partner record, or default for legacy users)
  if (memberships.length > 0) {
    req.session.tenantId = memberships[0].id;
  } else if (user.role === 'admin') {
    // For legacy admin without tenant, find or create default
    let defaultTenant = db.prepare("SELECT id FROM tenants LIMIT 1").get();
    if (defaultTenant) {
      req.session.tenantId = defaultTenant.id;
      // Add membership if not exists
      db.prepare("INSERT OR IGNORE INTO tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')")
        .run(defaultTenant.id, user.id);
    }
  } else if (user.role === 'partner' && user.partner_id) {
    // For partners, get tenant from their partner record
    const partner = db.prepare("SELECT tenant_id FROM partners WHERE id = ?").get(user.partner_id);
    if (partner?.tenant_id) {
      req.session.tenantId = partner.tenant_id;
    }
  }
  
  res.json({
    role: user.role,
    username: user.username,
    partnerId: user.partner_id,
    tenantId: req.session.tenantId,
    tenants: memberships
  });
});

// Sign up - Create new user with their own tenant/project
app.post('/api/signup', async (req, res) => {
  try {
    const { email, projectName, username, password } = req.body;
    
    // Validation
    if (!email || !projectName || !username || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username must be lowercase letters, numbers, or underscores' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    // Check if username exists
    const existingUser = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    
    // Check if email exists
    const existingEmail = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    
    // Create user
    const userResult = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
      username, email, hash(password)
    );
    const userId = userResult.lastInsertRowid;
    
    // Create tenant (project)
    const tenantResult = db.prepare("INSERT INTO tenants (name, description, owner_id) VALUES (?, ?, ?)").run(
      projectName,
      `Project created by ${username}`,
      userId
    );
    const tenantId = tenantResult.lastInsertRowid;
    
    // Add user as tenant owner
    db.prepare("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')").run(
      tenantId, userId
    );
    
    console.log(`New signup: user=${username}, tenant=${projectName} (ID: ${tenantId})`);
    res.json({ ok: true, userId, tenantId });
    
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account: ' + err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  
  // Get user info
  const user = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.session.userId);
  
  // Get user's tenants
  const memberships = db.prepare(`
    SELECT t.id, t.name, tm.role as tenant_role
    FROM tenants t
    JOIN tenant_memberships tm ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.active = 1
  `).all(req.session.userId);
  
  res.json({ 
    loggedIn: true,
    userId: req.session.userId,
    username: user?.username || '',
    role: req.session.role, 
    partnerId: req.session.partnerId,
    tenantId: req.session.tenantId,
    tenants: memberships
  });
});

// Partner endpoints
app.get('/api/partner/data', requireAuth('partner'), (req, res) => {
  const partner = getPartnerById(req.session.partnerId);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });
  res.json({ partner, wps: getPartnerWps(req.session.partnerId) });
});

app.get('/api/partner/overview', requireAuth('partner'), (req, res) => {
  const partner = getPartnerById(req.session.partnerId);
  if (!partner) return res.status(404).json({ error: 'Partner not found' });
  // Get partner's tenant to filter WPs
  const tenantId = partner?.tenant_id;
  res.json({ partner, wps: getWpsWithTasks(tenantId) });
});

app.put('/api/partner/data', requireAuth('partner'), (req, res) => {
  const { name, pic, rate, type, country, funding_rate, wp_data, other_costs, subcontracting_costs, contact_name, contact_position, contact_email, contact_phone, travel_meetings, travel_dissem } = req.body;
  const partnerId = req.session.partnerId;
  const p = db.prepare("SELECT logo_path FROM partners WHERE id = ?").get(partnerId);
  if (!p || !p.logo_path) {
    return res.status(400).json({ error: 'Please upload your organisation logo before saving.' });
  }
  try {
    db.prepare(`
      UPDATE partners SET
        name = ?, pic = ?, rate = ?, type = ?, country = ?, funding_rate = ?,
        wp_data = ?, other_cost = ?, subcontracting = ?,
        contact_name = ?, contact_email = ?, contact_phone = ?, contact_position = ?,
        travel_meetings = ?, travel_dissem = ?, other_costs = ?, subcontracting_costs = ?
      WHERE id = ?
    `).run(
      name, pic, rate, type, country, funding_rate,
      JSON.stringify(wp_data || {}), 0, 0,
      contact_name || '', contact_email || '', contact_phone || '', contact_position || '',
      JSON.stringify(travel_meetings || []), JSON.stringify(travel_dissem || []),
      JSON.stringify(other_costs || []), JSON.stringify(subcontracting_costs || []),
      partnerId
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving partner data:', err);
    res.status(500).json({ error: 'Failed to save: ' + err.message });
  }
});

app.post('/api/partner/logo', requireAuth('partner'), upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const partnerId = req.session.partnerId;
  const old = db.prepare("SELECT logo_path FROM partners WHERE id = ?").get(partnerId);
  if (old && old.logo_path) {
    try { fs.unlinkSync(path.join(__dirname, 'public', old.logo_path)); } catch (e) {}
  }
  const logoPath = '/uploads/' + req.file.filename;
  db.prepare("UPDATE partners SET logo_path = ? WHERE id = ?").run(logoPath, partnerId);
  res.json({ logo_path: logoPath });
});

app.get('/api/partner/consortium', requireAuth('partner'), (req, res) => {
  // Get the current partner's tenant_id
  const partner = db.prepare("SELECT tenant_id FROM partners WHERE id = ?").get(req.session.partnerId);
  const tenantId = partner?.tenant_id;
  
  // Only return partners from the same tenant
  const query = tenantId 
    ? "SELECT id, name, logo_path FROM partners WHERE tenant_id = ? ORDER BY id"
    : "SELECT id, name, logo_path FROM partners ORDER BY id";
  const rows = tenantId 
    ? db.prepare(query).all(tenantId)
    : db.prepare(query).all();
  res.json(rows);
});

app.get('/api/partner/skills', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  
  // Get tenant scope - for partners use their partner's tenant, for admins use session tenant
  let tenantId = req.session.tenantId;
  if (req.session.role === 'partner' && req.session.partnerId) {
    const partner = db.prepare("SELECT tenant_id FROM partners WHERE id = ?").get(req.session.partnerId);
    tenantId = partner?.tenant_id;
  }
  
  // Filter partners by tenant
  const partnerQuery = tenantId
    ? "SELECT id, name, logo_path, contact_name, contact_email, contact_phone, contact_position FROM partners WHERE tenant_id = ? ORDER BY id"
    : "SELECT id, name, logo_path, contact_name, contact_email, contact_phone, contact_position FROM partners ORDER BY id";
  const partners = tenantId
    ? db.prepare(partnerQuery).all(tenantId)
    : db.prepare(partnerQuery).all();
  
  // Filter skills by tenant's partners
  const partnerIds = partners.map(p => p.id);
  const skillsQuery = partnerIds.length > 0
    ? `SELECT partner_id, wp_id, score, rationale FROM partner_wp_skills WHERE partner_id IN (${partnerIds.join(',')})`
    : "SELECT partner_id, wp_id, score, rationale FROM partner_wp_skills WHERE 1=0";
  const skills = partnerIds.length > 0 ? db.prepare(skillsQuery).all() : [];
  
  // Filter WPs by tenant
  const wpQuery = tenantId
    ? "SELECT id, name FROM wps WHERE tenant_id = ?"
    : "SELECT id, name FROM wps";
  const wps = tenantId
    ? db.prepare(wpQuery).all(tenantId)
    : db.prepare(wpQuery).all();
  
  const wpMap = {};
  wps.forEach(w => wpMap[w.id] = w.name);
  const skillMap = {};
  skills.forEach(s => {
    if (!skillMap[s.partner_id]) skillMap[s.partner_id] = [];
    skillMap[s.partner_id].push({ ...s, wp_name: wpMap[s.wp_id] || '' });
  });
  partners.forEach(p => {
    p.skills = (skillMap[p.id] || []).sort((a, b) => b.score - a.score);
  });
  res.json(partners);
});

// Partner URL management
app.get('/api/partner/urls', requireAuth('partner'), (req, res) => {
  res.json(getPartnerUrls(req.session.partnerId));
});

app.post('/api/partner/urls', requireAuth('partner'), (req, res) => {
  const partnerId = req.session.partnerId;
  const { url, description } = req.body;
  const max = db.prepare("SELECT COALESCE(MAX(sort_order), -1) as m FROM partner_urls WHERE partner_id = ?").get(partnerId).m;
  const info = db.prepare("INSERT INTO partner_urls (partner_id, url, description, sort_order) VALUES (?, ?, ?, ?)").run(partnerId, url, description || '', max + 1);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/partner/urls/:id', requireAuth('partner'), (req, res) => {
  const id = req.params.id;
  const { url, description } = req.body;
  const check = db.prepare("SELECT partner_id FROM partner_urls WHERE id = ?").get(id);
  if (!check || check.partner_id !== req.session.partnerId) return res.status(403).json({ error: 'Forbidden' });
  db.prepare("UPDATE partner_urls SET url = ?, description = ? WHERE id = ?").run(url, description || '', id);
  res.json({ ok: true });
});

app.delete('/api/partner/urls/:id', requireAuth('partner'), (req, res) => {
  const id = req.params.id;
  const check = db.prepare("SELECT partner_id FROM partner_urls WHERE id = ?").get(id);
  if (!check || check.partner_id !== req.session.partnerId) return res.status(403).json({ error: 'Forbidden' });
  db.prepare("DELETE FROM partner_urls WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Partner: Check if analysis is in progress
app.get('/api/partner/analysis-status', requireAuth('partner'), (req, res) => {
  const partnerId = req.session.partnerId;
  // Check both the old lock and the new analyzer queue
  const isAnalyzing = analyzingLock.has(partnerId) || isPartnerAnalyzing(partnerId);
  res.json({ analyzing: isAnalyzing, partnerId });
});

// Partner: Save URLs batch + trigger scrape and analysis
app.post('/api/partner/urls/save', requireAuth('partner'), async (req, res) => {
  const partnerId = req.session.partnerId;
  const tenantId = req.session.tenantId;
  const { urls } = req.body;
  
  if (!Array.isArray(urls)) {
    return res.status(400).json({ error: 'urls must be an array' });
  }
  
  try {
    // 1. Delete all existing URLs and related data for this partner
    db.prepare('DELETE FROM partner_urls WHERE partner_id = ?').run(partnerId);
    // Clear old skill scores since URLs are changing
    db.prepare('DELETE FROM partner_wp_skills WHERE partner_id = ?').run(partnerId);
    
    // 2. Insert new URLs
    const insertStmt = db.prepare(
      'INSERT INTO partner_urls (partner_id, url, description, sort_order) VALUES (?, ?, ?, ?)'
    );
    const validUrls = urls.filter(u => u.url && u.url.trim());
    validUrls.forEach((u, i) => {
      insertStmt.run(partnerId, u.url.trim(), u.description || '', i);
    });
    
    console.log(`[Partner ${partnerId}] Saved ${validUrls.length} URLs, cleared old skill scores`);
    
    // 3. Trigger scraping
    console.log(`[Partner ${partnerId}] Starting scrape...`);
    const scrapeResults = await scrapePartner(partnerId, tenantId);
    console.log(`[Partner ${partnerId}] Scrape completed:`, scrapeResults);
    
    // 4. Trigger analysis (if we have scraped content)
    let analysisResult = null;
    const hasContent = db.prepare(
      'SELECT 1 FROM scraped_content WHERE partner_id = ? AND status = ? LIMIT 1'
    ).get(partnerId, 'completed');
    
    if (hasContent) {
      console.log(`[Partner ${partnerId}] Starting analysis...`);
      analysisResult = analyzePartner(partnerId, tenantId);
      console.log(`[Partner ${partnerId}] Analysis queued:`, analysisResult);
    }
    
    res.json({
      ok: true,
      urlsSaved: validUrls.length,
      scrape: scrapeResults,
      analysis: analysisResult,
      message: `Saved ${validUrls.length} URLs. Scraped ${scrapeResults?.scraped || 0} URLs. Analysis ${analysisResult ? 'queued' : 'skipped (no content)'}.`
    });
    
  } catch (error) {
    console.error(`[Partner ${partnerId}] Save failed:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoints

// Test endpoint to verify server is running new code
app.get('/api/version', (req, res) => {
  res.json({ version: '1.1', hasSettingsAPI: true });
});

console.log('Registering settings endpoints...');

// Settings endpoints
app.get('/api/admin/settings', requireAuth('admin'), (req, res) => {
  try {
    const indirectPercentage = getSetting('indirect_cost_percentage', '25');
    const projectDuration = getSetting('project_duration_months', '48');
    const projectDescription = getSetting('project_description', '');
    res.json({ 
      indirect_cost_percentage: parseInt(indirectPercentage, 10),
      project_duration_months: parseFloat(projectDuration),
      project_description: projectDescription
    });
  } catch (err) {
    console.error('Error getting settings:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

app.put('/api/admin/settings', requireAuth('admin'), (req, res) => {
  try {
    const { indirect_cost_percentage, project_duration_months, project_description } = req.body;
    if (indirect_cost_percentage === undefined || indirect_cost_percentage < 0 || indirect_cost_percentage > 100) {
      return res.status(400).json({ error: 'Invalid indirect cost percentage' });
    }
    if (project_duration_months === undefined || project_duration_months < 1 || project_duration_months > 120) {
      return res.status(400).json({ error: 'Invalid project duration (must be 1-120 months)' });
    }
    setSetting('indirect_cost_percentage', indirect_cost_percentage.toString());
    setSetting('project_duration_months', project_duration_months.toString());
    if (project_description !== undefined) {
      setSetting('project_description', project_description);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

// Public settings endpoint (for partners to read)
app.get('/api/settings', (req, res) => {
  const indirectPercentage = getSetting('indirect_cost_percentage', '25');
  const projectDuration = getSetting('project_duration_months', '48');
  const projectDescription = getSetting('project_description', '');
  res.json({ 
    indirect_cost_percentage: parseInt(indirectPercentage, 10),
    project_duration_months: parseFloat(projectDuration),
    project_description: projectDescription
  });
});

console.log('Settings endpoints registered');

app.get('/api/admin/partners', requireAuth('admin'), (req, res) => {
  const tenantId = req.session.tenantId;
  const partners = getAllPartners(tenantId);
  const users = db.prepare("SELECT id, username, partner_id FROM users WHERE role = 'partner'").all();
  const userMap = {};
  users.forEach(u => userMap[u.partner_id] = u.username);
  partners.forEach(p => p.username = userMap[p.id] || '');
  res.json({ partners, wps: getWpsWithTasks(tenantId) });
});

app.post('/api/admin/partners', requireAuth('admin'), (req, res) => {
  const tenantId = req.session.tenantId;
  const { name, username, password, pic, rate, type, country, funding_rate, wp_data, other_costs, subcontracting_costs, urls, contact_name, contact_email, contact_phone, contact_position } = req.body;
  const info = db.prepare(`
    INSERT INTO partners (name, pic, rate, type, country, funding_rate, wp_data, other_cost, subcontracting, logo_path, contact_name, contact_email, contact_phone, contact_position, other_costs, subcontracting_costs, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, pic || '', rate || 0, type || 'university', country || '', funding_rate || 1, JSON.stringify(wp_data || {}), 0, 0, null, contact_name || '', contact_email || '', contact_phone || '', contact_position || '', JSON.stringify(other_costs || []), JSON.stringify(subcontracting_costs || []), tenantId || null);
  const partnerId = info.lastInsertRowid;
  const uname = (username || name.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, ''));
  const pw = password || uname;
  db.prepare("INSERT INTO users (username, password_hash, role, partner_id) VALUES (?, ?, 'partner', ?)").run(uname, hash(pw), partnerId);
  if (Array.isArray(urls)) {
    const insertUrl = db.prepare("INSERT INTO partner_urls (partner_id, url, description, sort_order) VALUES (?, ?, ?, ?)");
    urls.forEach((u, i) => insertUrl.run(partnerId, u.url, u.description || '', i));
  }
  res.json({ id: partnerId });
});

app.delete('/api/admin/partners/:id', requireAuth('admin'), (req, res) => {
  const id = req.params.id;
  const p = db.prepare("SELECT logo_path FROM partners WHERE id = ?").get(id);
  if (p && p.logo_path) {
    try { fs.unlinkSync(path.join(__dirname, 'public', p.logo_path)); } catch (e) {}
  }
  db.prepare("DELETE FROM users WHERE partner_id = ?").run(id);
  db.prepare("DELETE FROM partners WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.put('/api/admin/partners/:id', requireAuth('admin'), (req, res) => {
  const id = req.params.id;
  const { name, pic, rate, type, country, funding_rate, wp_data, other_costs, subcontracting_costs, urls, contact_name, contact_email, contact_phone, contact_position, travel_meetings, travel_dissem } = req.body;
  db.prepare(`
    UPDATE partners SET
      name = ?, pic = ?, rate = ?, type = ?, country = ?, funding_rate = ?,
      wp_data = ?, other_cost = ?, subcontracting = ?,
      contact_name = ?, contact_email = ?, contact_phone = ?, contact_position = ?,
      travel_meetings = ?, travel_dissem = ?, other_costs = ?, subcontracting_costs = ?
    WHERE id = ?
  `).run(
    name, pic, rate, type, country, funding_rate,
    JSON.stringify(wp_data || {}), 0, 0,
    contact_name || '', contact_email || '', contact_phone || '', contact_position || '',
    JSON.stringify(travel_meetings || []), JSON.stringify(travel_dissem || []),
    JSON.stringify(other_costs || []), JSON.stringify(subcontracting_costs || []),
    id
  );
  db.prepare("DELETE FROM partner_urls WHERE partner_id = ?").run(id);
  // Clear old skill scores when URLs are updated
  db.prepare("DELETE FROM partner_wp_skills WHERE partner_id = ?").run(id);
  if (Array.isArray(urls)) {
    const insertUrl = db.prepare("INSERT INTO partner_urls (partner_id, url, description, sort_order) VALUES (?, ?, ?, ?)");
    urls.forEach((u, i) => insertUrl.run(id, u.url, u.description || '', i));
  }
  res.json({ ok: true });
});

app.post('/api/admin/partners/:id/reset-password', requireAuth('admin'), (req, res) => {
  const id = req.params.id;
  const { password } = req.body;
  const user = db.prepare("SELECT id FROM users WHERE partner_id = ?").get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash(password), user.id);
  res.json({ ok: true });
});

// Admin user management endpoints
app.get('/api/admin/users', requireAuth('admin'), (req, res) => {
  const tenantId = req.session.tenantId;
  const userId = req.session.userId;
  
  // Get current user's tenant memberships
  const userTenants = db.prepare("SELECT tenant_id FROM tenant_memberships WHERE user_id = ?").all(userId);
  const tenantIds = userTenants.map(t => t.tenant_id);
  
  if (tenantIds.length === 0) {
    return res.json([]);
  }
  
  // Get all admins who are members of the same tenants
  const placeholders = tenantIds.map(() => '?').join(',');
  const query = `
    SELECT DISTINCT u.id, u.username, u.role, tm.tenant_id, tm.role as tenant_role
    FROM users u
    JOIN tenant_memberships tm ON u.id = tm.user_id
    WHERE u.role = 'admin' AND tm.tenant_id IN (${placeholders})
    ORDER BY u.id
  `;
  const users = db.prepare(query).all(...tenantIds);
  res.json(users);
});

app.post('/api/admin/users', requireAuth('admin'), (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username must be lowercase letters, numbers, or underscores only' });
  }
  if (role !== 'admin') {
    return res.status(400).json({ error: 'Can only create admin users through this endpoint' });
  }
  
  // Check if username already exists
  const existing = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  
  try {
    db.prepare("INSERT INTO users (username, password_hash, role, partner_id) VALUES (?, ?, ?, NULL)").run(
      username, hash(password), role
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user: ' + err.message });
  }
});

app.delete('/api/admin/users/:id', requireAuth('admin'), (req, res) => {
  const id = req.params.id;
  
  // Prevent deleting the primary admin (id=1)
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.username === 'admin') {
    return res.status(403).json({ error: 'Cannot delete the primary admin account' });
  }
  
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'admin'").run(id);
  res.json({ ok: true });
});

// Primary admin: delete an entire project and all its data
app.delete('/api/admin/projects/:id', requireAuth('admin'), (req, res) => {
  const caller = db.prepare("SELECT username FROM users WHERE id = ?").get(req.session.userId);
  if (caller?.username !== 'admin') return res.status(403).json({ error: 'Primary admin only' });

  const tenantId = parseInt(req.params.id);
  if (!tenantId) return res.status(400).json({ error: 'Invalid project id' });

  try {
    db.transaction(() => {
      const partnerIds = db.prepare("SELECT id FROM partners WHERE tenant_id = ?").all(tenantId).map(p => p.id);
      const wpIds      = db.prepare("SELECT id FROM wps     WHERE tenant_id = ?").all(tenantId).map(w => w.id);
      const taskIds    = wpIds.length
        ? db.prepare(`SELECT id FROM tasks WHERE wp_id IN (${wpIds.map(() => '?').join(',')})`).all(...wpIds).map(t => t.id)
        : [];

      if (taskIds.length) {
        const ph = taskIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM task_assignments WHERE task_id IN (${ph})`).run(...taskIds);
      }
      if (wpIds.length) {
        const ph = wpIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM wp_assignments WHERE wp_id IN (${ph})`).run(...wpIds);
      }

      db.prepare("DELETE FROM tasks WHERE wp_id IN (SELECT id FROM wps WHERE tenant_id = ?)").run(tenantId);
      db.prepare("DELETE FROM wps   WHERE tenant_id = ?").run(tenantId);

      if (partnerIds.length) {
        const ph = partnerIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM partner_wp_skills    WHERE partner_id IN (${ph})`).run(...partnerIds);
        db.prepare(`DELETE FROM scraped_content      WHERE partner_id IN (${ph})`).run(...partnerIds);
        db.prepare(`DELETE FROM partner_ai_analysis  WHERE partner_id IN (${ph})`).run(...partnerIds);
        db.prepare(`DELETE FROM partner_urls         WHERE partner_id IN (${ph})`).run(...partnerIds);
        db.prepare(`DELETE FROM users                WHERE partner_id IN (${ph})`).run(...partnerIds);
      }

      db.prepare("DELETE FROM partners          WHERE tenant_id = ?").run(tenantId);
      db.prepare("DELETE FROM tenant_memberships WHERE tenant_id = ?").run(tenantId);
      db.prepare("DELETE FROM tenants            WHERE id = ?").run(tenantId);
    })();

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete project error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Tenant management endpoints
app.get('/api/tenants', requireAuth('admin'), (req, res) => {
  const userId = req.session.userId;
  const tenants = db.prepare(`
    SELECT t.id, t.name, t.description, tm.role as membership_role
    FROM tenants t
    JOIN tenant_memberships tm ON t.id = tm.tenant_id
    WHERE tm.user_id = ? AND t.active = 1
    ORDER BY t.created_at DESC
  `).all(userId);
  res.json(tenants);
});

app.post('/api/tenants', requireAuth('admin'), (req, res) => {
  const userId = req.session.userId;
  const { name, description } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Project name is required' });
  }
  
  try {
    // Create tenant
    const tenantResult = db.prepare("INSERT INTO tenants (name, description, owner_id) VALUES (?, ?, ?)").run(
      name, description || '', userId
    );
    const tenantId = tenantResult.lastInsertRowid;
    
    // Add user as owner
    db.prepare("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (?, ?, 'owner')").run(
      tenantId, userId
    );
    
    // Switch session to new tenant
    req.session.tenantId = tenantId;
    
    res.json({ ok: true, tenantId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create project: ' + err.message });
  }
});

app.post('/api/switch-tenant', requireAuth('admin'), (req, res) => {
  const userId = req.session.userId;
  const { tenantId } = req.body;
  
  // Verify user has access to this tenant
  const membership = db.prepare("SELECT 1 FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?").get(tenantId, userId);
  if (!membership) {
    return res.status(403).json({ error: 'Access denied to this project' });
  }
  
  req.session.tenantId = tenantId;
  res.json({ ok: true, tenantId });
});

// ==================== SCRAPING & AI ANALYSIS ENDPOINTS ====================

// Trigger scraping for a partner's URLs
app.post('/api/admin/partners/:id/scrape', requireAuth('admin'), async (req, res) => {
  try {
    const partnerId = req.params.id;
    const tenantId = req.session.tenantId;
    
    // Verify partner belongs to this tenant
    const partner = db.prepare("SELECT * FROM partners WHERE id = ? AND tenant_id = ?").get(partnerId, tenantId);
    if (!partner) {
      return res.status(404).json({ error: 'Partner not found in this project' });
    }
    
    // Scrape using simple scraper
    const result = await scrapePartner(partnerId, tenantId);
    
    res.json({ 
      ok: true, 
      results: result.urls, 
      message: `Scraping completed: ${result.scraped}/${result.urls.length} URLs scraped`
    });
    
  } catch (err) {
    console.error('Scraping error:', err);
    res.status(500).json({ error: 'Failed to scrape: ' + err.message });
  }
});

// Get scraped content for a partner
app.get('/api/admin/partners/:id/scraped', requireAuth('admin'), (req, res) => {
  const partnerId = req.params.id;
  const tenantId = req.session.tenantId;
  
  // Verify partner belongs to this tenant
  const partner = db.prepare("SELECT 1 FROM partners WHERE id = ? AND tenant_id = ?").get(partnerId, tenantId);
  if (!partner) {
    return res.status(404).json({ error: 'Partner not found' });
  }
  
  const content = getScrapedContent(partnerId);
  res.json(content);
});

// Trigger AI analysis for a partner
app.post('/api/admin/partners/:id/analyze', requireAuth('admin'), (req, res) => {
  const partnerId = req.params.id;
  const tenantId = req.session.tenantId;
  
  // Verify partner belongs to this tenant
  const partner = db.prepare("SELECT * FROM partners WHERE id = ? AND tenant_id = ?").get(partnerId, tenantId);
  if (!partner) {
    return res.status(404).json({ error: 'Partner not found in this project' });
  }
  
  // Check if scraped content exists
  const scraped = db.prepare("SELECT 1 FROM scraped_content WHERE partner_id = ? AND status = 'completed' LIMIT 1").get(partnerId);
  if (!scraped) {
    return res.status(400).json({ error: 'No scraped content available. Please scrape URLs first.' });
  }
  
  // Queue analysis jobs
  const result = analyzePartner(partnerId, tenantId);
  
  res.json({ 
    ok: true, 
    message: `Analysis queued for ${result.queued} items`,
    queued: result
  });
});

// Get AI analysis results for a partner
app.get('/api/admin/partners/:id/analysis', requireAuth('admin'), (req, res) => {
  const partnerId = req.params.id;
  const tenantId = req.session.tenantId;
  
  // Verify partner belongs to this tenant
  const partner = db.prepare("SELECT 1 FROM partners WHERE id = ? AND tenant_id = ?").get(partnerId, tenantId);
  if (!partner) {
    return res.status(404).json({ error: 'Partner not found' });
  }
  
  const analyses = getPartnerAnalysis(partnerId, tenantId);
  res.json(analyses);
});

// Get analysis status for all partners (summary)
app.get('/api/admin/analysis-status', requireAuth('admin'), (req, res) => {
  const tenantId = req.session.tenantId;
  
  const status = db.prepare(`
    SELECT 
      p.id as partner_id,
      p.name as partner_name,
      COUNT(DISTINCT sc.id) as urls_scraped,
      COUNT(DISTINCT CASE WHEN sc.status = 'completed' THEN sc.id END) as urls_completed,
      COUNT(DISTINCT paa.id) as analyses_count,
      MAX(paa.analyzed_at) as last_analysis
    FROM partners p
    LEFT JOIN scraped_content sc ON p.id = sc.partner_id AND sc.tenant_id = ?
    LEFT JOIN partner_ai_analysis paa ON p.id = paa.partner_id AND paa.tenant_id = ?
    WHERE p.tenant_id = ?
    GROUP BY p.id
  `).all(tenantId, tenantId, tenantId);
  
  res.json(status);
});

// ==================== END SCRAPING & AI ANALYSIS ====================

// Send invitation email to partner
app.post('/api/admin/partners/:id/send-invitation', requireAuth('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    const { username, password } = req.body;
    
    // Get partner details
    const partner = db.prepare("SELECT name, contact_name, contact_email FROM partners WHERE id = ?").get(id);
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    if (!partner.contact_email) return res.status(400).json({ error: 'Partner has no contact email' });
    
    // Get admin user details for sender name
    const adminUser = db.prepare("SELECT username, email FROM users WHERE id = ?").get(req.session.userId);
    const senderName = adminUser?.username || 'Admin';
    
    const loginUrl = `${req.protocol}://${req.get('host')}/login.html`;
    const emailSubject = `You've been invited to ${partner.name}'s Budget Project`;
    
    // HTML email template
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Invitation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #1f4e79 0%, #2e75b6 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
    .credentials { background: white; padding: 20px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #2e75b6; }
    .credentials p { margin: 8px 0; }
    .credentials strong { color: #1f4e79; }
    .button { display: inline-block; background: #2e75b6; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 14px; color: #6b7280; }
    .sender { font-weight: 600; color: #1f4e79; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Alloc8 Budget Calculator</h1>
  </div>
  <div class="content">
    <p>Dear ${partner.contact_name || partner.name},</p>
    
    <p><span class="sender">${senderName}</span> has invited you to access the budget management system for <strong>${partner.name}</strong>.</p>
    
    <div class="credentials">
      <p><strong>Your Login Credentials:</strong></p>
      <p><strong>Username:</strong> ${username}</p>
      <p><strong>Password:</strong> ${password}</p>
    </div>
    
    <p>Click the button below to access your account:</p>
    
    <a href="${loginUrl}" class="button">Access Your Account</a>
    
    <p style="font-size: 14px; color: #6b7280;">Or copy this link: ${loginUrl}</p>
    
    <div class="footer">
      <p><strong>Security Notice:</strong> Please change your password after your first login for security reasons.</p>
      <p style="margin-top: 15px;">Best regards,<br><span class="sender">${senderName}</span> via Alloc8</p>
    </div>
  </div>
</body>
</html>`;

    // Send email via Resend
    const { data, error } = await resend.emails.send({
      from: `${senderName} via Alloc8 <${FROM_EMAIL}>`,
      to: partner.contact_email,
      subject: emailSubject,
      html: emailHtml
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email: ' + error.message });
    }

    console.log(`Invitation email sent to ${partner.contact_email} for partner ${partner.name} (Email ID: ${data?.id})`);
    res.json({ ok: true, message: 'Invitation email sent successfully', emailId: data?.id });
    
  } catch (err) {
    console.error('Error sending invitation:', err);
    res.status(500).json({ error: 'Failed to send invitation: ' + err.message });
  }
});

app.post('/api/partner/analyze-skills', requireAuth('partner'), async (req, res) => {
  try {
    const result = await analyzePartnerSkills(req.session.partnerId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Global re-analysis queue for admin
let reanalyzeState = { running: false, queue: [], completed: 0, total: 0, errors: [], stage: 'idle' };

async function processReanalyzeQueue(tenantId) {
  if (reanalyzeState.running) return;
  reanalyzeState.running = true;
  reanalyzeState.completed = 0;
  reanalyzeState.errors = [];
  
  // Stage 1: Scrape all URLs
  reanalyzeState.stage = 'scraping';
  console.log(`[Re-analyze] Starting scraping for ${reanalyzeState.queue.length} partners...`);
  
  for (const partnerId of reanalyzeState.queue) {
    try {
      await scrapePartner(partnerId, tenantId);
    } catch (err) {
      reanalyzeState.errors.push({ partnerId, stage: 'scraping', error: err.message });
    }
  }
  
  // Stage 2: AI Analysis
  reanalyzeState.stage = 'analyzing';
  console.log(`[Re-analyze] Starting AI analysis for ${reanalyzeState.queue.length} partners...`);
  
  for (const partnerId of reanalyzeState.queue) {
    try {
      // Check if scraped content exists
      const hasContent = db.prepare(
        "SELECT 1 FROM scraped_content WHERE partner_id = ? AND status = 'completed' LIMIT 1"
      ).get(partnerId);
      
      if (hasContent) {
        analyzePartner(partnerId, tenantId);
        reanalyzeState.completed++;
      } else {
        reanalyzeState.errors.push({ partnerId, stage: 'analysis', error: 'No scraped content available' });
      }
    } catch (err) {
      reanalyzeState.errors.push({ partnerId, stage: 'analysis', error: err.message });
    }
    
    // Delay between partners for rate limiting
    if (reanalyzeState.queue.indexOf(partnerId) < reanalyzeState.queue.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  reanalyzeState.stage = 'completed';
  reanalyzeState.running = false;
  console.log('[Re-analyze] Completed!');
}

app.post('/api/admin/reanalyze-all', requireAuth('admin'), (req, res) => {
  if (reanalyzeState.running) {
    return res.status(409).json({ error: 'Re-analysis already in progress', total: reanalyzeState.total, completed: reanalyzeState.completed, stage: reanalyzeState.stage });
  }
  
  const tenantId = req.session.tenantId;
  
  // Get partners with URLs in this tenant
  const partners = db.prepare(`
    SELECT DISTINCT p.id 
    FROM partners p 
    JOIN partner_urls u ON u.partner_id = p.id 
    WHERE p.tenant_id = ?
    ORDER BY p.id
  `).all(tenantId);
  
  reanalyzeState.queue = partners.map(p => p.id);
  reanalyzeState.total = reanalyzeState.queue.length;
  reanalyzeState.completed = 0;
  reanalyzeState.errors = [];
  reanalyzeState.stage = 'starting';
  
  processReanalyzeQueue(tenantId);
  
  res.json({ started: true, total: reanalyzeState.total, message: 'Scraping and AI analysis started' });
});

app.get('/api/admin/reanalyze-status', requireAuth('admin'), (req, res) => {
  res.json({
    running: reanalyzeState.running,
    total: reanalyzeState.total,
    completed: reanalyzeState.completed,
    remaining: reanalyzeState.queue.length,
    stage: reanalyzeState.stage,
    errors: reanalyzeState.errors
  });
});

// WP management
app.get('/api/admin/wps', requireAuth('admin'), (req, res) => {
  res.json(getWpsWithTasks(req.session.tenantId));
});

app.post('/api/admin/wps', requireAuth('admin'), (req, res) => {
  const tenantId = req.session.tenantId;
  const { name, start_month, end_month } = req.body;
  const maxQuery = tenantId
    ? "SELECT COALESCE(MAX(sort_order), -1) as m FROM wps WHERE tenant_id = ?"
    : "SELECT COALESCE(MAX(sort_order), -1) as m FROM wps";
  const max = tenantId
    ? db.prepare(maxQuery).get(tenantId).m
    : db.prepare(maxQuery).get().m;
  const info = db.prepare("INSERT INTO wps (name, sort_order, tenant_id, start_month, end_month) VALUES (?, ?, ?, ?, ?)").run(name, max + 1, tenantId || null, start_month || 1, end_month || 48);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/wps/:id', requireAuth('admin'), (req, res) => {
  const wpId = req.params.id;
  const tasks = db.prepare("SELECT id FROM tasks WHERE wp_id = ?").all(wpId);
  tasks.forEach(t => removeTaskFromPartners(t.id));
  db.prepare("DELETE FROM tasks WHERE wp_id = ?").run(wpId);
  const wp = db.prepare("SELECT sort_order FROM wps WHERE id = ?").get(wpId);
  if (wp) {
    db.prepare("DELETE FROM wps WHERE id = ?").run(wpId);
    db.prepare("UPDATE wps SET sort_order = sort_order - 1 WHERE sort_order > ?").run(wp.sort_order);
  }
  res.json({ ok: true });
});

app.put('/api/admin/wps/:id', requireAuth('admin'), (req, res) => {
  const { name, start_month, end_month } = req.body;
  const sets = [], params = [];
  if (name !== undefined)        { sets.push('name = ?');        params.push(name); }
  if (start_month !== undefined) { sets.push('start_month = ?'); params.push(start_month); }
  if (end_month !== undefined)   { sets.push('end_month = ?');   params.push(end_month); }
  if (sets.length) { params.push(req.params.id); db.prepare(`UPDATE wps SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ ok: true });
});

app.put('/api/admin/wps/:id/assignments', requireAuth('admin'), (req, res) => {
  const wpId = req.params.id;
  const ids = (req.body.assigned_partner_ids || []).filter(id => Number.isFinite(id));
  db.prepare("DELETE FROM wp_assignments WHERE wp_id = ?").run(wpId);
  const insert = db.prepare("INSERT INTO wp_assignments (wp_id, partner_id) VALUES (?, ?)");
  ids.forEach(pid => insert.run(wpId, pid));
  res.json({ ok: true });
});

app.post('/api/admin/wps/reorder', requireAuth('admin'), (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
  const update = db.prepare("UPDATE wps SET sort_order = ? WHERE id = ?");
  order.forEach((id, i) => update.run(i, id));
  res.json({ ok: true });
});

// Task management
app.post('/api/admin/wps/:wpId/tasks', requireAuth('admin'), (req, res) => {
  const wpId = req.params.wpId;
  const { name, start_month, end_month } = req.body;
  const max = db.prepare("SELECT COALESCE(MAX(sort_order), -1) as m FROM tasks WHERE wp_id = ?").get(wpId).m;
  const wp = db.prepare("SELECT start_month, end_month FROM wps WHERE id = ?").get(wpId);
  const sMonth = start_month || (wp ? wp.start_month : 1) || 1;
  const eMonth = end_month   || (wp ? wp.end_month   : 48) || 48;
  const info = db.prepare("INSERT INTO tasks (wp_id, name, sort_order, start_month, end_month) VALUES (?, ?, ?, ?, ?)").run(wpId, name, max + 1, sMonth, eMonth);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/tasks/:id', requireAuth('admin'), (req, res) => {
  const taskId = req.params.id;
  removeTaskFromPartners(taskId);
  const t = db.prepare("SELECT wp_id, sort_order FROM tasks WHERE id = ?").get(taskId);
  if (t) {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("UPDATE tasks SET sort_order = sort_order - 1 WHERE wp_id = ? AND sort_order > ?").run(t.wp_id, t.sort_order);
  }
  res.json({ ok: true });
});

app.put('/api/admin/tasks/:id', requireAuth('admin'), (req, res) => {
  const { name, start_month, end_month } = req.body;
  const sets = [], params = [];
  if (name !== undefined)        { sets.push('name = ?');        params.push(name); }
  if (start_month !== undefined) { sets.push('start_month = ?'); params.push(start_month); }
  if (end_month !== undefined)   { sets.push('end_month = ?');   params.push(end_month); }
  if (sets.length) { params.push(req.params.id); db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
  res.json({ ok: true });
});

app.put('/api/admin/tasks/:id/assignments', requireAuth('admin'), (req, res) => {
  const taskId = req.params.id;
  const ids = (req.body.assigned_partner_ids || []).filter(id => Number.isFinite(id));
  db.prepare("DELETE FROM task_assignments WHERE task_id = ?").run(taskId);
  const insert = db.prepare("INSERT INTO task_assignments (task_id, partner_id) VALUES (?, ?)");
  ids.forEach(pid => insert.run(taskId, pid));
  res.json({ ok: true });
});

app.post('/api/admin/tasks/reorder', requireAuth('admin'), (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });
  const update = db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ?");
  order.forEach((id, i) => update.run(i, id));
  res.json({ ok: true });
});

// Database Management API (Primary Admin Only)
const ALLOWED_TABLES = ['partners', 'wps', 'tasks', 'users', 'tenants', 'tenant_memberships', 'wp_assignments', 'task_assignments', 'scraped_content', 'partner_ai_analysis', 'partner_urls', 'partner_wp_skills', 'settings'];

// List all data from a table
app.get('/api/admin/db/:table', requireAuth('admin'), (req, res) => {
  const table = req.params.table;
  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(403).json({ error: 'Table not allowed' });
  }
  try {
    const data = db.prepare(`SELECT * FROM ${table} LIMIT 1000`).all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific row
app.delete('/api/admin/db/:table/:id', requireAuth('admin'), (req, res) => {
  const table = req.params.table;
  const id = req.params.id;
  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(403).json({ error: 'Table not allowed' });
  }
  try {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all rows from a table (DANGER!)
app.delete('/api/admin/db/:table', requireAuth('admin'), (req, res) => {
  const table = req.params.table;
  if (!ALLOWED_TABLES.includes(table)) {
    return res.status(403).json({ error: 'Table not allowed' });
  }
  // Prevent deleting critical tables entirely
  if (['users', 'tenants'].includes(table)) {
    return res.status(403).json({ error: 'Cannot delete all from this table. Delete individual rows instead.' });
  }
  try {
    db.prepare(`DELETE FROM ${table}`).run();
    res.json({ ok: true, message: `All rows deleted from ${table}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Export budget as Excel
app.get('/api/admin/export-excel', requireAuth('admin'), (req, res) => {
  try {
    const { generateBudgetExcel } = require('./excel-export');
    const tenantId = req.session.tenantId;
    const buffer = generateBudgetExcel(db, tenantId);
    res.setHeader('Content-Disposition', 'attachment; filename="Alloc8_Budget.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ error: 'Failed to generate Excel: ' + err.message });
  }
});

// Redirect root
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin login: admin / admin`);
});
