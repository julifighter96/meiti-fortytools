require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const { handleMeitiWebhook } = require('./meitiHandler');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Simple request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  req.requestId = requestId;

  const logEntry = {
    level: 'info',
    message: 'incoming_request',
    requestId,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString()
  };

  log(logEntry);

  res.on('finish', () => {
    log({
      level: 'info',
      message: 'request_completed',
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start
    });
  });

  next();
});

// Health check (useful for Railway)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main Meiti webhook endpoint
app.post('/meiti/webhook', async (req, res) => {
  try {
    await handleMeitiWebhook(req, res);
  } catch (err) {
    log({
      level: 'error',
      message: 'unhandled_error_in_webhook',
      requestId: req.requestId,
      error: err && err.message,
      stack: err && err.stack
    });

    // Fail-safe: ensure we respond something so Meiti can retry
    res.status(500).json({
      error: 'internal_server_error',
      message: 'Unexpected error while processing webhook'
    });
  }
});

const PORT = process.env.PORT || 3000;

function log(entry) {
  const line = JSON.stringify(entry);
  // Console log for Railway logs
  console.log(line);

  // Additionally write to a local log file
  try {
    const logsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.appendFileSync(path.join(logsDir, 'app.log'), line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // Avoid crashing on logging errors
  }
}

app.listen(PORT, () => {
  log({
    level: 'info',
    message: 'server_started',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

module.exports = { app, log };

