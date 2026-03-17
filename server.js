"use strict";

const express = require("express");
const app = express();

const PORT = Number(process.env.PORT || 8080);

app.get("/", (req, res) => {
  res.send("VoicePunjab test server is running");
});

app.get("/health", (req, res) => {
  res.send("ok");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Test server running on port ${PORT}`);
});