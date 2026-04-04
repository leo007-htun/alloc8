# Budget Calculator - Alloc8 Docker Image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies for better-sqlite3 (requires python and build tools)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Create directories for volumes
RUN mkdir -p /app/data /app/public/uploads

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/data.sqlite

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
