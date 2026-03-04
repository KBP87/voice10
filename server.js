"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const textToSpeech = require("@google-cloud/text-to-speech");
const Sanscript = require("sanscript");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// -------------------- GOOGLE CREDS (HOSTINGER + LOCAL SAFE) --------------------
const TMP_KEY_PATH = "/tmp/google-key.json";

function ensureGoogleCreds() {
  // 1) BEST: Hostinger env var (one-line Base64)
  const b64 = (process.env.GOOGLE_CREDS_B64 || "").trim();
  if (b64) {
    try {
      const jsonText = Buffer.from(b64, "base64").toString("utf8");

      if (!jsonText.trim().startsWith("{")) {
        return { ok: false, source: "GOOGLE_CREDS_B64", reason: "Decoded text is not JSON (bad base64)" };
      }

      fs.writeFileSync(TMP_KEY_PATH, jsonText, "utf8");
      process.env.GOOGLE_APPLICATION_CREDENTIALS = TMP_KEY_PATH;

      return { ok: true, source: "GOOGLE_CREDS_B64", path: TMP_KEY_PATH, size: fs.statSync(TMP_KEY_PATH).size };
    } catch (e) {
      return { ok: false, source: "GOOGLE_CREDS_B64", reason: e?.message || String(e) };
    }
  }

  // 2) LOCAL: GOOGLE_APPLICATION_CREDENTIALS points to a JSON file path
  // Example .env: GOOGLE_APPLICATION_CREDENTIALS=./keys/yourkey.json
  const gac = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (gac) {
    const abs = path.isAbsolute(gac) ? gac : path.join(process.cwd(), gac);
    if (fs.existsSync(abs)) {
      return { ok: true, source: "GOOGLE_APPLICATION_CREDENTIALS", path: abs, size: fs.statSync(abs).size };
    }
    return { ok: false, source: "GOOGLE_APPLICATION_CREDENTIALS", reason: "Path not found", path: abs };
  }

  // 3) Nothing provided
  return { ok: false, source: "none", reason: "Set GOOGLE_CREDS_B64 (Hostinger) or GOOGLE_APPLICATION_CREDENTIALS (local)" };
}

const CREDS_STATUS = ensureGoogleCreds();

// Create Google client AFTER creds
const ttsClient = new textToSpeech.TextToSpeechClient(
  CREDS_STATUS.ok ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : undefined
);

// -------------------- APP --------------------
const app = express();

const GUEST_DAILY_LIMIT = Number(process.env.GUEST_DAILY_LIMIT || 300);
const FREE_USER_DAILY_LIMIT = Number(process.env.FREE_USER_DAILY_LIMIT || 2000);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";

// IMPORTANT: secure cookies only on Hostinger (HTTPS)
const IS_PROD = process.env.NODE_ENV === "production" || String(process.env.HOSTINGER || "").toLowerCase() === "true";

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: IS_PROD, // false on localhost, true on Hostinger https
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 90,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Device cookie (guest tracking)
app.use((req, res, next) => {
  if (!req.cookies.deviceId) {
    const id = crypto.randomBytes(16).toString("hex");
    res.cookie("deviceId", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    req.cookies.deviceId = id;
  }
  next();
});

// ✅ Debug endpoint (must exist on Hostinger if correct server.js is deployed)
app.get("/api/debug-creds", (req, res) => {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  let exists = false;
  let size = 0;
  let statErr = null;

  try {
    const st = fs.statSync(p);
    exists = true;
    size = st.size;
  } catch (e) {
    statErr = e?.message || String(e);
  }

  res.json({
    creds_status: CREDS_STATUS,
    has_GOOGLE_CREDS_B64: Boolean((process.env.GOOGLE_CREDS_B64 || "").trim()),
    GOOGLE_APPLICATION_CREDENTIALS: p,
    file_exists: exists,
    file_size: size,
    stat_error: statErr,
  });
});

// ---------- DB ----------
const db = new Database(path.join(__dirname, "data.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    chars_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  );
`);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function getUsageKey(req) {
  if (req.session?.userId) return `user:${req.session.userId}`;
  const ip = getIp(req);
  const deviceId = req.cookies.deviceId || "no_device";
  return `guest:${ip}:${deviceId}`;
}

function getLimit(req) {
  return req.session?.userId ? FREE_USER_DAILY_LIMIT : GUEST_DAILY_LIMIT;
}

function getUsed(day, key) {
  const row = db.prepare("SELECT chars_used FROM usage WHERE day=? AND key=?").get(day, key);
  return row ? row.chars_used : 0;
}

function addUsed(day, key, addChars) {
  db.prepare(`
    INSERT INTO usage(day, key, chars_used)
    VALUES(?, ?, ?)
    ON CONFLICT(day, key) DO UPDATE SET chars_used = chars_used + excluded.chars_used
  `).run(day, key, addChars);
}

function getRemaining(req) {
  const day = todayStr();
  const key = getUsageKey(req);
  const used = getUsed(day, key);
  const limit = getLimit(req);
  return {
    day,
    key,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    isLoggedIn: Boolean(req.session?.userId),
  };
}

// ---------- ROMAN NORMALIZATION ----------
function normalizeRomanPunjabi(text = "") {
  return text
    .replace(/\bhanji\b/gi, "haan ji")
    .replace(/\bhaan\b/gi, "haaN")
    .replace(/\btusi\b/gi, "tusii")
    .replace(/\bkiwen\b/gi, "kiveN")
    .replace(/\bkiven\b/gi, "kiveN")
    .replace(/\bkuj(h)?\b/gi, "kujh")
    .replace(/\bkuch\b/gi, "kujh")
    .replace(/\bmain\b/gi, "maiN")
    .replace(/\bmein\b/gi, "maiN")
    .replace(/\bnahee\b/gi, "nahiN")
    .replace(/\bnahi\b/gi, "nahiN")
    .replace(/\bnahin\b/gi, "nahiN")
    .replace(/\btheek\b/gi, "Thik")
    .replace(/\bha\b/gi, "hai");
}

// ---------- AUTH ----------
app.post("/api/auth/register", (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email.includes("@")) return res.status(400).json({ error: "Enter a valid email." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be 6+ characters." });

    const password_hash = bcrypt.hashSync(password, 10);
    const created_at = new Date().toISOString();

    db.prepare("INSERT INTO users(email, password_hash, created_at) VALUES(?,?,?)").run(
      email,
      password_hash,
      created_at
    );

    const user = db.prepare("SELECT id,email FROM users WHERE email=?").get(email);
    req.session.userId = user.id;

    res.json({ ok: true, user, ...getRemaining(req) });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "Email already registered. Please login." });
    console.error(e);
    res.status(500).json({ error: "Register failed." });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    const userRow = db.prepare("SELECT id,email,password_hash FROM users WHERE email=?").get(email);
    if (!userRow) return res.status(401).json({ error: "Invalid email or password." });

    const ok = bcrypt.compareSync(password, userRow.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    req.session.userId = userRow.id;
    res.json({ ok: true, user: { id: userRow.id, email: userRow.email }, ...getRemaining(req) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session?.userId) return res.json({ user: null, ...getRemaining(req) });
  const user = db.prepare("SELECT id,email FROM users WHERE id=?").get(req.session.userId);
  res.json({ user: user || null, ...getRemaining(req) });
});

// ---------- USAGE ----------
app.get("/api/usage", (req, res) => {
  res.json(getRemaining(req));
});

// ---------- CONVERT ----------
app.post("/api/convert", (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.json({ gurmukhi: "" });
    const cleaned = normalizeRomanPunjabi(text);
    const gurmukhi = Sanscript.t(cleaned, "itrans", "gurmukhi");
    res.json({ gurmukhi });
  } catch (e) {
    console.error("Convert error:", e);
    res.status(500).json({ error: "Convert failed" });
  }
});

function cleanGender(g) {
  const up = String(g || "").toUpperCase();
  if (up === "MALE" || up === "FEMALE" || up === "NEUTRAL") return up;
  return "NEUTRAL";
}

// ---------- TTS ----------
app.post("/api/tts", async (req, res) => {
  try {
    const { text, gender } = req.body;

    const cleanText = String(text || "").trim();
    if (!cleanText) return res.status(400).json({ error: "Text is required." });

    const chars = cleanText.length;
    const status = getRemaining(req);
    if (chars > status.remaining) {
      return res.status(402).json({
        error: `Daily limit reached. Remaining today: ${status.remaining} characters.`,
        ...status,
      });
    }

    const request = {
      input: { text: cleanText },
      voice: { languageCode: "pa-IN", ssmlGender: cleanGender(gender) },
      audioConfig: { audioEncoding: "MP3" },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const audioBase64 = response.audioContent.toString("base64");

    addUsed(todayStr(), getUsageKey(req), chars);
    res.json({ audioBase64, ...getRemaining(req) });
  } catch (e) {
    console.error("TTS Error:", e);
    res.status(500).json({
      error: "Failed to generate speech.",
      detail: e?.message || String(e),
      creds_status: CREDS_STATUS,
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));