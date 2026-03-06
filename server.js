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
const textToSpeech = require("@google-cloud/text-to-speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;

const app = express();

const PORT = Number(process.env.PORT || 8080);

const GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_PROJECT_ID ||
  "";

const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

const GOOGLE_CREDENTIALS_JSON =
  process.env.GOOGLE_CREDENTIALS_JSON || "";

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
  "http://localhost:8080,http://127.0.0.1:8080,https://voicepunjabai.com,https://www.voicepunjabai.com"
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

const DB_PATH = path.join(__dirname, "data.sqlite");
const CACHE_DIR = path.join(__dirname, "cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function initDatabase() {
  db.serialize(() => {
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

async function translateEnglishToPunjabi(text) {
  if (!GOOGLE_CLOUD_PROJECT) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT in environment variables");
  }

  const existing = await dbGet(
    `SELECT translated_text FROM translation_cache WHERE source_text = ?`,
    [text]
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
    [text, translatedText]
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

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
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

app.use("/api/tts", ttsLimiter);
app.use("/api/convert", convertLimiter);
app.use("/cache", express.static(CACHE_DIR));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.send("ok");
});

app.post("/api/convert", async (req, res) => {
  const text = normalizeText(req.body?.text);
  const mode = normalizeText(req.body?.mode || "english").toLowerCase();

  if (!text) {
    return res.json({
      gurmukhi: "",
      note: "Nothing to convert."
    });
  }

  if (text.length > MAX_CONVERT_TEXT_LENGTH) {
    return res.status(400).json({
      gurmukhi: "",
      note: `Text is too long. Please keep it under ${MAX_CONVERT_TEXT_LENGTH} characters.`
    });
  }

  const kill = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        gurmukhi: text,
        note: "Conversion timeout. Please try again."
      });
    }
  }, 12000);

  try {
    if (containsGurmukhi(text)) {
      clearTimeout(kill);
      return res.json({
        gurmukhi: text,
        note: "Text is already in Punjabi."
      });
    }

    if (mode !== "english") {
      clearTimeout(kill);
      return res.json({
        gurmukhi: text,
        note: "Only English to Punjabi conversion is enabled in this section."
      });
    }

    const result = await translateEnglishToPunjabi(text);

    clearTimeout(kill);
    return res.json({
      gurmukhi: result.translatedText,
      note: result.cached
        ? "Translated from cache."
        : "Translated from English to Punjabi."
    });
  } catch (err) {
    clearTimeout(kill);
    console.error("convert error:", err);

    return res.status(500).json({
      gurmukhi: text,
      error: "convert failed",
      note: err.message || "Conversion failed."
    });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const text = normalizeText(req.body?.text);
    const voice = normalizeText(req.body?.voice || "pa-IN-Standard-A");
    const speed = Number(req.body?.speed ?? 1);
    const pitch = Number(req.body?.pitch ?? 0);

    if (!text) {
      return res.status(400).json({ error: "Text required." });
    }

    if (text.length > MAX_TTS_TEXT_LENGTH) {
      return res.status(400).json({
        error: `Text too long. Maximum ${MAX_TTS_TEXT_LENGTH} characters.`
      });
    }

    if (!containsGurmukhi(text)) {
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

    const cacheKey = makeTtsCacheKey({ text, voice, speed, pitch });

    const existing = await dbGet(
      `SELECT file_name FROM tts_cache WHERE cache_key = ?`,
      [cacheKey]
    );

    if (existing) {
      const cachedFilePath = path.join(CACHE_DIR, existing.file_name);

      if (fs.existsSync(cachedFilePath)) {
        return res.json({
          audioUrl: `/cache/${existing.file_name}`,
          cached: true
        });
      }
    }

    const request = {
      input: { text },
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
      [cacheKey, text, voice, speed, pitch, fileName]
    );

    return res.json({
      audioUrl: `/cache/${fileName}`,
      cached: false
    });
  } catch (err) {
    console.error("tts error:", err);
    res.status(500).json({
      error: "TTS failed",
      details: err.message
    });
  }
});

app.get(/^(?!\/api\/|\/health|\/cache\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("VoicePunjab running on port", PORT);
  console.log("NODE_ENV =", process.env.NODE_ENV || "(missing)");
  console.log("ALLOWED_ORIGIN =", ALLOWED_ORIGIN_RAW);
  console.log("GOOGLE_CLOUD_PROJECT =", GOOGLE_CLOUD_PROJECT || "(missing)");
  console.log(
    "GOOGLE_APPLICATION_CREDENTIALS =",
    GOOGLE_APPLICATION_CREDENTIALS || "(not set)"
  );
  console.log(
    "GOOGLE_CREDENTIALS_JSON present =",
    !!GOOGLE_CREDENTIALS_JSON
  );
  console.log(
    "KEY FILE EXISTS =",
    GOOGLE_APPLICATION_CREDENTIALS
      ? fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)
      : false
  );
  console.log("DB_PATH =", DB_PATH);
  console.log("CACHE_DIR =", CACHE_DIR);
});