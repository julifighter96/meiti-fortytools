# Konzept: Meiti-Events → Fortytools

Erweiterung der Webhook-Integration gemäß [meiti Webhook-Doku](https://meiti.app/docs/webhook).  
**Leitprinzipien:**
- **Keine leeren Daten** an Fortytools übertragen
- **Keine Kunden anlegen**, die keine sinnvollen Informationen haben

---

## 1. Meiti-Events Übersicht

| Event | Auslöser | Sinnvolle Fortytools-Aktion |
|-------|----------|-----------------------------|
| **Manual** | Manuell aus Projektdetails | Vollständiger Sync: Kunde suchen/anlegen, aktualisieren, Notiz |
| **IncomingCallLookup** | Eingehender Anruf | **Nur lesen** (Fortytools → meiti). Kein Schreiben nach Fortytools |
| **FinishedCall** | Anruf beendet | Notiz beim Kunden anlegen (Anruf protokollieren) |
| **NewConversation** | Chat nach 1h Pause wieder aktiv | Notiz beim Kunden (Chat re-engagiert) |
| **ConversationPaused** | 10 Min Chat-Inaktivität | Notiz beim Kunden (Chat pausiert / Follow-up-Marker) |

---

## 2. Pro-Event Verhalten

### Manual (bereits implementiert)
- **Aktion:** Kunde suchen oder anlegen, Stammdaten aktualisieren, Notiz anlegen
- **Sinn:** Benutzer triggert bewusst – voller Kontext vorhanden
- **Besonderheit:** Einziger Event, bei dem **neue Kunden angelegt** werden dürfen (mit Mindestdatenprüfung)

### IncomingCallLookup
- **Aktion:** **Keine Übertragung nach Fortytools**
- **Begründung:** Laut Doku dient dieser Event dazu, **Kontaktdaten aus dem CRM zu laden und an meiti zu übermitteln**. Die Richtung ist also Fortytools → meiti (READ), nicht meiti → Fortytools (WRITE).
- **Implementierung:** Optional: Suche in Fortytools per Rufnummer, Rückgabe an meiti im Response. Kein PATCH/POST an Fortytools.

### FinishedCall
- **Aktion:** Notiz beim Kunden anlegen (z.B. „Anruf beendet am …“)
- **Kunde finden:** Per Telefon/E-Mail suchen
- **Kunde anlegen:** **Nein** – beim Anrufende haben wir oft nur Rufnummer; zu wenig für einen neuen Kunden-Datensatz
- **Update:** Wenn Kunde gefunden wird und `contactData`/`projectData` sinnvolle zusätzliche Infos haben (nicht nur Rufnummer), dann optional Stammdaten-Update – aber nur wenn nicht-leere Felder vorhanden sind

### NewConversation
- **Aktion:** Notiz beim Kunden (z.B. „Chat wieder aufgenommen am …“)
- **Kunde finden:** Per Telefon/E-Mail/Name suchen
- **Kunde anlegen:** **Nur wenn Mindestdaten** erfüllt (siehe unten)
- **Update:** Wenn Kunde gefunden wird und neue/geänderte Stammdaten vorliegen → Update (nur gefüllte Felder)

### ConversationPaused
- **Aktion:** Notiz beim Kunden (z.B. „Chat pausiert nach 10 Min Inaktivität“)
- **Kunde finden:** Per Telefon/E-Mail suchen
- **Kunde anlegen:** **Nein** – Pause-Event ist ein schwaches Signal; keine neuen Kunden daraus
- **Update:** Wenn Kunde gefunden wird → optional Stammdaten-Update (nur bei nicht-leeren Daten)

---

## 3. Datenregeln

### 3.1 Nie leere Daten übertragen
- `undefined`, `null`, leere Strings `""` werden **nie** in Payloads für Fortytools geschickt
- Bestehende Logik: `buildCustomerPayloadFromMeiti` entfernt bereits leere Werte
- Zusätzlich: Vor jedem `updateCustomer` prüfen, ob nach Filterung noch mindestens ein Feld übrig ist

### 3.2 Mindestdaten für Neuanlage eines Kunden

Ein neuer Kunde wird **nur** angelegt, wenn:

1. **Mindestens ein Kontaktmerkmali**  
   `phone` ODER `mobile` ODER `email` (nicht leer)

2. **UND mindestens ein Namensmerkmal**  
   `company` ODER (`firstName` + `lastName`) ODER ein nicht-leerer `name`

Ohne diese Mindestdaten: **kein Kunde anlegen**, Event ignorieren oder nur Notiz bei bestehendem Kunden.

### 3.3 Mindestdaten für Update
- Mindestens **ein nicht-leeres Feld** nach Filterung
- Kein Update, wenn der Payload nach Bereinigung leer wäre

### 3.4 Mindestdaten für Notiz
- Notiz-Text muss **nicht leer** sein
- Format z.B.: `"[Event-Name] am [Datum/Uhrzeit]"` + optional weitere Inhalte (planning_info, crmInternalInfo etc.)

---

## 4. Zusammenfassung: Wann wird was nach Fortytools geschrieben?

| Event | Suche Kunde | Update Kunde | Notiz | Neuer Kunde |
|-------|-------------|--------------|-------|-------------|
| Manual | ja | ja (nur nicht-leere Felder) | ja | ja (wenn Mindestdaten) |
| IncomingCallLookup | nein (nur ggf. READ) | nein | nein | nein |
| FinishedCall | ja | optional (nur bei gefüllten Daten) | ja (wenn Kunde gefunden) | nein |
| NewConversation | ja | ja (wenn gefunden + Daten) | ja | ja (wenn Mindestdaten) |
| ConversationPaused | ja | optional (wenn gefunden + Daten) | ja (wenn Kunde gefunden) | nein |

---

## 5. Implementierungs-Hinweise

1. **Event-Erkennung:** `eventType` kann String oder Zahl sein; bekannte Werte prüfen:
   - `IncomingCallLookup` bzw. `0`
   - `FinishedCall` bzw. `1`
   - `NewConversation` bzw. `2`
   - `ConversationPaused` bzw. `3`
   - `Manual` bzw. `4`
2. **Hilfsfunktionen:**  
   - `hasMinimumDataForNewCustomer(contactData)`  
   - `hasDataForUpdate(payload)` (Payload nach build + Filterung)  
   - `buildNoteForEvent(eventType, contactData, projectData)`
3. **Antwort an meiti:**  
   - Bei `IncomingCallLookup`: ggf. `contactData` aus Fortytools zurückgeben (falls Lookup gemacht wird)  
   - Bei allen anderen: wie bisher `crmContactId` zurückgeben, wenn Kunde gefunden/angelegt wurde
