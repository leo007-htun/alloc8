'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { db } = require('../database');

const SCRIPT = path.join(__dirname, 'trafilatura_scraper.py');
const TIMEOUT_MS = 30000; // 30 s per URL

/**
 * Fetch a URL with Trafilatura (Python) and return the clean text.
 */
function fetchWithTrafilatura(url) {
  return new Promise((resolve, reject) => {
    execFile('python3', [SCRIPT, url], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || 'trafilatura failed').trim()));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Scrape a single URL and persist result to scraped_content.
 */
async function scrapeUrl(url, partnerId, urlId, tenantId) {
  let validatedUrl;
  try {
    validatedUrl = new URL(url).toString();
  } catch (e) {
    return { success: false, url, error: `Invalid URL: ${url}` };
  }

  // Upsert a 'scraping' row
  const existing = db.prepare(
    'SELECT id FROM scraped_content WHERE partner_id = ? AND url = ?'
  ).get(partnerId, validatedUrl);

  if (existing) {
    db.prepare(
      "UPDATE scraped_content SET status = 'scraping', scraped_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO scraped_content (partner_id, url_id, url, status, tenant_id) VALUES (?, ?, ?, 'scraping', ?)"
    ).run(partnerId, urlId, validatedUrl, tenantId);
  }

  try {
    const text = await fetchWithTrafilatura(validatedUrl);

    db.prepare(`
      UPDATE scraped_content
      SET content = ?, scraped_at = CURRENT_TIMESTAMP, status = 'completed', error_message = NULL
      WHERE partner_id = ? AND url = ?
    `).run(text, partnerId, validatedUrl);

    console.log(`[OK] Scraped (trafilatura): ${validatedUrl} (${text.length} chars)`);
    return { success: true, url: validatedUrl, length: text.length };

  } catch (error) {
    const row = db.prepare(
      'SELECT id FROM scraped_content WHERE partner_id = ? AND url = ?'
    ).get(partnerId, validatedUrl);

    if (row) {
      db.prepare(
        "UPDATE scraped_content SET status = 'error', error_message = ?, scraped_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(error.message, row.id);
    } else {
      db.prepare(`
        INSERT INTO scraped_content (partner_id, url_id, url, status, error_message, scraped_at, tenant_id)
        VALUES (?, ?, ?, 'error', ?, CURRENT_TIMESTAMP, ?)
      `).run(partnerId, urlId || null, validatedUrl, error.message, tenantId);
    }

    console.error(`[FAIL] ${validatedUrl}: ${error.message}`);
    return { success: false, url: validatedUrl, error: error.message };
  }
}

/**
 * Scrape all URLs for a partner.
 */
async function scrapePartner(partnerId, tenantId) {
  const urls = db.prepare('SELECT * FROM partner_urls WHERE partner_id = ?').all(partnerId);
  if (!urls.length) {
    console.log(`No URLs for partner ${partnerId}`);
    return { scraped: 0, urls: [] };
  }

  console.log(`Scraping ${urls.length} URL(s) for partner ${partnerId} via trafilatura...`);
  const results = [];
  for (const u of urls) {
    const result = await scrapeUrl(u.url, partnerId, u.id, tenantId);
    results.push(result);
    await new Promise(r => setTimeout(r, 500)); // small courtesy delay
  }

  const ok = results.filter(r => r.success).length;
  console.log(`Done: ${ok}/${urls.length} URLs scraped`);
  return { scraped: ok, urls: results };
}

/**
 * Scrape all partners in a tenant.
 */
async function scrapeAllPartners(tenantId) {
  const partners = db.prepare('SELECT id, name FROM partners WHERE tenant_id = ?').all(tenantId);
  console.log(`\n=== Scraping ${partners.length} partners in tenant ${tenantId} ===\n`);
  const results = [];
  for (const p of partners) {
    console.log(`\n--- ${p.name} (ID: ${p.id}) ---`);
    const result = await scrapePartner(p.id, tenantId);
    results.push({ partnerId: p.id, partnerName: p.name, ...result });
  }
  return results;
}

module.exports = { scrapeUrl, scrapePartner, scrapeAllPartners };
