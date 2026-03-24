# Homeduino HA Addon - Aufgabenliste

## Erledigt
- [x] `index.js` fixen (`homeduino.connect()` Fehler behoben).
- [x] Version in `config.yaml` auf `5.0.2` erhöht.
- [x] README.md aktualisiert.
- [x] **Fancy Dark Theme mit Glow-Effekten** implementiert (v5.0.2).
- [x] **Selektive Discovery** ("In HA hinzufügen") in GUI integriert.
- [x] **UID Anzeige in GUI** hinzugefügt.
- [x] **UID-Logik massiv verbessert**:
    - [x] Hash-basierte UIDs bei fehlender ID (MD5-basiert).
    - [x] Einbeziehung von `id`, `systemcode`, `unitcode` etc. in UID.
- [x] **Humidity Fix für weather2**:
    - [x] Bits 28-35 erfolgreich als Luftfeuchtigkeit identifiziert.
    - [x] Laufzeit-Patch für `rfcontroljs` implementiert, um `weather2` zu erweitern.
- [x] **Bridge Server v5.0.2** Start-Logs korrigiert.

## Offen
- [ ] Addon in HA neu installieren (Docker-Cache leeren).
- [ ] GUI testen: Werden Luftfeuchtigkeitswerte für alle Sensoren korrekt angezeigt?
- [ ] MQTT Discovery validieren: Erscheinen die Geräte in HA nach Klick auf "Add to HA"?
- [ ] Senden von Befehlen (Switches) finalisieren (Encoding-Logik fehlt noch im Backend).
- [ ] Diese Aufgabenliste pflegen bei Session-Abbruch.
