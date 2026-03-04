const axios = require('axios');
const { log } = require('./logger');

const FORTYTOOLS_BASE_URL = process.env.FORTYTOOLS_BASE_URL || 'https://app.fortytools.com/api/v2';

class FortytoolsClient {
  constructor() {
    this.token = null;
    this.tokenExpiresAt = 0;
    this._customerStatesCache = null;
  }

  /** GET /customer_states – Liste der Kundenstatus (z. B. Lead, Kunde). Zum Testen und für gültige IDs. */
  async getCustomerStates(requestId) {
    const data = await this.request('GET', '/customer_states', {
      requestId,
      params: { limit: 50 }
    });
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    return list;
  }

  /** Lädt einmalig die Kundenstatus und cached sie. */
  async ensureCustomerStatesLoaded(requestId) {
    if (this._customerStatesCache !== null) return this._customerStatesCache;
    const list = await this.getCustomerStates(requestId);
    this._customerStatesCache = list;
    return list;
  }

  /**
   * Wählt den Default-Kundenstatus für neue Kunden.
   * Wunsch: Immer „KUNDE‼️“ (id 32774 in deinem System), falls vorhanden.
   * Reihenfolge:
   * 1. State mit id === 32774
   * 2. State, dessen Name „KUNDE‼️“ enthält
   * 3. Fallback: erster Eintrag aus der Liste
   */
  getDefaultCustomerStateId() {
    if (!this._customerStatesCache || this._customerStatesCache.length === 0) return null;

    const byName = (needle) =>
      this._customerStatesCache.find(
        (s) =>
          s &&
          typeof s.name === 'string' &&
          s.name.toLowerCase().includes(needle.toLowerCase())
      );

    // 1. „KUNDE‼️“ mit fixer ID (32774)
    let chosen = this._customerStatesCache.find((s) => s && Number(s.id) === 32774);
    // 2. Fallback: irgendein State mit Namen „KUNDE‼️“
    if (!chosen) chosen = byName('KUNDE‼️');
    // 3. Fallback: erster Eintrag
    if (!chosen) chosen = this._customerStatesCache[0];

    return chosen && chosen.id !== undefined ? Number(chosen.id) : null;
  }

  async ensureAccessToken(requestId) {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 30_000) {
      return this.token;
    }

    const clientId = process.env.FORTYTOOLS_CLIENT_ID;
    const clientSecret = process.env.FORTYTOOLS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const missing = [];
      if (!clientId) missing.push('FORTYTOOLS_CLIENT_ID');
      if (!clientSecret) missing.push('FORTYTOOLS_CLIENT_SECRET');
      throw new Error(`Fortytools credentials missing. Set in Railway Variables: ${missing.join(', ')}`);
    }

    try {
      log({
        level: 'info',
        message: 'fortytools_token_request',
        requestId
      });

      const resp = await axios.post(`${FORTYTOOLS_BASE_URL}/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      }, {
        timeout: 5000
      });

      const data = resp.data;
      this.token = data.access_token;
      const expiresInSeconds = data.expires_in || 3600;
      this.tokenExpiresAt = now + expiresInSeconds * 1000;

      log({
        level: 'info',
        message: 'fortytools_token_obtained',
        requestId,
        expiresInSeconds
      });

      return this.token;
    } catch (err) {
      log({
        level: 'error',
        message: 'fortytools_token_error',
        requestId,
        error: err && err.message,
        responseStatus: err.response && err.response.status,
        responseData: err.response && err.response.data
      });
      throw new Error('Failed to obtain Fortytools access token');
    }
  }

  async request(method, path, { requestId, params, data } = {}) {
    const token = await this.ensureAccessToken(requestId);

    const url = `${FORTYTOOLS_BASE_URL}${path}`;

    if (data != null) {
      log({
        level: 'info',
        message: 'fortytools_request_body',
        requestId,
        method,
        path,
        body: data
      });
    }

    try {
      const resp = await axios.request({
        method,
        url,
        params,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      return resp.data;
    } catch (err) {
      const status = err.response && err.response.status;
      const responseData = err.response && err.response.data;
      log({
        level: 'error',
        message: 'fortytools_request_error',
        requestId,
        method,
        url,
        ...(data != null ? { requestBody: data } : {}),
        error: err && err.message,
        responseStatus: status,
        responseData
      });
      if (status === 422 && responseData && responseData.errors) {
        log({
          level: 'error',
          message: 'fortytools_validation_errors',
          requestId,
          validationErrors: responseData.errors
        });
      }
      throw err;
    }
  }

  /**
   * Sucht einen bestehenden Kunden in Fortytools.
   * Prüft nacheinander: Telefon (phone), Mobil (mobile), E-Mail.
   * API: GET /search/global?q=<term>&types=Customer – durchsucht u. a. phone- und mobile-Felder.
   */
  async findCustomerByContact({ phone, mobile, email, requestId }) {
    const terms = [phone, mobile, email].filter(Boolean);
    const seen = new Set();
    for (const term of terms) {
      const key = String(term).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const data = await this.request('GET', '/search/global', {
        requestId,
        params: {
          q: key,
          types: 'Customer'
        }
      });

      if (!Array.isArray(data) || data.length === 0) continue;

      const entry = data[0];
      if (entry.searchable_type !== 'Customer') continue;

      return entry.searchable_id;
    }
    return null;
  }

  /**
   * Sucht einen bestehenden Mitarbeiter (StaffMember) in Fortytools.
   * Prüft nacheinander: Telefon (phone), Mobil (mobile), E-Mail.
   * API: GET /search/global?q=<term>&types=StaffMember.
   * Wird genutzt, um zu verhindern, dass für Mitarbeiter fälschlich Kunden angelegt werden.
   */
  async findStaffMemberByContact({ phone, mobile, email, requestId }) {
    const terms = [phone, mobile, email].filter(Boolean);
    const seen = new Set();
    for (const term of terms) {
      const key = String(term).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const data = await this.request('GET', '/search/global', {
        requestId,
        params: {
          q: key,
          types: 'StaffMember'
        }
      });

      if (!Array.isArray(data) || data.length === 0) continue;

      const entry = data[0];
      if (entry.searchable_type !== 'StaffMember') continue;

      return entry.searchable_id;
    }
    return null;
  }

  async getCustomer(customerId, requestId) {
    return this.request('GET', `/customers/${customerId}`, { requestId });
  }

  async createCustomer(customerPayload, requestId) {
    const response = await this.request('POST', '/customers', {
      requestId,
      data: customerPayload
    });

    // Viele APIs liefern bei 201 den angelegten Datensatz inkl. id – zuerst nutzen.
    const idFromResponse =
      response && (response.id !== undefined)
        ? Number(response.id)
        : response && response.data && (response.data.id !== undefined)
          ? Number(response.data.id)
          : null;
    if (idFromResponse != null) {
      log({
        level: 'info',
        message: 'fortytools_customer_created_from_response',
        requestId,
        customerId: idFromResponse
      });
      return idFromResponse;
    }

    // Fallback: Suche per Telefon, Mobil, E-Mail (Suchindex kann verzögert sein).
    let customerId = await this.findCustomerByContact({
      phone: customerPayload.phone,
      mobile: customerPayload.mobile,
      email: customerPayload.email,
      requestId
    });
    if (customerId != null) {
      log({
        level: 'info',
        message: 'fortytools_customer_id_from_search',
        requestId,
        customerId
      });
      return customerId;
    }

    // Einmal mit Verzögerung erneut suchen (Suchindex-Update).
    await new Promise((r) => setTimeout(r, 1000));
    customerId = await this.findCustomerByContact({
      phone: customerPayload.phone,
      mobile: customerPayload.mobile,
      email: customerPayload.email,
      requestId
    });
    if (customerId != null) {
      log({
        level: 'info',
        message: 'fortytools_customer_id_from_search_retry',
        requestId,
        customerId
      });
      return customerId;
    }

    log({
      level: 'warn',
      message: 'fortytools_customer_created_but_id_unknown',
      requestId,
      postResponseKeys: response ? Object.keys(response) : []
    });
    return null;
  }

  async updateCustomer(customerId, customerPayload, requestId) {
    await this.request('PATCH', `/customers/${customerId}`, {
      requestId,
      data: customerPayload
    });
  }

  /**
   * Erstellt eine Notiz/Timeline-Eintrag beim bestehenden Kunden (z. B. bei Meiti-Übertragung).
   * Verwendet das Event-Schema aus fortytools.yaml:
   * - title: string
   * - body: string
   * - date: string (Format YYYY-MM-DD)
   * - eventable_type: 'Customer'
   * - eventable_id: Kunden-ID
   */
  async createCustomerNote(customerId, noteText, requestId) {
    if (!noteText || String(noteText).trim() === '') return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const body = {
      title: 'Meiti-Übertragung',
      body: String(noteText).trim(),
      date: today,
      eventable_type: 'Customer',
      eventable_id: Number(customerId)
    };
    await this.request('POST', '/events', {
      requestId,
      data: body
    });
  }

  async findOrCreateFacilityForCustomer(customerId, facilityPayload, requestId) {
    // List facilities for this customer and see if there is already one with same name or address
    const facilities = await this.request('GET', `/customers/${customerId}/facilities`, {
      requestId,
      params: {
        offset: 0,
        limit: 50
      }
    });

    if (Array.isArray(facilities)) {
      const existing = facilities.find((f) => {
        const sameName = facilityPayload.name && f.name === facilityPayload.name;
        const sameStreet = facilityPayload.street && f.street === facilityPayload.street;
        const sameZip = facilityPayload.zip && f.zip === facilityPayload.zip;
        const sameCity = facilityPayload.city && f.city === facilityPayload.city;
        return sameName || (sameStreet && sameZip && sameCity);
      });

      if (existing) {
        return existing.id;
      }
    }

    await this.request('POST', `/customers/${customerId}/facilities`, {
      requestId,
      data: facilityPayload
    });

    // Re-fetch to get ID
    const facilitiesAfter = await this.request('GET', `/customers/${customerId}/facilities`, {
      requestId,
      params: {
        offset: 0,
        limit: 50
      }
    });

    if (Array.isArray(facilitiesAfter)) {
      const created = facilitiesAfter.find((f) => f.name === facilityPayload.name);
      if (created) return created.id;
    }

    return null;
  }
}

const fortytoolsClient = new FortytoolsClient();

module.exports = {
  fortytoolsClient
};

