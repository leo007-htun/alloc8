# Deploy Alloc8 on IONOS with WordPress

## Option 1: Node.js + WordPress Together (Recommended)

### Step 1: Get IONOS Hosting
1. Buy **IONOS VPS** or **Dedicated Server** (needs Node.js support)
2. Or get **IONOS Web Hosting** + separate **Node.js hosting**

### Step 2: Deploy Node.js App

```bash
# SSH into your IONOS server
ssh root@your-server-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
npm install -g pm2

# Upload your project
cd /var/www
mkdir alloc8
cd alloc8
# Upload files via FTP or git clone

# Install dependencies
npm install

# Create data directory
mkdir -p data uploads

# Start with PM2
pm2 start server.js --name "alloc8"
pm2 save
pm2 startup
```

### Step 3: Configure Nginx (Reverse Proxy)

```nginx
# /etc/nginx/sites-available/alloc8
server {
    listen 80;
    server_name budget.alloc8.org;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Step 4: Embed in WordPress

Add to WordPress page using **Custom HTML block**:

```html
<iframe src="https://budget.alloc8.org" 
        width="100%" 
        height="800px" 
        style="border:none;">
</iframe>
```

Or use plugin: "Iframe Shortcode"

---

## Option 2: Full WordPress Rebuild (Complex)

This requires rebuilding everything as WordPress plugins:

### Required Plugins to Build:

| Feature | WordPress Implementation |
|---------|------------------------|
| Partners | Custom Post Type "Partners" |
| WPs/Tasks | Custom Post Types + ACF |
| Budget Calculator | Custom Plugin with PHP/MySQL |
| AI Analysis | PHP wrapper calling Bytez API |
| Scraping | PHP cron job with cURL |
| Charts | Chart.js in WP admin |
| Multi-tenant | WordPress Multisite |

### Database Migration:

```bash
# Export SQLite to MySQL
sqlite3 data.sqlite .dump > dump.sql
# Convert SQL syntax for MySQL
# Import to WordPress database
```

---

## Option 3: Headless WordPress (Modern)

Use WordPress as backend CMS, keep React frontend:

```
WordPress (IONOS) <-- REST API --> Your Node.js Frontend
         |                                    |
    MySQL Database                      Express + SQLite
```

### Pros:
- WordPress for content management
- Keep your existing UI
- Better SEO with WP

### Cons:
- Two systems to maintain
- Complex API integration

---

## Recommended: Option 1

Keep your Node.js app and embed it. Easiest and fastest.

### IONOS Specific Steps:

1. **Buy IONOS VPS**: https://www.ionos.com/servers/vps
2. **Choose**: Linux VPS with Ubuntu 22.04
3. **Connect via SSH**: Use PuTTY or terminal
4. **Follow deployment steps above**
5. **Point domain**: Set A record to VPS IP
6. **Install SSL**: Use Let's Encrypt

```bash
# Install SSL certificate
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d budget.alloc8.org
```

### WordPress Integration:

```php
// Add to WordPress theme's functions.php
function alloc8_shortcode() {
    return '<iframe src="https://budget.alloc8.org" width="100%" height="1000px" style="border:none;"></iframe>';
}
add_shortcode('alloc8', 'alloc8_shortcode');
```

Use shortcode in any page:
```
[alloc8]
```

---

## Summary

| Approach | Time | Cost | Difficulty |
|----------|------|------|------------|
| **Option 1: Embed** | 2-3 hours | $10-20/month | Easy |
| **Option 2: Rebuild** | 2-3 months | $10-20/month | Hard |
| **Option 3: Headless** | 1-2 weeks | $20-30/month | Medium |

**Recommendation**: Use Option 1 (Embed) for now. It's the fastest way to get working on IONOS.
