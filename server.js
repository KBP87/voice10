"use strict";

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const textToSpeech = require("@google-cloud/text-to-speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;

const app = express();

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

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

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

const DB_PATH = "/tmp/data.sqlite";
const CACHE_DIR = path.join(__dirname, "cache");
const DEMO_DIR = path.join(__dirname, "demo");

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "dispostable.com",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mohmal.com",
  "mintemail.com",
  "sharklasers.com",
  "tempmail.com",
  "temp-mail.org",
  "tempmail.dev",
  "tempmailo.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com"
]);

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

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

function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        is_verified INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_email_verification_user
      ON email_verification_tokens (user_id, expires_at)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_user
      ON password_reset_tokens (user_id, expires_at)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS translation_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_text TEXT NOT NULL UNIQUE,
        translated_text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS tts_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL,
        pitch REAL NOT NULL,
        file_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_logs_client_endpoint_date
      ON usage_logs (client_id, endpoint, created_at)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL,
        cache_status TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_endpoint_date
      ON request_logs (endpoint, created_at)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS audio_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        original_text TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL,
        pitch REAL NOT NULL,
        audio_url TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_audio_history_user_date
      ON audio_history (user_id, created_at DESC)
    `);
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function containsGurmukhi(text) {
  return /[\u0A00-\u0A7F]/.test(String(text || ""));
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const parts = raw.split("@");

  if (parts.length !== 2) return raw;

  let [local, domain] = parts;

  if (domain === "googlemail.com") {
    domain = "gmail.com";
  }

  if (domain === "gmail.com") {
    local = local.split("+")[0];
    local = local.replace(/\./g, "");
  }

  return `${local}@${domain}`;
}

function getEmailDomain(email) {
  const normalized = normalizeEmail(email);
  const parts = normalized.split("@");
  return parts.length === 2 ? parts[1] : "";
}

function isDisposableEmail(email) {
  const domain = getEmailDomain(email);
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

function normalizeEnglishForCache(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:]+$/g, "");
}

function normalizePunjabiForCache(text) {
  return normalizeWhitespace(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:]+$/g, "");
}

function isValidVoice(voice) {
  return ALLOWED_VOICES.includes(voice);
}

function isValidSpeed(speed) {
  return Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED;
}

function isValidPitch(pitch) {
  return Number.isFinite(pitch) && pitch >= MIN_PITCH && pitch <= MAX_PITCH;
}

function makeTtsCacheKey({ text, voice, speed, pitch }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ text, voice, speed, pitch }))
    .digest("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function createAuthToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      plan: user.plan,
      is_verified: !!user.is_verified
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    is_verified: !!user.is_verified
  };
}

function makeVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function createVerificationToken(userId) {
  const token = makeVerificationToken();

  await dbRun(
    `DELETE FROM email_verification_tokens WHERE user_id = ?`,
    [userId]
  );

  await dbRun(
    `
      INSERT INTO email_verification_tokens (user_id, token, expires_at)
      VALUES (?, ?, datetime('now', '+24 hours'))
    `,
    [userId, token]
  );

  return token;
}

async function sendVerificationEmail(user, token) {
  const verifyUrl = `${API_PUBLIC_BASE_URL}/api/verify-email?token=${encodeURIComponent(token)}`;

  if (!mailer) {
    console.log("Verification email not sent because SMTP is not configured.");
    console.log("Verification URL:", verifyUrl);
    return;
  }

  await mailer.sendMail({
    from: SMTP_FROM,
    to: user.email,
    subject: "Verify your VoicePunjabAI email",
    text: `Hello ${user.name},

Please verify your email by opening this link:
${verifyUrl}

This link expires in 24 hours.

VoicePunjabAI
${APP_BASE_URL}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Verify your VoicePunjabAI account</h2>
        <p>Hello ${user.name},</p>
        <p>Please verify your email address by clicking the button below:</p>
        <p>
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
            Verify Email
          </a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p>${verifyUrl}</p>
        <p>This link expires in 24 hours.</p>
        <p>VoicePunjabAI<br>${APP_BASE_URL}</p>
      </div>
    `
  });
}

async function createPasswordResetToken(userId) {
  const token = makeVerificationToken();

  await dbRun(
    `DELETE FROM password_reset_tokens WHERE user_id = ?`,
    [userId]
  );

  await dbRun(
    `
      INSERT INTO password_reset_tokens (user_id, token, expires_at)
      VALUES (?, ?, datetime('now', '+1 hour'))
    `,
    [userId, token]
  );

  return token;
}

async function sendPasswordResetEmail(user, token) {
  const resetUrl = `${APP_BASE_URL}/reset-password.html?token=${encodeURIComponent(token)}`;

  if (!mailer) {
    console.log("Password reset email not sent because SMTP is not configured.");
    console.log("Password reset URL:", resetUrl);
    return;
  }

  await mailer.sendMail({
    from: SMTP_FROM,
    to: user.email,
    subject: "Reset your VoicePunjabAI password",
    text: `Hello ${user.name},

We received a request to reset your VoicePunjabAI password.

Open this link to set a new password:
${resetUrl}

This link expires in 1 hour.

If you did not request this, you can ignore this email.

VoicePunjabAI
${APP_BASE_URL}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Reset your VoicePunjabAI password</h2>
        <p>Hello ${user.name},</p>
        <p>We received a request to reset your password.</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
            Reset Password
          </a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p>${resetUrl}</p>
        <p>This link expires in 1 hour.</p>
        <p>If you did not request this, you can ignore this email.</p>
        <p>VoicePunjabAI<br>${APP_BASE_URL}</p>
      </div>
    `
  });
}

async function loadUserFromToken(req, res, next) {
  try {
    const authHeader = String(req.headers.authorization || "").trim();

    if (!authHeader.startsWith("Bearer ")) {
      req.user = null;
      return next();
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await dbGet(
      `SELECT id, name, email, plan, is_verified FROM users WHERE id = ?`,
      [decoded.id]
    );

    req.user = user || null;
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Login required."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  const token =
    String(req.headers["x-admin-token"] || "").trim() ||
    String(req.query.token || "").trim();

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function getPlanLimits(plan) {
  switch (String(plan || "").toLowerCase()) {
    case "starter":
      return { translate: 5000, tts: 8000 };
    case "pro":
      return { translate: 20000, tts: 30000 };
    case "business":
      return { translate: 100000, tts: 150000 };
    case "free":
      return { translate: 1000, tts: 2000 };
    case "guest":
    default:
      return { translate: 300, tts: 500 };
  }
}

function getTrackingId(req) {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  return getClientIp(req);
}

async function getTodayUsage(clientId, endpoint) {
  const row = await dbGet(
    `
      SELECT COALESCE(SUM(char_count), 0) AS total
      FROM usage_logs
      WHERE client_id = ?
        AND endpoint = ?
        AND date(created_at) = date('now', 'localtime')
    `,
    [clientId, endpoint]
  );

  return Number(row?.total || 0);
}

async function logUsage(clientId, endpoint, charCount) {
  await dbRun(
    `
      INSERT INTO usage_logs (client_id, endpoint, char_count)
      VALUES (?, ?, ?)
    `,
    [clientId, endpoint, charCount]
  );
}

async function logRequest(endpoint, cacheStatus, charCount, clientId) {
  await dbRun(
    `
      INSERT INTO request_logs (endpoint, cache_status, char_count, client_id)
      VALUES (?, ?, ?, ?)
    `,
    [endpoint, cacheStatus, charCount, clientId]
  );
}

async function saveAudioHistory(userId, originalText, voice, speed, pitch, audioUrl) {
  await dbRun(
    `
      INSERT INTO audio_history (user_id, original_text, voice, speed, pitch, audio_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [userId, originalText, voice, speed, pitch, audioUrl]
  );
}

async function translateEnglishToPunjabi(text) {
  if (!GOOGLE_CLOUD_PROJECT) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT in environment variables");
  }

  const cacheText = normalizeEnglishForCache(text);

  const existing = await dbGet(
    `SELECT translated_text FROM translation_cache WHERE source_text = ?`,
    [cacheText]
  );

  if (existing) {
    return {
      translatedText: existing.translated_text,
      cached: true
    };
  }

  const request = {
    parent: `projects/${GOOGLE_CLOUD_PROJECT}/locations/global`,
    contents: [text],
    mimeType: "text/plain",
    sourceLanguageCode: "en",
    targetLanguageCode: "pa"
  };

  const [response] = await translateClient.translateText(request);
  const translatedText = response.translations?.[0]?.translatedText || text;

  await dbRun(
    `INSERT OR IGNORE INTO translation_cache (source_text, translated_text)
     VALUES (?, ?)`,
    [cacheText, translatedText]
  );

  return {
    translatedText,
    cached: false
  };
}

initDatabase();

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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-Token"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(loadUserFromToken);

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many signup attempts. Please try again later."
  }
});

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many verification requests. Please try again later."
  }
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many password reset requests. Please try again later."
  }
});

const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many TTS requests. Please wait a minute and try again."
  }
});

const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many conversion requests. Please wait a minute and try again."
  }
});

app.use("/api/signup", signupLimiter);
app.use("/api/resend-verification", resendLimiter);
app.use("/api/forgot-password", forgotPasswordLimiter);
app.use("/api/tts", ttsLimiter);
app.use("/api/convert", convertLimiter);

app.use("/cache", express.static(CACHE_DIR));
app.use("/demo", express.static(DEMO_DIR));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.send("ok");
});

/* AUTH ROUTES */

app.post("/api/signup", async (req, res) => {
  try {
    const name = normalizeText(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "Name, email, and password are required."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long."
      });
    }

    if (isDisposableEmail(email)) {
      return res.status(400).json({
        error: "Temporary or disposable email addresses are not allowed."
      });
    }

    const existing = await dbGet(
      `SELECT id FROM users WHERE email = ?`,
      [email]
    );

    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await dbRun(
      `INSERT INTO users (name, email, password_hash, plan, is_verified)
       VALUES (?, ?, ?, 'free', 0)`,
      [name, email, passwordHash]
    );

    const user = await dbGet(
      `SELECT id, name, email, plan, is_verified FROM users WHERE id = ?`,
      [result.lastID]
    );

    const token = await createVerificationToken(user.id);
    await sendVerificationEmail(user, token);

    return res.json({
      message:
        "Account created. Please check your email and verify your account before logging in."
    });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({
      error: "Signup failed."
    });
  }
});

app.post("/api/resend-verification", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        error: "Email is required."
      });
    }

    const user = await dbGet(
      `SELECT id, name, email, plan, is_verified FROM users WHERE email = ?`,
      [email]
    );

    if (!user) {
      return res.json({
        message: "If an account exists, a verification email has been sent."
      });
    }

    if (Number(user.is_verified) === 1) {
      return res.json({
        message: "This email is already verified."
      });
    }

    const token = await createVerificationToken(user.id);
    await sendVerificationEmail(user, token);

    return res.json({
      message: "Verification email sent."
    });
  } catch (err) {
    console.error("resend verification error:", err);
    return res.status(500).json({
      error: "Could not resend verification email."
    });
  }
});

app.get("/api/verify-email", async (req, res) => {
  try {
    const token = normalizeText(req.query?.token);

    if (!token) {
      return res.redirect(`${APP_BASE_URL}/login.html?verified=0`);
    }

    const row = await dbGet(
      `
        SELECT evt.id, evt.user_id, evt.expires_at, u.email
        FROM email_verification_tokens evt
        INNER JOIN users u ON u.id = evt.user_id
        WHERE evt.token = ?
      `,
      [token]
    );

    if (!row) {
      return res.redirect(`${APP_BASE_URL}/login.html?verified=0`);
    }

    const isExpired = await dbGet(
      `SELECT CASE WHEN datetime(?) < datetime('now') THEN 1 ELSE 0 END AS expired`,
      [row.expires_at]
    );

    if (Number(isExpired?.expired || 0) === 1) {
      await dbRun(`DELETE FROM email_verification_tokens WHERE id = ?`, [row.id]);
      return res.redirect(`${APP_BASE_URL}/login.html?verified=0`);
    }

    await dbRun(
      `UPDATE users SET is_verified = 1 WHERE id = ?`,
      [row.user_id]
    );

    await dbRun(
      `DELETE FROM email_verification_tokens WHERE user_id = ?`,
      [row.user_id]
    );

    return res.redirect(`${APP_BASE_URL}/login.html?verified=1`);
  } catch (err) {
    console.error("verify email error:", err);
    return res.redirect(`${APP_BASE_URL}/login.html?verified=0`);
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    const userRow = await dbGet(
      `SELECT * FROM users WHERE email = ?`,
      [email]
    );

    if (!userRow) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    const passwordOk = await bcrypt.compare(password, userRow.password_hash);

    if (!passwordOk) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    if (Number(userRow.is_verified) !== 1) {
      return res.status(403).json({
        error: "Please verify your email before logging in."
      });
    }

    const user = {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      plan: userRow.plan,
      is_verified: userRow.is_verified
    };

    const token = createAuthToken(user);

    return res.json({
      message: "Login successful.",
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({
      error: "Login failed."
    });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        error: "Email is required."
      });
    }

    const user = await dbGet(
      `SELECT id, name, email FROM users WHERE email = ?`,
      [email]
    );

    if (!user) {
      return res.json({
        message: "If an account exists for this email, a reset link has been sent."
      });
    }

    const token = await createPasswordResetToken(user.id);
    await sendPasswordResetEmail(user, token);

    return res.json({
      message: "If an account exists for this email, a reset link has been sent."
    });
  } catch (err) {
    console.error("forgot password error:", err);
    return res.status(500).json({
      error: "Could not process password reset request."
    });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const token = normalizeText(req.body?.token);
    const password = String(req.body?.password || "");

    if (!token || !password) {
      return res.status(400).json({
        error: "Token and new password are required."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters long."
      });
    }

    const row = await dbGet(
      `
        SELECT prt.id, prt.user_id, prt.expires_at
        FROM password_reset_tokens prt
        WHERE prt.token = ?
      `,
      [token]
    );

    if (!row) {
      return res.status(400).json({
        error: "Invalid or expired reset link."
      });
    }

    const isExpired = await dbGet(
      `SELECT CASE WHEN datetime(?) < datetime('now') THEN 1 ELSE 0 END AS expired`,
      [row.expires_at]
    );

    if (Number(isExpired?.expired || 0) === 1) {
      await dbRun(`DELETE FROM password_reset_tokens WHERE id = ?`, [row.id]);
      return res.status(400).json({
        error: "Invalid or expired reset link."
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await dbRun(
      `UPDATE users SET password_hash = ? WHERE id = ?`,
      [passwordHash, row.user_id]
    );

    await dbRun(
      `DELETE FROM password_reset_tokens WHERE user_id = ?`,
      [row.user_id]
    );

    return res.json({
      message: "Password updated successfully. You can now log in."
    });
  } catch (err) {
    console.error("reset password error:", err);
    return res.status(500).json({
      error: "Could not reset password."
    });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.user) {
    return res.json({
      loggedIn: false,
      user: null
    });
  }

  return res.json({
    loggedIn: true,
    user: sanitizeUser(req.user)
  });
});

/* HISTORY */

app.get("/api/history", requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      `
        SELECT id, original_text, voice, speed, pitch, audio_url, created_at
        FROM audio_history
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [req.user.id]
    );

    return res.json({
      items: rows || []
    });
  } catch (err) {
    console.error("history error:", err);
    return res.status(500).json({
      error: "Failed to load audio history."
    });
  }
});

app.delete("/api/history/:id", requireAuth, async (req, res) => {
  try {
    const itemId = Number(req.params.id);

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({
        error: "Invalid history item."
      });
    }

    const existing = await dbGet(
      `SELECT id FROM audio_history WHERE id = ? AND user_id = ?`,
      [itemId, req.user.id]
    );

    if (!existing) {
      return res.status(404).json({
        error: "History item not found."
      });
    }

    await dbRun(
      `DELETE FROM audio_history WHERE id = ? AND user_id = ?`,
      [itemId, req.user.id]
    );

    return res.json({
      message: "History item deleted."
    });
  } catch (err) {
    console.error("delete history error:", err);
    return res.status(500).json({
      error: "Failed to delete history item."
    });
  }
});

/* USAGE */

app.get("/api/usage", async (req, res) => {
  try {
    const trackingId = getTrackingId(req);
    const plan = req.user?.plan || "guest";
    const limits = getPlanLimits(plan);

    const translateUsed = await getTodayUsage(trackingId, "convert");
    const ttsUsed = await getTodayUsage(trackingId, "tts");

    return res.json({
      plan,
      translate: {
        used: translateUsed,
        limit: limits.translate,
        remaining: Math.max(0, limits.translate - translateUsed)
      },
      tts: {
        used: ttsUsed,
        limit: limits.tts,
        remaining: Math.max(0, limits.tts - ttsUsed)
      }
    });
  } catch (err) {
    console.error("usage error:", err);
    return res.status(500).json({
      error: "Failed to load usage stats."
    });
  }
});

/* ADMIN */

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const freeLimits = getPlanLimits("free");

    const [
      translateToday,
      ttsToday,
      translateCharsToday,
      ttsCharsToday,
      translateCacheHitsToday,
      translateCacheMissesToday,
      ttsCacheHitsToday,
      ttsCacheMissesToday,
      translationCacheCount,
      ttsCacheCount,
      usageLogCount,
      requestLogCount,
      topClientsToday
    ] = await Promise.all([
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'convert'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'tts'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COALESCE(SUM(char_count), 0) AS total
        FROM usage_logs
        WHERE endpoint = 'convert'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COALESCE(SUM(char_count), 0) AS total
        FROM usage_logs
        WHERE endpoint = 'tts'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'convert'
          AND cache_status = 'hit'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'convert'
          AND cache_status = 'miss'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'tts'
          AND cache_status = 'hit'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`
        SELECT COUNT(*) AS total
        FROM request_logs
        WHERE endpoint = 'tts'
          AND cache_status = 'miss'
          AND date(created_at) = date('now', 'localtime')
      `),
      dbGet(`SELECT COUNT(*) AS total FROM translation_cache`),
      dbGet(`SELECT COUNT(*) AS total FROM tts_cache`),
      dbGet(`SELECT COUNT(*) AS total FROM usage_logs`),
      dbGet(`SELECT COUNT(*) AS total FROM request_logs`),
      dbAll(`
        SELECT client_id, COUNT(*) AS requests, COALESCE(SUM(char_count), 0) AS chars
        FROM request_logs
        WHERE date(created_at) = date('now', 'localtime')
        GROUP BY client_id
        ORDER BY requests DESC, chars DESC
        LIMIT 5
      `)
    ]);

    const translateHits = Number(translateCacheHitsToday?.total || 0);
    const translateMisses = Number(translateCacheMissesToday?.total || 0);
    const ttsHits = Number(ttsCacheHitsToday?.total || 0);
    const ttsMisses = Number(ttsCacheMissesToday?.total || 0);

    const translateTotalForRate = translateHits + translateMisses;
    const ttsTotalForRate = ttsHits + ttsMisses;

    return res.json({
      today: {
        translate_requests: Number(translateToday?.total || 0),
        tts_requests: Number(ttsToday?.total || 0),
        translate_characters: Number(translateCharsToday?.total || 0),
        tts_characters: Number(ttsCharsToday?.total || 0),
        translate_cache_hits: translateHits,
        translate_cache_misses: translateMisses,
        tts_cache_hits: ttsHits,
        tts_cache_misses: ttsMisses,
        translate_cache_hit_rate: translateTotalForRate
          ? `${Math.round((translateHits / translateTotalForRate) * 100)}%`
          : "0%",
        tts_cache_hit_rate: ttsTotalForRate
          ? `${Math.round((ttsHits / ttsTotalForRate) * 100)}%`
          : "0%"
      },
      totals: {
        translation_cache_records: Number(translationCacheCount?.total || 0),
        tts_cache_records: Number(ttsCacheCount?.total || 0),
        usage_log_rows: Number(usageLogCount?.total || 0),
        request_log_rows: Number(requestLogCount?.total || 0)
      },
      limits: {
        daily_translate_char_limit: freeLimits.translate,
        daily_tts_char_limit: freeLimits.tts
      },
      top_clients_today: topClientsToday || []
    });
  } catch (err) {
    console.error("admin stats error:", err);
    return res.status(500).json({
      error: "Failed to load admin stats."
    });
  }
});

/* CONVERT */

app.post("/api/convert", async (req, res) => {
  const rawText = normalizeText(req.body?.text);
  const mode = normalizeText(req.body?.mode || "english").toLowerCase();

  if (!rawText) {
    return res.json({
      gurmukhi: "",
      note: "Nothing to convert."
    });
  }

  if (rawText.length > MAX_CONVERT_TEXT_LENGTH) {
    return res.status(400).json({
      gurmukhi: "",
      note: `Text is too long. Please keep it under ${MAX_CONVERT_TEXT_LENGTH} characters.`
    });
  }

  const trackingId = getTrackingId(req);
  const plan = req.user?.plan || "guest";
  const limits = getPlanLimits(plan);

  const todaysUsage = await getTodayUsage(trackingId, "convert");

  if (todaysUsage + rawText.length > limits.translate) {
    return res.status(429).json({
      gurmukhi: "",
      note: "Daily translation limit reached. Please try again tomorrow."
    });
  }

  const kill = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        gurmukhi: rawText,
        note: "Conversion timeout. Please try again."
      });
    }
  }, 12000);

  try {
    if (containsGurmukhi(rawText)) {
      clearTimeout(kill);
      return res.json({
        gurmukhi: rawText,
        note: "Text is already in Punjabi."
      });
    }

    if (mode !== "english") {
      clearTimeout(kill);
      return res.json({
        gurmukhi: rawText,
        note: "Only English to Punjabi conversion is enabled in this section."
      });
    }

    const result = await translateEnglishToPunjabi(rawText);

    await logUsage(trackingId, "convert", rawText.length);
    await logRequest(
      "convert",
      result.cached ? "hit" : "miss",
      rawText.length,
      trackingId
    );

    clearTimeout(kill);
    return res.json({
      gurmukhi: result.translatedText,
      note: result.cached
        ? "Translated from smart cache."
        : "Translated from English to Punjabi."
    });
  } catch (err) {
    clearTimeout(kill);
    console.error("convert error:", err);

    return res.status(500).json({
      gurmukhi: rawText,
      error: "convert failed",
      note: err.message || "Conversion failed."
    });
  }
});

/* TTS */

app.post("/api/tts", async (req, res) => {
  try {
    const rawText = normalizeText(req.body?.text);
    const voice = normalizeText(req.body?.voice || "pa-IN-Standard-A");
    const speed = Number(req.body?.speed ?? 1);
    const pitch = Number(req.body?.pitch ?? 0);

    if (!rawText) {
      return res.status(400).json({ error: "Text required." });
    }

    if (rawText.length > MAX_TTS_TEXT_LENGTH) {
      return res.status(400).json({
        error: `Text too long. Maximum ${MAX_TTS_TEXT_LENGTH} characters.`
      });
    }

    if (!containsGurmukhi(rawText)) {
      return res.status(400).json({
        error: "Please enter Punjabi text in Gurmukhi before generating speech."
      });
    }

    if (!isValidVoice(voice)) {
      return res.status(400).json({
        error: "Invalid voice selected."
      });
    }

    if (!isValidSpeed(speed)) {
      return res.status(400).json({
        error: `Speed must be between ${MIN_SPEED} and ${MAX_SPEED}.`
      });
    }

    if (!isValidPitch(pitch)) {
      return res.status(400).json({
        error: `Pitch must be between ${MIN_PITCH} and ${MAX_PITCH}.`
      });
    }

    const normalizedPunjabi = normalizePunjabiForCache(rawText);

    const trackingId = getTrackingId(req);
    const plan = req.user?.plan || "guest";
    const limits = getPlanLimits(plan);

    const todaysUsage = await getTodayUsage(trackingId, "tts");

    if (todaysUsage + rawText.length > limits.tts) {
      return res.status(429).json({
        error: "Daily TTS limit reached. Please try again tomorrow."
      });
    }

    const cacheKey = makeTtsCacheKey({
      text: normalizedPunjabi,
      voice,
      speed,
      pitch
    });

    const existing = await dbGet(
      `SELECT file_name FROM tts_cache WHERE cache_key = ?`,
      [cacheKey]
    );

    let audioUrl = "";
    let wasCached = false;

    if (existing) {
      const cachedFilePath = path.join(CACHE_DIR, existing.file_name);

      if (fs.existsSync(cachedFilePath)) {
        audioUrl = `/cache/${existing.file_name}`;
        wasCached = true;
      }
    }

    if (!audioUrl) {
      const request = {
        input: { text: rawText },
        voice: {
          languageCode: "pa-IN",
          name: voice
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: speed,
          pitch
        }
      };

      const [response] = await ttsClient.synthesizeSpeech(request);

      const fileName = `${cacheKey}.mp3`;
      const filePath = path.join(CACHE_DIR, fileName);

      fs.writeFileSync(filePath, response.audioContent, "binary");

      await dbRun(
        `INSERT OR IGNORE INTO tts_cache (cache_key, text, voice, speed, pitch, file_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cacheKey, normalizedPunjabi, voice, speed, pitch, fileName]
      );

      audioUrl = `/cache/${fileName}`;
      wasCached = false;
    }

    await logUsage(trackingId, "tts", rawText.length);
    await logRequest("tts", wasCached ? "hit" : "miss", rawText.length, trackingId);

    if (req.user?.id) {
      await saveAudioHistory(
        req.user.id,
        rawText,
        voice,
        speed,
        pitch,
        audioUrl
      );
    }

    return res.json({
      audioUrl,
      cached: wasCached
    });
  } catch (err) {
    console.error("tts error:", err);
    return res.status(500).json({
      error: "TTS failed",
      details: err.message || "Unknown TTS error"
    });
  }
});

app.get(/^(?!\/api\/|\/health|\/cache\/|\/demo\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VoicePunjab API running on port ${PORT}`);
  console.log("NODE_ENV =", process.env.NODE_ENV || "(missing)");
  console.log("ALLOWED_ORIGIN =", ALLOWED_ORIGIN_RAW);
  console.log("GOOGLE_CLOUD_PROJECT =", GOOGLE_CLOUD_PROJECT || "(missing)");
  console.log(
    "GOOGLE_APPLICATION_CREDENTIALS =",
    GOOGLE_APPLICATION_CREDENTIALS || "(not set)"
  );
  console.log("GOOGLE_CREDENTIALS_JSON present =", !!GOOGLE_CREDENTIALS_JSON);
  console.log("DB_PATH =", DB_PATH);
  console.log("CACHE_DIR =", CACHE_DIR);
  console.log("DEMO_DIR =", DEMO_DIR);
  console.log("JWT_SECRET set =", !!JWT_SECRET);
  console.log("ADMIN_TOKEN set =", !!ADMIN_TOKEN);
  console.log("SMTP configured =", !!mailer);
});