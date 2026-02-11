require('dotenv').config();

const express = require('express');
const { log } = require('./logger');

const { handleMeitiWebhook } = require('./meitiHandler');
const { fortytoolsClient } = require('./fortytoolsClient');

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

// Debug: Liste der Kundenstatus von Fortytools (zum Testen, welche customer_state_id gültig ist)
app.get('/debug/fortytools-customer-states', async (req, res) => {
  const requestId = req.requestId || `debug-${Date.now()}`;
  try {
    const states = await fortytoolsClient.ensureCustomerStatesLoaded(requestId);
    res.json({
      ok: true,
      message: 'Verwende eine der IDs als customer_state_id (z. B. erster Eintrag).',
      customer_states: states,
      default_id: fortytoolsClient.getDefaultCustomerStateId()
    });
  } catch (err) {
    log({
      level: 'error',
      message: 'debug_fortytools_states_error',
      requestId,
      error: err && err.message
    });
    res.status(500).json({
      ok: false,
      error: err && err.message
    });
  }
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
app.listen(PORT, () => {
  log({
    level: 'info',
    message: 'server_started',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

module.exports = { app, log };

