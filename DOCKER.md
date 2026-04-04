# Docker Setup for Alloc8 Budget Calculator

## Quick Start

### 1. Using Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

### 2. Using Docker Directly

```bash
# Build the image
docker build -t alloc8-budget-calculator .

# Run the container
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/uploads:/app/public/uploads \
  -e DB_PATH=/app/data/data.sqlite \
  --name alloc8 \
  alloc8-budget-calculator
```

## Environment Variables

Create a `.env` file in the project root:

```env
# Email Configuration (Resend)
RESEND_API_KEY=your_resend_api_key
FROM_EMAIL=noreply@yourdomain.com

# AI Analysis (Bytez)
BYTEZ_API_KEY=your_bytez_api_key

# Session Secret (generate a random string)
SESSION_SECRET=your-random-secret-key
```

## Data Persistence

The following directories are persisted as Docker volumes:

- `./data/` - SQLite database
- `./uploads/` - Partner logo uploads

## Accessing the Application

Once running, access the application at:
- **Local:** http://localhost:3000
- **Default Login:** admin / admin

## Useful Commands

```bash
# View container logs
docker-compose logs -f app

# Restart container
docker-compose restart

# Rebuild after code changes
docker-compose up -d --build

# Shell into container
docker exec -it alloc8-budget-calculator sh

# Backup database
docker cp alloc8-budget-calculator:/app/data/data.sqlite ./backup-$(date +%Y%m%d).sqlite
```

## Production Deployment

1. **Set strong secrets** in `.env`:
   ```env
   SESSION_SECRET=your-256-bit-random-string
   ```

2. **Use a reverse proxy** (nginx/traefik) for SSL

3. **Set up regular backups**:
   ```bash
   # Add to crontab
   0 2 * * * docker cp alloc8-budget-calculator:/app/data/data.sqlite /backups/alloc8-$(date +\%Y\%m\%d).sqlite
   ```

## Troubleshooting

### Database Permission Issues
```bash
# Fix permissions
sudo chown -R $USER:$USER ./data ./uploads
```

### Container Won't Start
```bash
# Check logs
docker-compose logs app

# Remove and recreate
docker-compose down -v
docker-compose up -d
```

### Rebuild from Scratch
```bash
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```
