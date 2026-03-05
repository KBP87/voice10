FROM node:20-bullseye

WORKDIR /app

# Needed for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

# Tell Google where the key file is
ENV GOOGLE_APPLICATION_CREDENTIALS=/app/keys/google_key.json

ENV PORT=8080

EXPOSE 8080

CMD ["node","server.js"]