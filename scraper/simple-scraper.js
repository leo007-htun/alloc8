/**
 * Simple URL scraper using Node.js fetch
 * No Scrapy dependencies - just uses native fetch
 */

const { db } = require('../database');

// Simple text extraction from HTML
function extractText(html) {
  // Remove scripts and styles
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');
  
  // Extract text from content areas
  const contentMatch = text.match(/<main[\s\S]*?<\/main>/i) ||
                       text.match(/<article[\s\S]*?<\/article>/i) ||
                       text.match(/<div[^>]*class="[^"]*(?:content|main)[^"]*"[\s\S]*?<\/div>/i);
  
  if (contentMatch) {
    text = contentMatch[0];
  }
  
  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  // Remove common nav/footer words
  const navWords = ['home', 'about us', 'contact', 'menu', 'login', 'sign up', 
                    'privacy policy', 'terms', 'cookie', 'facebook', 'twitter', 
                    'linkedin', 'instagram', 'youtube'];
  
  // Extract meaningful content (first 8000 chars ~ 2000 tokens)
  return text.substring(0, 8000);
}

// Extract title and meta description
function extractMetadata(html) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i) ||
                   html.match(/<meta[^>]*content="([^"]*)"[^>]*name="description"/i);
  
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : ''
  };
}

/**
 * Scrape a single URL
 */
async function scrapeUrl(url, partnerId, urlId, tenantId) {
  try {
    // Validate URL
    let validatedUrl;
    try {
      validatedUrl = new URL(url).toString();
    } catch (e) {
      throw new Error(`Invalid URL: ${url}`);
    }
    
    // Check if already exists
    const existing = db.prepare('SELECT id FROM scraped_content WHERE partner_id = ? AND url = ?').get(partnerId, validatedUrl);
    
    if (existing) {
      // Update existing
      db.prepare(`UPDATE scraped_content SET status = 'scraping', scraped_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
    } else {
      // Insert new
      db.prepare(`
        INSERT INTO scraped_content (partner_id, url_id, url, status, tenant_id)
        VALUES (?, ?, ?, 'scraping', ?)
      `).run(partnerId, urlId, validatedUrl, tenantId);
    }
    
    // Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    const response = await fetch(validatedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const metadata = extractMetadata(html);
    const content = extractText(html);
    
    const fullContent = `Title: ${metadata.title}\n\nDescription: ${metadata.description}\n\nContent: ${content}`;
    
    // Save to database
    db.prepare(`
      UPDATE scraped_content 
      SET content = ?, scraped_at = CURRENT_TIMESTAMP, status = 'completed', error_message = NULL
      WHERE partner_id = ? AND url = ?
    `).run(fullContent, partnerId, validatedUrl);
    
    console.log(`[OK] Scraped: ${validatedUrl} (${content.length} chars)`);
    return { success: true, url: validatedUrl, length: content.length };
    
  } catch (error) {
    // Save error
    const existing = db.prepare('SELECT id FROM scraped_content WHERE partner_id = ? AND url = ?').get(partnerId, url);
    if (existing) {
      db.prepare(`UPDATE scraped_content SET status = 'error', error_message = ?, scraped_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(error.message, existing.id);
    } else {
      db.prepare(`
        INSERT INTO scraped_content (partner_id, url_id, url, status, error_message, scraped_at, tenant_id)
        VALUES (?, ?, ?, 'error', ?, CURRENT_TIMESTAMP, ?)
      `).run(partnerId, urlId || null, url, error.message, tenantId);
    }
    
    console.error(`[FAIL] Failed to scrape ${url}: ${error.message}`);
    return { success: false, url, error: error.message };
  }
}

/**
 * Scrape all URLs for a partner
 */
async function scrapePartner(partnerId, tenantId) {
  const urls = db.prepare('SELECT * FROM partner_urls WHERE partner_id = ?').all(partnerId);
  
  if (urls.length === 0) {
    console.log(`No URLs for partner ${partnerId}`);
    return { scraped: 0, urls: [] };
  }
  
  console.log(`Scraping ${urls.length} URL(s) for partner ${partnerId}...`);
  
  const results = [];
  for (const urlData of urls) {
    const result = await scrapeUrl(urlData.url, partnerId, urlData.id, tenantId);
    results.push(result);
    // Small delay between requests
    await new Promise(r => setTimeout(r, 1000));
  }
  
  const successCount = results.filter(r => r.success).length;
  console.log(`Completed: ${successCount}/${urls.length} URLs scraped`);
  
  return { scraped: successCount, urls: results };
}

/**
 * Scrape all partners in a tenant
 */
async function scrapeAllPartners(tenantId) {
  const partners = db.prepare('SELECT id, name FROM partners WHERE tenant_id = ?').all(tenantId);
  
  console.log(`\n=== Scraping ${partners.length} partners in tenant ${tenantId} ===\n`);
  
  const results = [];
  for (const partner of partners) {
    console.log(`\n--- Partner: ${partner.name} (ID: ${partner.id}) ---`);
    const result = await scrapePartner(partner.id, tenantId);
    results.push({ partnerId: partner.id, partnerName: partner.name, ...result });
  }
  
  return results;
}

module.exports = { scrapeUrl, scrapePartner, scrapeAllPartners };
