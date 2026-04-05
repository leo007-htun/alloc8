FROM node:20-slim

WORKDIR /app

# Build tools for native modules
RUN apt-get update -qq && apt-get install -y -qq python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .
RUN mkdir -p /app/data /app/public/uploads

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/data.sqlite

EXPOSE 3000
CMD ["npm", "start"]
