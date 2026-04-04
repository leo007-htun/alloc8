# Upload to Docker Hub Guide

## Step 1: Install Docker Desktop
- Download: https://www.docker.com/products/docker-desktop
- Install and start Docker Desktop

## Step 2: Create Docker Hub Account
1. Go to https://hub.docker.com
2. Click "Sign Up" and create account
3. Verify email

## Step 3: Create Repository
1. Login to Docker Hub
2. Click "Create Repository"
3. Name: `alloc8-budget-calculator`
4. Description: `Budget Calculator for EU Projects`
5. Visibility: Public (or Private)
6. Click "Create"

## Step 4: Build and Push (Command Line)

Open terminal in project folder and run:

```bash
# 1. Login to Docker Hub
docker login
# Enter your Docker Hub username and password

# 2. Build the image
docker build -t alloc8-budget-calculator .

# 3. Tag with your username (replace YOUR_USERNAME)
docker tag alloc8-budget-calculator YOUR_USERNAME/alloc8-budget-calculator:latest

# 4. Push to Docker Hub
docker push YOUR_USERNAME/alloc8-budget-calculator:latest
```

## Step 5: Verify Upload
1. Go to https://hub.docker.com/repositories
2. You should see your image

## Using the Image

### Pull and Run:
```bash
# Pull from Docker Hub
docker pull YOUR_USERNAME/alloc8-budget-calculator:latest

# Run
docker run -p 3000:3000 YOUR_USERNAME/alloc8-budget-calculator:latest
```

### Docker Compose:
```yaml
version: '3.8'
services:
  app:
    image: YOUR_USERNAME/alloc8-budget-calculator:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./uploads:/app/public/uploads
    environment:
      - DB_PATH=/app/data/data.sqlite
```

## Automate with GitHub Actions

Create `.github/workflows/docker.yml`:

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    
    - name: Login to Docker Hub
      uses: docker/login-action@v2
      with:
        username: ${{ secrets.DOCKER_USERNAME }}
        password: ${{ secrets.DOCKER_PASSWORD }}
    
    - name: Build and push
      uses: docker/build-push-action@v4
      with:
        push: true
        tags: YOUR_USERNAME/alloc8-budget-calculator:latest
```

Add secrets in GitHub:
- `DOCKER_USERNAME`: Your Docker Hub username
- `DOCKER_PASSWORD`: Your Docker Hub password/token
