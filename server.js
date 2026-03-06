"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const textToSpeech = require("@google-cloud/text-to-speech");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;

const app = express();

const ttsClient = new textToSpeech.TextToSpeechClient();
const translateClient = new TranslationServiceClient();

const PORT = Number(process.env.PORT || 8080);

const GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_PROJECT_ID ||
  "";

const ALLOWED_ORIGIN_RAW = (process.env.ALLOWED_ORIGIN || "*").trim();
const ALLOWED_ORIGINS =
  ALLOWED_ORIGIN_RAW === "*"
    ? "*"
    : ALLOWED_ORIGIN_RAW.split(",").map((s) => s.trim()).filter(Boolean);

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

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30
});

app.use("/api/tts", limiter);
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.send("ok");
});

function containsGurmukhi(text) {
  return /[\u0A00-\u0A7F]/.test(String(text || ""));
}

async function translateEnglishToPunjabi(text) {
  if (!GOOGLE_CLOUD_PROJECT) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT in environment variables");
  }

  const request = {
    parent: `projects/${GOOGLE_CLOUD_PROJECT}/locations/global`,
    contents: [text],
    mimeType: "text/plain",
    sourceLanguageCode: "en",
    targetLanguageCode: "pa"
  };

  const [response] = await translateClient.translateText(request);
  return response.translations?.[0]?.translatedText || text;
}

app.post("/api/convert", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const mode = String(req.body?.mode || "english").trim().toLowerCase();

  if (!text) {
    return res.json({
      gurmukhi: "",
      note: "Nothing to convert."
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

    const output = await translateEnglishToPunjabi(text);

    clearTimeout(kill);
    return res.json({
      gurmukhi: output,
      note: "Translated from English to Punjabi."
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
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    if (!containsGurmukhi(text)) {
      return res.status(400).json({
        error: "Please enter Punjabi text in Gurmukhi before generating speech."
      });
    }

    const voice = String(req.body?.voice || "pa-IN-Standard-A");
    const speed = Number(req.body?.speed ?? 1);
    const pitch = Number(req.body?.pitch ?? 0);

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
    const audioBase64 = Buffer.from(response.audioContent).toString("base64");

    res.json({ audioBase64 });
  } catch (err) {
    console.error("tts error:", err);
    res.status(500).json({
      error: "TTS failed",
      details: err.message
    });
  }
});

app.get(/^(?!\/api\/|\/health).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("VoicePunjab running on port", PORT);
  console.log("ALLOWED_ORIGIN =", ALLOWED_ORIGIN_RAW);
  console.log("GOOGLE_CLOUD_PROJECT =", GOOGLE_CLOUD_PROJECT || "(missing)");
});