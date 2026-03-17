"use strict";

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const textToSpeech = require("@google-cloud/text-to-speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = String(process.env.JWT_SECRET || "change-me-now").trim();

const APP_BASE_URL = String(
  process.env.APP_BASE_URL || "https://voicepunjabai.com"
).trim();

const API_PUBLIC_BASE_URL = String(
  process.env.API_PUBLIC_BASE_URL ||
    "https://voicepunjab-api-777821135954.us-central1.run.app"
).trim();

const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").trim() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const SMTP_FROM = String(
  process.env.SMTP_FROM || "VoicePunjabAI <support@voicepunjabai.com>"
).trim();

const GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_PROJECT_ID ||
  "";

const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

const GOOGLE_CREDENTIALS_JSON =
  process.env.GOOGLE_CREDENTIALS_JSON || "";

const DB_USER = String(process.env.DB_USER || "").trim();
const DB_PASS = String(process.env.DB_PASS || "").trim();
const DB_NAME = String(process.env.DB_NAME || "").trim();
const INSTANCE_CONNECTION_NAME = String(
  process.env.INSTANCE_CONNECTION_NAME || ""
).trim();
const DB_HOST = String(process.env.DB_HOST || "").trim();
const DB_PORT = Number(process.env.DB_PORT || 5432);

let dbReady = false;

const clientConfig = {
  projectId: GOOGLE_CLOUD_PROJECT
};

if (GOOGLE_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    if (creds.private_key) {
      creds.private_key = creds.private_key.replace(/\\n/g, "\n");
    }
    clientConfig.credentials = creds;
  } catch (err) {
    console.error("Failed to parse GOOGLE_CREDENTIALS_JSON:", err.message);
  }
} else if (GOOGLE_APPLICATION_CREDENTIALS) {
  clientConfig.keyFilename = GOOGLE_APPLICATION_CREDENTIALS;
}

const ttsClient = new textToSpeech.TextToSpeechClient(clientConfig);
const translateClient = new TranslationServiceClient(clientConfig);

const ALLOWED_ORIGIN_RAW = (
  process.env.ALLOWED_ORIGIN ||
  "https://voicepunjabai.com,https://www.voicepunjabai.com,http://localhost:8080,http://127.0.0.1:8080"
).trim();

const ALLOWED_ORIGINS =
  ALLOWED_ORIGIN_RAW === "*"
    ? "*"
    : ALLOWED_ORIGIN_RAW.split(",").map((s) => s.trim()).filter(Boolean);

const ALLOWED_VOICES = ["pa-IN-Standard-A", "pa-IN-Standard-B"];
const MAX_TTS_TEXT_LENGTH = 1000;
const MAX_CONVERT_TEXT_LENGTH = 500;
const MIN_SPEED = 0.75;
const MAX_SPEED = 1.25;
const MIN_PITCH = -5;
const MAX_PITCH = 5;

const CACHE_DIR = path.join(__dirname, "cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getPoolConfig() {
  const baseConfig = {
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };

  if (INSTANCE_CONNECTION_NAME) {
    return {
      ...baseConfig,
      host: `/cloudsql/${INSTANCE_CONNECTION_NAME}`,
      port: 5432
    };
  }

  return {
    ...baseConfig,
    host: DB_HOST || "127.0.0.1",
    port: DB_PORT
  };
}

const pool = new Pool(getPoolConfig());

let mailer = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

async function dbGet(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function dbAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function dbRun(sql, params = []) {
  return pool.query(sql, params);
}

async function initDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS translation_cache (
      id SERIAL PRIMARY KEY,
      source_text TEXT NOT NULL UNIQUE,
      translated_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS tts_cache (
      id SERIAL PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      text TEXT NOT NULL,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      pitch REAL NOT NULL,
      file_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL,
      cache_status TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS audio_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_text TEXT NOT NULL,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      pitch REAL NOT NULL,
      audio_url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.get("/", (req, res) => {
  res.send("VoicePunjab API started");
});

app.get("/health", async (req, res) => {
  if (!dbReady) {
    return res.status(503).send("server up, db not ready");
  }

  try {
    await dbGet("SELECT 1 AS ok");
    res.send("ok");
  } catch (err) {
    console.error("health error:", err.message);
    res.status(500).send("db not ready");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VoicePunjab API running on port ${PORT}`);
  console.log("INSTANCE_CONNECTION_NAME =", INSTANCE_CONNECTION_NAME || "(missing)");
  console.log("DB_HOST =", DB_HOST || "(not set)");
  console.log("DB_NAME =", DB_NAME || "(missing)");
  console.log("DB_USER =", DB_USER || "(missing)");

  (async () => {
    try {
      await pool.query("SELECT 1");
      console.log("Database connection successful.");
      await initDatabase();
      dbReady = true;
      console.log("Database initialized successfully.");
    } catch (err) {
      console.error("Database background init failed:", err);
    }
  })();
});