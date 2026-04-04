#!/bin/sh

# Create data directory if it doesn't exist
mkdir -p /app/data

# Create uploads directory if it doesn't exist
mkdir -p /app/public/uploads

# Initialize database if it doesn't exist
if [ ! -f /app/data/data.sqlite ]; then
    echo "Initializing new database..."
    touch /app/data/data.sqlite
fi

# Start the server
exec npm start
