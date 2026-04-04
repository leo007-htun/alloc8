const db = require('better-sqlite3')('data.sqlite');
const seed = require('./seed.json');

const wp8 = db.prepare("SELECT id FROM wps WHERE name LIKE 'WP8%'").get();
if (wp8) { console.log('WP8 already exists'); process.exit(0); }

const insertWp = db.prepare('INSERT INTO wps (name, sort_order) VALUES (?, ?)');
const insertTask = db.prepare('INSERT INTO tasks (wp_id, name, sort_order) VALUES (?, ?, ?)');
const updatePartner = db.prepare('UPDATE partners SET wp_data = ? WHERE id = ?');

const wp = seed.wps[7];
const wpInfo = insertWp.run(wp.name, 7);
const wpId = wpInfo.lastInsertRowid;

wp.tasks.forEach((t, i) => insertTask.run(wpId, t.name, i));

const newTasks = db.prepare('SELECT id FROM tasks WHERE wp_id = ? ORDER BY sort_order').all(wpId);
const newTaskIds = newTasks.map(t => t.id);

const partners = db.prepare('SELECT id, wp_data FROM partners ORDER BY id').all();
partners.forEach((p, pIdx) => {
  const data = JSON.parse(p.wp_data || '{}');
  const baseIdx = 34;
  newTaskIds.forEach((tid, i) => {
    const seedIdx = baseIdx + i;
    const val = seed.partners[pIdx].wp_data[String(seedIdx)];
    if (val !== undefined) data[tid] = val;
  });
  updatePartner.run(JSON.stringify(data), p.id);
});

console.log('WP8 inserted with', newTaskIds.length, 'tasks');
