# Homeduino HA Addon - Aufgabenliste

## Erledigt
- [x] `index.js` fixen (`homeduino.connect()` Fehler behoben).
- [x] Version in `config.yaml` & `package.json` auf `5.1.5` erhöht.
- [x] README.md & Dokumentation aktualisiert.
- [x] **Fancy Dark Theme mit Glow-Effekten** implementiert.
- [x] **Selektive Discovery** ("In HA hinzufügen") in GUI integriert.
- [x] **UID Anzeige in GUI** hinzugefügt.
- [x] **UID-Logik massiv verbessert**:
    - Hash-basierte UIDs bei fehlender ID (MD5-basiert).
    - Einbeziehung von `id`, `systemcode`, `unitcode`, `unit`, `channel`, etc. in UID.
- [x] **Humidity Fix für weather2**:
    - Bits 28-35 erfolgreich als Luftfeuchtigkeit identifiziert.
    - Laufzeit-Patch für `rfcontroljs` implementiert, um `weather2` zu erweitern.
- [x] **Senden von Befehlen (MQTT Switches)**:
    - Encoding-Logik für alle Switch-Protokolle (`switch1`, `switch2`, `switch3`, `switch4`) vervollständigt.
    - 5-fache Signal-Wiederholung (burst mode) für zuverlässiges Schalten per 433MHz.
- [x] **Echtzeit Status-Badges in Web GUI**:
    - USB Hardware Connection Status mit glowing LED.
    - MQTT Broker Connection Status mit glowing LED.

## Offen
- Keine offenen Aufgaben. Das Projekt v5.1.5 ist vollständig einsatzbereit.

