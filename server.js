// server.js
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

require("dotenv").config({ override: true });

const express = require("express");
const rateLimit = require("express-rate-limit");
const textToSpeech = require("@google-cloud/text-to-speech");

const app = express();

// ---------- SETTINGS ----------
const PORT = Number(process.env.PORT || 8080);

// Optional: protect /api/tts with an API key (recommended for public deployment)
const API_KEY = (process.env.API_KEY || "").trim();
const REQUIRE_API_KEY = API_KEY.length > 0;

// Basic CORS (safe default)
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "*").trim();

// ---------- GOOGLE CREDS (LOCAL FILE or ENV JSON) ----------
// 1) If Hostinger/Docker provides JSON in env: GOOGLE_CREDENTIALS_JSON, write to temp file.
// 2) Otherwise use GOOGLE_APPLICATION_CREDENTIALS (usually from .env) as-is.
// 3) If GOOGLE_APPLICATION_CREDENTIALS is relative, resolve it from this folder.
(function setupGoogleCreds() {
  if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credsPath = path.join(os.tmpdir(), "gcp-tts-creds.json");
    fs.writeFileSync(credsPath, process.env.GOOGLE_CREDENTIALS_JSON, "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
  }

  const creds = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (!creds) {
    console.warn(
      "⚠️ GOOGLE_APPLICATION_CREDENTIALS not set. If you're on Hostinger, set GOOGLE_CREDENTIALS_JSON."
    );
    return;
  }

  // If relative path like ./keys/google_key.json, resolve it from project directory
  if (!path.isAbsolute(creds)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, creds);
  }

  // Helpful crash-prevention: verify file exists (for file-based creds)
  const finalPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (finalPath && !finalPath.includes(os.tmpdir()) && !fs.existsSync(finalPath)) {
    console.error("❌ Google credentials file not found at:", finalPath);
    console.error("   Fix .env path OR put the json file there OR use GOOGLE_CREDENTIALS_JSON.");
    process.exit(1);
  }
})();

// Create client AFTER creds setup
const client = new textToSpeech.TextToSpeechClient();

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN === "*" ? "*" : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limit
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Optional API key middleware
function requireApiKey(req, res, next) {
  if (!REQUIRE_API_KEY) return next();
  const sent = (req.header("x-api-key") || "").trim();
  if (!sent || sent !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized (invalid API key)" });
  }
  next();
}

// ---------- STATIC SITE ----------
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (req, res) => res.status(200).send("ok"));

// ---------- SIMPLE CONVERT ENDPOINT ----------
app.post("/api/convert", (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.json({ gurmukhi: "" });

  const hasGurmukhi = /[\u0A00-\u0A7F]/.test(text);
  if (hasGurmukhi) return res.json({ gurmukhi: text });

  return res.json({ gurmukhi: text });
});

// ---------- TTS ENDPOINT ----------
app.post("/api/tts", ttsLimiter, requireApiKey, async (req, res) => {
  try {
    const { text, voiceName, speakingRate, pitch } = req.body || {};

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Please provide 'text'." });
    }

    if (text.length > 2000) {
      return res.status(400).json({ error: "Text too long (max 2000 chars)." });
    }

    const request = {
      input: { text: text.trim() },
      voice: {
        languageCode: "pa-IN",
        ...(voiceName ? { name: String(voiceName) } : {}),
      },
      audioConfig: {
        audioEncoding: "MP3",
        ...(typeof speakingRate === "number" ? { speakingRate } : {}),
        ...(typeof pitch === "number" ? { pitch } : {}),
      },
    };

    const [response] = await client.synthesizeSpeech(request);

    const audioBase64 = Buffer.from(response.audioContent).toString("base64");
    return res.json({ audioBase64 });
  } catch (err) {
    console.error("TTS error:", err);
    return res.status(500).json({
      error: "Failed to generate speech",
      detail: err?.message || String(err),
    });
  }
});

// Fallback to frontend for non-API routes
app.get(/^(?!\/api\/|\/health).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Punjabi TTS API running on port ${PORT}`);
  console.log("Using creds:", process.env.GOOGLE_APPLICATION_CREDENTIALS ? "✅ set" : "❌ missing");
});

app.get("/debug/env", (req, res) => {
  res.json({
    hasTest: process.env.TEST_VAR || null,
    keys: Object.keys(process.env).filter(k => k.includes("GOOGLE"))
  });
});