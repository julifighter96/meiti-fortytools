const { fortytoolsClient } = require('./fortytoolsClient');
const { log } = require('./logger');

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip spaces, dashes, brackets etc. Keep leading +
  return raw.replace(/[^+\d]/g, '');
}

function buildCustomerPayloadFromMeiti(contactData, projectData) {
  if (!contactData) contactData = {};
  if (!projectData) projectData = {};

  const phone = normalizePhone(contactData.phoneNumber);

  // Decide what to use as main "name" in Fortytools:
  // Prefer company, otherwise "first last".
  let name = contactData.company;
  if (!name && (contactData.firstName || contactData.lastName)) {
    name = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim();
  }

  // Fortytools Pflichtfeld; Default per Env änderbar (z. B. "Lead", "Kunde" – je nach Fortytools-Config)
  const customerState = process.env.FORTYTOOLS_DEFAULT_CUSTOMER_STATE || 'Lead';

  const payload = {
    email: contactData.email || undefined,
    phone: phone || undefined,
    first_name: contactData.firstName || undefined,
    last_name: contactData.lastName || undefined,
    name: name || undefined,
    customer_state: customerState,
    street: contactData.addressLine1 || projectData.address || undefined,
    zip: contactData.postCode || projectData.postcode || undefined,
    city: contactData.city || projectData.city || undefined,
    shortinfo: contactData.crmInternalInfo || undefined,
    planning_info: projectData.currentSummary || projectData.inquirySummary || undefined,
    custom_attributes: {
      meiti_contact_id: contactData.meitiContactId,
      meiti_project_id: projectData.meitiProjectId
    }
  };

  // Remove undefined / null / leere Strings, damit bestehende Daten in Fortytools
  // nicht mit Leerwerten überschrieben werden.
  Object.keys(payload).forEach((key) => {
    const val = payload[key];
    if (val === undefined || val === null) {
      delete payload[key];
    } else if (typeof val === 'string' && val.trim() === '') {
      delete payload[key];
    }
  });

  return payload;
}

async function handleMeitiWebhook(req, res) {
  const requestId = req.requestId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const webhookToken = process.env.MEITI_WEBHOOK_TOKEN;

  // Simple auth check like described in meiti docs: bearer token in Authorization header
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (webhookToken && token !== webhookToken) {
    log({
      level: 'warn',
      message: 'unauthorized_meiti_webhook',
      requestId
    });
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const { eventType, contactData, projectData } = body;

  const isSupportedEvent =
    eventType === 'Manual' ||
    eventType === 4 ||
    eventType === '4';

  log({
    level: 'info',
    message: 'meiti_webhook_received',
    requestId,
    eventType,
    phoneNumber: contactData && contactData.phoneNumber,
    meitiContactId: contactData && contactData.meitiContactId,
    meitiProjectId: projectData && projectData.meitiProjectId
  });

  // For now we only process Manual triggers / type 4, as requested.
  if (!isSupportedEvent) {
    log({
      level: 'info',
      message: 'meiti_event_ignored',
      requestId,
      reason: 'unsupported_event_type',
      eventType
    });

    return res.status(200).json({
      message: 'event_type_ignored',
      supportedEventTypes: ['Manual', 4]
    });
  }

  if (!contactData) {
    log({
      level: 'warn',
      message: 'missing_contact_data',
      requestId
    });
    return res.status(400).json({
      error: 'invalid_payload',
      message: 'contactData is required for Manual event'
    });
  }

  const phone = normalizePhone(contactData.phoneNumber);
  const email = contactData.email;

  try {
    // === 1. Customer in Fortytools finden oder anlegen ===
    let customerId = await fortytoolsClient.findCustomerByContact({
      phone,
      email,
      requestId
    });

    const customerPayload = buildCustomerPayloadFromMeiti(contactData, projectData);

    log({
      level: 'info',
      message: 'fortytools_customer_payload_built',
      requestId,
      customerPayload
    });

    if (customerId) {
      log({
        level: 'info',
        message: 'existing_customer_found',
        requestId,
        customerId
      });

      await fortytoolsClient.updateCustomer(customerId, customerPayload, requestId);
    } else {
      log({
        level: 'info',
        message: 'creating_new_customer',
        requestId
      });

      customerId = await fortytoolsClient.createCustomer(customerPayload, requestId);

      log({
        level: 'info',
        message: 'customer_created',
        requestId,
        customerId
      });
    }

    // === 2. Antwort an meiti: nur crmContactId zurückgeben (keine Projekte/Objekte) ===
    // Siehe meiti webhook docs: https://www.meiti.io/docs/webhook
    const responseBody = {
      requestContactUpdate: true,
      contactData: {
        crmContactId: String(customerId),
        crmAiInfo: 'Fortytools Kunde verknüpft'
      },
      requestProjectUpdate: false
    };

    log({
      level: 'info',
      message: 'meiti_response_payload',
      requestId,
      responseBody
    });

    return res.status(200).json(responseBody);
  } catch (err) {
    log({
      level: 'error',
      message: 'meiti_webhook_processing_error',
      requestId,
      error: err && err.message,
      stack: err && err.stack
    });

    // Für komplexe Fehler könnte man 202 + späteren Callback nutzen.
    // Für den Start bleiben wir bei sync Antwort mit 500, damit meiti ggf. retryt.
    return res.status(500).json({
      error: 'processing_error',
      message: 'Error while syncing data to Fortytools'
    });
  }
}

module.exports = {
  handleMeitiWebhook
};

