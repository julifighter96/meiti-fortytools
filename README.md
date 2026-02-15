## Meiti ↔ Fortytools Webhook-Service

Dieser kleine Node/Express-Service stellt einen Webhook-Endpoint bereit, den du in meiti als **Webhook Integration** hinterlegen kannst, um Kontakte und Projekte automatisiert mit Fortytools zu synchronisieren.

Die Implementierung orientiert sich an der meiti Webhook-Doku (`https://www.meiti.io/docs/webhook`) und der Fortytools OpenAPI-Spezifikation (`fortytools.yaml`).

### Funktionsumfang (Stand jetzt)

- **Endpoint**: `POST /meiti/webhook`
- **Verarbeitete Events** (gemäß [meiti Webhook-Doku](https://meiti.app/docs/webhook)):

  | Event | Aktion nach Fortytools |
  |-------|------------------------|
  | **Manual** | Vollständiger Sync: Kunde suchen/anlegen, Update, Notiz |
  | **IncomingCallLookup** | Nur Lesen – Kunde per Rufnummer suchen und `crmContactId` an meiti zurückgeben (kein Schreiben) |
  | **FinishedCall** | Kunde suchen, Notiz „Anruf beendet“, optional Update (kein neuer Kunde) |
  | **NewConversation** | Kunde suchen/anlegen, Update, Notiz „Chat wieder aufgenommen“ |
  | **ConversationPaused** | Kunde suchen, Notiz „Chat pausiert“, optional Update (kein neuer Kunde) |

- **Datenregeln**: Es werden nie leere Daten übertragen. Neue Kunden werden nur angelegt, wenn mindestens ein Kontakt (Telefon/E-Mail) und ein Name (Firma oder Vor-/Nachname) vorliegen. Details siehe `docs/EVENT-KONZEPT.md`.
- **Ablauf**:
  - Validierung des Bearer-Tokens aus dem `Authorization` Header (muss mit `MEITI_WEBHOOK_TOKEN` übereinstimmen)
  - Lesen von `contactData` und `projectData` aus dem meiti Payload
  - **Kunden-Suche in Fortytools**:
    - Telefonnummer wird normalisiert (nur `+` und Ziffern)
    - Suche via `/search/global?q=<phone>&types=Customer` (Fallback auf E-Mail möglich)
  - **Kunde in Fortytools**:
    - Wenn gefunden → `PATCH /customers/{id}` mit aktualisierten Stammdaten
    - Wenn nicht gefunden → `POST /customers` mit aus meiti gemappten Daten, inkl. `custom_attributes.meiti_contact_id` / `meiti_project_id`
  - **Projekt / Objekt in Fortytools**:
    - Da die API kein explizites `/projects`-Endpoint anbietet, wird das Projekt als **Facility** (`/customers/{customer_id}/facilities`) hinterlegt:
      - `projectName` → `Facility.name`
      - `address` → `Facility.street`
      - `postcode` → `Facility.zip`
      - `city` → `Facility.city`
    - Es wird versucht, bestehende Facilities mit gleichem Namen bzw. gleicher Adresse zu erkennen.
  - **Antwort an meiti** (Option 1 – direkte Antwort, `200 OK`):
    - `crmContactId` = Fortytools `customer_id` (als String)
    - `crmProjectId` = Facility-ID (als String), falls eine Facility erzeugt / gefunden wurde

Beispiel-Response an meitis:

```json
{
  "requestContactUpdate": true,
  "contactData": {
    "crmContactId": "123",
    "crmAiInfo": "Fortytools Kunde verknüpft"
  },
  "requestProjectUpdate": true,
  "projectData": {
    "crmProjectId": "456",
    "crmAiInfo": "Fortytools Projekt/Objekt (Facility) verknüpft"
  }
}
```

### Konfiguration

Lege eine `.env`-Datei im Projekt-Root an (siehe `.env.example`):

```bash
cp .env.example .env
```

Setze dann:

- `MEITI_WEBHOOK_TOKEN` – denselben Token trägst du in der meiti App in der Webhook-Konfiguration als Bearer-Token ein.
- `FORTYTOOLS_CLIENT_ID` / `FORTYTOOLS_CLIENT_SECRET` – OAuth-Client-Credentials aus Fortytools.
- Optional `PORT` – Standard ist `3000`.

### Lokal starten

```bash
npm install
npm run dev
```

Der Service lauscht dann z.B. auf `http://localhost:3000`.

- Healthcheck: `GET /health`
- Webhook: `POST /meiti/webhook`

### Testen: Kundenstatus (customer_state)

Damit neue Kunden in Fortytools angelegt werden können, muss ein gültiger **Kundenstatus** (customer_state) mitgeschickt werden. Der Service lädt die verfügbaren Status einmalig von der Fortytools-API und verwendet automatisch den **ersten Eintrag** als Standard.

**Debug-Endpoint (nach Deploy oder lokal):**

```text
GET /debug/fortytools-customer-states
```

- Liefert die Liste aller Kundenstatus aus Fortytools (inkl. IDs und Namen).
- Zeigt `default_id`: die ID, die der Webhook aktuell für neue Kunden verwendet.
- Aufruf z.B. im Browser: `https://dein-service.up.railway.app/debug/fortytools-customer-states`

So siehst du, welche IDs in deiner Fortytools-Instanz existieren und ob der automatisch gewählte Status passt. Bei jedem Webhook-Aufruf wird zudem geloggt: `fortytools_customer_state_used` mit `customerStateId` und der Anzahl der geladenen Status.

### Deployment bei Railway (Kurzüberblick)

1. Neues Projekt bei Railway anlegen und dieses Git-Repository verbinden.
2. Als Start-Command `npm start` verwenden (ist im `package.json` hinterlegt).
3. In Railway im Projekt unter **Variables** folgende Umgebungsvariablen setzen:
   - `MEITI_WEBHOOK_TOKEN`
   - `FORTYTOOLS_CLIENT_ID`
   - `FORTYTOOLS_CLIENT_SECRET`
   - Optional `PORT` (Railway setzt typischerweise selbst `PORT`, Express nutzt diese automatisch).
4. Nach dem Deploy die öffentliche URL von Railway in meiti bei
   `Einstellungen > Betrieb > CRM Synchronisation > Webhook`
   als Webhook-URL eintragen, z.B.
   `https://dein-railway-service.up.railway.app/meiti/webhook`.
5. In meiti denselben `MEITI_WEBHOOK_TOKEN` als Bearer-Token konfigurieren.

### Logging

- Jeder Request wird mit `requestId`, Pfad, Statuscode und Dauer als JSON in `stdout` geschrieben (Railway Logs).
- Zusätzlich wird eine Logdatei unter `logs/app.log` im Container gepflegt (nützlich lokal; in Railway ist das Dateisystem flüchtig).

### Weiterentwicklungsideen

- Bessere Duplikat-Erkennung (z.B. zusätzliche Suche nach Namen + PLZ).
- Bidirektionale Synchronisation über Fortytools eigene WebHooks (`/web_hooks` in der Fortytools API).

