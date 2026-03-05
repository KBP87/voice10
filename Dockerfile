FROM node:20-bullseye

WORKDIR /app

# Needed for better-sqlite3 native build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node","server.js"]