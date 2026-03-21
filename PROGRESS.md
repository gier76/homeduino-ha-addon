# Homeduino HA Addon - Aufgabenliste

## Erledigt
- [x] `index.js` fixen (`homeduino.connect()` Fehler behoben).
- [x] Version in `config.yaml` auf `3.9.3` erhöht.
- [x] README.md aktualisiert.
- [x] GitHub Zugangsdaten gefunden.
- [x] Änderungen zu GitHub pushen (v3.9.3).
- [x] **Fancy Dark Theme mit Glow-Effekten** implementiert.
- [x] **Selektive Discovery** in GUI integriert.
- [x] **UID Anzeige in GUI** hinzugefügt.
- [x] UID-Logik massiv verbessert:
    - [x] Hash-basierte UIDs bei fehlender ID.
    - [x] Einbeziehung von `id`, `systemcode`, `unitcode` etc. in UID und Namen.
- [x] **Switch-Logik verbessert**:
    - [x] Korrekte Erkennung von `state` (on/off).
    - [x] Robustes Senden von Befehlen.

## Offen
- [ ] Addon in HA auf Version 3.9.3 aktualisieren (Warten auf HA Cache Update).
- [ ] GUI öffnen und Geräte hinzufügen (Namen sollten nun automatisch generiert werden).
- [ ] Humidity prüfen: Falls immer noch fehlend, Rohdaten-Analyse starten (Daten sind in den Logs sichtbar).
- [ ] Switches testen: Reagieren sie auf Befehle und Updates von extern?
- [ ] Diese Aufgabenliste pflegen bei Session-Abbruch.
