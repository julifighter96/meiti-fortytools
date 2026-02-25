const { fortytoolsClient } = require('./fortytoolsClient');
const { log } = require('./logger');

// Event-Typen (eventType kann String oder Zahl sein)
const EVENTS = {
  // Meiti-Events:
  // 0: IncomingCallLookup
  // 1: FinishedCall
  // 2: NewConversation
  // 3: ConversationPaused
  // 4: Manual
  MANUAL: ['Manual', 4, '4'],
  INCOMING_CALL_LOOKUP: ['IncomingCallLookup', 0, '0'],
  FINISHED_CALL: ['FinishedCall', 1, '1'],
  NEW_CONVERSATION: ['NewConversation', 2, '2'],
  CONVERSATION_PAUSED: ['ConversationPaused', 3, '3']
};

function isEvent(eventType, eventNames) {
  return eventNames.includes(eventType);
}

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip spaces, dashes, brackets etc. Keep leading +
  return raw.replace(/[^+\d]/g, '');
}

/** Prüft, ob contactData Mindestdaten für Neuanlage hat: Kontakt (phone/mobile/email) + Name (company oder firstName+lastName) */
function hasMinimumDataForNewCustomer(contactData) {
  if (!contactData) return false;
  const phone = normalizePhone(contactData.phoneNumber);
  const mobile = normalizePhone(contactData.mobileNumber || contactData.mobile || '');
  const email = (contactData.email || '').trim();
  const hasContact = !!(phone || mobile || email);
  const company = (contactData.company || '').trim();
  const firstName = (contactData.firstName || '').trim();
  const lastName = (contactData.lastName || '').trim();
  const hasName = !!(company || (firstName && lastName));
  return hasContact && hasName;
}

/** Prüft, ob Payload mindestens ein nicht-leeres, sinnvolles Feld für Update hat (außer customer_state). */
function hasDataForUpdate(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const skipKeys = ['customer_state_id', 'customer_state'];
  return Object.keys(payload).some((k) => !skipKeys.includes(k) && payload[k] != null && payload[k] !== '');
}

/** Notiz-Text je nach Event-Typ */
function buildNoteForEvent(eventType, contactData, projectData) {
  const ts = new Date().toLocaleString('de-DE');
  const planning = (projectData && (projectData.currentSummary || projectData.inquirySummary)) ||
    (contactData && contactData.crmInternalInfo);
  const planningStr = planning && String(planning).trim() ? `\n\n${String(planning).trim()}` : '';

  if (isEvent(eventType, EVENTS.MANUAL)) {
    return `Meiti-Übertragung am ${ts}${planningStr}`;
  }
  if (isEvent(eventType, EVENTS.FINISHED_CALL)) {
    return `Anruf beendet am ${ts}${planningStr}`;
  }
  if (isEvent(eventType, EVENTS.NEW_CONVERSATION)) {
    return `Chat wieder aufgenommen am ${ts}${planningStr}`;
  }
  if (isEvent(eventType, EVENTS.CONVERSATION_PAUSED)) {
    return `Chat pausiert nach 10 Min Inaktivität am ${ts}${planningStr}`;
  }
  return `Meiti-Event am ${ts}${planningStr}`;
}

function buildCustomerPayloadFromMeiti(contactData, projectData, customerStateId) {
  if (!contactData) contactData = {};
  if (!projectData) projectData = {};

  const phone = normalizePhone(contactData.phoneNumber);
  const mobile = normalizePhone(contactData.mobileNumber || contactData.mobile || '');

  // Decide what to use as main "name" in Fortytools:
  // Prefer company, otherwise "first last".
  let name = contactData.company;
  if (!name && (contactData.firstName || contactData.lastName)) {
    name = `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim();
  }

  // Fortytools Pflichtfeld: customer_state_id + customer_state (ID aus API, sonst Fallback 1)
  const stateId = customerStateId != null ? Number(customerStateId) : 1;
  const customerState = { id: stateId };

  // shortinfo und planning_info werden nicht am Kunden gesetzt (Einsatzort-/Kurzinfo-Notizen in Fortytools).
  // Die Meiti-Inhalte gehen nur in die Event-Notiz (createCustomerNote).
  const payload = {
    email: contactData.email || undefined,
    phone: phone || undefined,
    mobile: (mobile || phone) || undefined,
    first_name: contactData.firstName || undefined,
    last_name: contactData.lastName || undefined,
    name: name || undefined,
    customer_state_id: stateId,
    customer_state: customerState,
    street: contactData.addressLine1 || projectData.address || undefined,
    zip: contactData.postCode || projectData.postcode || undefined,
    city: contactData.city || projectData.city || undefined,
    custom_attributes: {}
  };
  if (contactData.meitiContactId != null) payload.custom_attributes.meiti_contact_id = contactData.meitiContactId;
  if (projectData.meitiProjectId != null) payload.custom_attributes.meiti_project_id = projectData.meitiProjectId;
  if (Object.keys(payload.custom_attributes).length === 0) delete payload.custom_attributes;

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
    isEvent(eventType, EVENTS.MANUAL) ||
    isEvent(eventType, EVENTS.INCOMING_CALL_LOOKUP) ||
    isEvent(eventType, EVENTS.FINISHED_CALL) ||
    isEvent(eventType, EVENTS.NEW_CONVERSATION) ||
    isEvent(eventType, EVENTS.CONVERSATION_PAUSED);

  log({
    level: 'info',
    message: 'meiti_webhook_received',
    requestId,
    eventType,
    phoneNumber: contactData && contactData.phoneNumber,
    meitiContactId: contactData && contactData.meitiContactId,
    meitiProjectId: projectData && projectData.meitiProjectId
  });

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
      supportedEventTypes: ['Manual', 'IncomingCallLookup', 'FinishedCall', 'NewConversation', 'ConversationPaused']
    });
  }

  // IncomingCallLookup: Nur Lesen (Fortytools → meiti), kein Schreiben
  if (isEvent(eventType, EVENTS.INCOMING_CALL_LOOKUP)) {
    try {
      let responseBody = { requestContactUpdate: false, requestProjectUpdate: false };
      if (contactData) {
        const phone = normalizePhone(contactData.phoneNumber);
        const mobile = normalizePhone(contactData.mobileNumber || contactData.mobile || '');
        const customerId = await fortytoolsClient.findCustomerByContact({
          phone,
          mobile: mobile || undefined,
          email: contactData.email,
          requestId
        });
        if (customerId != null) {
          responseBody = {
            requestContactUpdate: true,
            contactData: { crmContactId: String(customerId), crmAiInfo: 'Fortytools-Kontakt gefunden' },
            requestProjectUpdate: false
          };
          log({ level: 'info', message: 'incoming_call_lookup_customer_found', requestId, customerId });
        }
      }
      return res.status(200).json(responseBody);
    } catch (err) {
      log({ level: 'error', message: 'incoming_call_lookup_error', requestId, error: err && err.message });
      return res.status(200).json({ requestContactUpdate: false, requestProjectUpdate: false });
    }
  }

  // Alle anderen Events brauchen contactData (mindestens zum Suchen)
  if (!contactData) {
    log({ level: 'warn', message: 'missing_contact_data', requestId });
    return res.status(400).json({
      error: 'invalid_payload',
      message: 'contactData is required'
    });
  }

  const phone = normalizePhone(contactData.phoneNumber);
  const mobile = normalizePhone(contactData.mobileNumber || contactData.mobile || '');
  const email = (contactData.email || '').trim();
  const crmCustomerIdRaw = contactData.crmContactId;
  const crmCustomerId =
    crmCustomerIdRaw != null && String(crmCustomerIdRaw).trim() !== ''
      ? Number(crmCustomerIdRaw)
      : null;

  const mayCreateNewCustomer =
    isEvent(eventType, EVENTS.MANUAL) || isEvent(eventType, EVENTS.NEW_CONVERSATION);
  const hasSearchTerm = phone || mobile || email;

  if (!crmCustomerId && !hasSearchTerm) {
    log({ level: 'info', message: 'meiti_event_skipped_no_identifier', requestId, eventType });
    return res.status(200).json({
      requestContactUpdate: false,
      requestProjectUpdate: false,
      message: 'No crmContactId, phone or email to identify customer'
    });
  }

  try {
    let customerId = crmCustomerId;

    if (!customerId && hasSearchTerm) {
      customerId = await fortytoolsClient.findCustomerByContact({
        phone,
        mobile: mobile || undefined,
        email: email || undefined,
        requestId
      });
    }

    await fortytoolsClient.ensureCustomerStatesLoaded(requestId);
    const customerStateId = fortytoolsClient.getDefaultCustomerStateId() ?? 1;
    log({
      level: 'info',
      message: 'fortytools_customer_state_used',
      requestId,
      customerStateId,
      availableStates: fortytoolsClient._customerStatesCache?.length ?? 0
    });

    const customerPayload = buildCustomerPayloadFromMeiti(contactData, projectData, customerStateId);

    if (customerId) {
      log({ level: 'info', message: 'existing_customer_found', requestId, customerId });

      // Bei allen Events wie Manual: alle aus meiti erhaltenen Daten übertragen (Payload enthält nur nicht-leere Felder).
      if (Object.keys(customerPayload).length > 0) {
        await fortytoolsClient.updateCustomer(customerId, customerPayload, requestId);
      }

      const noteContent = buildNoteForEvent(eventType, contactData, projectData);
      if (noteContent && String(noteContent).trim()) {
        try {
          await fortytoolsClient.createCustomerNote(customerId, noteContent.trim(), requestId);
          log({ level: 'info', message: 'customer_note_created', requestId, customerId });
        } catch (noteErr) {
          log({ level: 'warn', message: 'customer_note_failed', requestId, customerId, error: noteErr && noteErr.message });
        }
      }
    } else if (mayCreateNewCustomer && hasMinimumDataForNewCustomer(contactData)) {
      log({ level: 'info', message: 'creating_new_customer', requestId });
      customerId = await fortytoolsClient.createCustomer(customerPayload, requestId);
      log({ level: customerId != null ? 'info' : 'warn', message: 'customer_created', requestId, customerId });

      if (customerId != null) {
        const noteContent = buildNoteForEvent(eventType, contactData, projectData);
        if (noteContent && String(noteContent).trim()) {
          try {
            await fortytoolsClient.createCustomerNote(customerId, noteContent.trim(), requestId);
          } catch (_) {}
        }
      } else {
        log({
          level: 'error',
          message: 'customer_created_but_id_missing',
          requestId,
          hint: 'POST /customers war erfolgreich, aber die Kunden-ID konnte nicht ermittelt werden.'
        });
        return res.status(500).json({
          error: 'processing_error',
          message: 'Kunde wurde in Fortytools angelegt, Verknüpfung konnte nicht abgeschlossen werden (ID fehlt).'
        });
      }
    } else {
      log({
        level: 'info',
        message: 'meiti_event_no_customer_action',
        requestId,
        eventType,
        reason: customerId == null && !hasMinimumDataForNewCustomer(contactData)
          ? 'no_existing_customer_and_insufficient_data_for_create'
          : 'customer_not_found'
      });
      return res.status(200).json({
        requestContactUpdate: false,
        requestProjectUpdate: false,
        message: 'Customer not found and insufficient data for new customer (need phone/email + name)'
      });
    }

    const responseBody = {
      requestContactUpdate: true,
      contactData: { crmContactId: String(customerId), crmAiInfo: 'Fortytools Kunde verknüpft' },
      requestProjectUpdate: false
    };
    log({ level: 'info', message: 'meiti_response_payload', requestId, responseBody });
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

