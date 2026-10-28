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

## v5.1.9 (2026-10-28)
- [x] **Kompletter rfcontroljs-Stack vendored** (`vendor/controller.js`, `vendor/helper.js`, `vendor/protocols/` — 87 Protokolle aus pimatic/rfcontroljs v0.0.61). Das npm-Paket `rfcontroljs@0.0.10` (vom Dockerfile installiert) kannte nur 9 Protokolle und kein `pulseCounts` — Empfang/Senden für switch5-33, dimmer, shutter, awning, contact, pir2-6, led, doorbell, alarm, weather4-21, rawswitch/rawshutter, rolling1, generic2 fehlte komplett. Dependency `rfcontroljs` aus package.json entfernt.
- [x] **MQTT Discovery erweitert**: Weather-Sensoren (Temp/Humidity/Wind/Regen/Druck/Helligkeit/CO2), Battery-Binary-Sensor, PIR→motion, contact→door, alarm, doorbell, dimmer→Light (mit Brightness, dimlevel 1..15 via HA brightness 0..255 / 17).
- [x] **JSON-Command-Payload für HA-Lights** (`{"state":"ON","brightness":191}`) in der MQTT-Command-Verarbeitung unterstützt.
- [x] **Verifiziert gegen Upstream-Testfixtures**: 259/291 Decode-Fixtures OK (Rest: `switch34`, existiert im publizierten 0.0.61-Tarball nicht), 27/27 Encode-Fixtures OK, Encode→Decode-Roundtrip 26/27 (rolling1: Roundtrip-Vergleich der Feldnamen bei Rolling-Code-Protokollen expected-verschoben, Encoding selbst korrekt).

## v5.1.10 (2026-10-28)
- [x] **Auto-Discovery pro empfangenem Signal**: `sendDiscoveryConfig()` aus dem GUI-Handler extraktiert; jedes dekodierte Signal publiziert einmal pro Containerlauf seine Discovery-Config (Light/Switch/Sensor/Binary-Sensor/Battery). Entitäten folgen damit den live `hd_...`-Topics statt nur statischen knownDevices/GUI-Klicks.
- [x] **Discovery auch per MQTT-Command**: ein Command für ein noch nicht empfangenes Gerät erzeugt die Config sofort (`[AUTO-DISCOVERY] ... from command`).
- [x] **Dimmer-State abgeleitet**: dimmer-Protokolle melden nur `dimlevel` — der state-Topic wird aus `dimlevel > 0` publiziert, damit die HA-Light-Entity den On/Off-State live sieht.
- [x] **Dimmer Brightness für HA Legacy-Lights**: Discovery-Config bekommt `brightness_command_topic` (`.../brightness`) + `brightness_scale 255`; HA sendet plain brightness 0..255 dorthin, Bridge mappt `floor(brightness/17)` → dimlevel 1..15. Der Listener ist zu `sendRfCommand()` refaktoriert und bedient `/set` (plain + JSON-Payload) und `/brightness`.

## v5.1.11 (2026-10-28)
- [x] **Legacy-Light Param-Fix**: `brightness_topic` → `brightness_state_topic` (HA Legacy-MQTT-Light kennt nur brightness_state_topic; brightness war sonst read-only unsupported → `light.turn_on` mit brightness wurde mit 400 abgelehnt). VERSION-Konstante in index.js mitgebumpet (Config-Payloads zeigen jetzt korrekt 5.1.11).

## v5.1.12 (2026-10-28)
- [x] **brightness_template Jinja-Fix**: `{{ value * 17 }}` multiplizierte den Payload-String (Jinja-Stringverdopplung → Renderfehler → HA zeigte Roh-dimlevel). Jetzt `{{ (value | float(0) * 17) | int }}` (mit HA ha_eval_template verifiziert: "1" → 17).

## v5.1.13 (2026-10-28)
- [x] **brightness_value_template statt brightness_template**: HA Doku (light.mqtt default schema) — `brightness_template` verarbeitet Command-Payloads, für den State-Topic ist `brightness_value_template` der richtige Parameter. Brightness-Display zeigte weiterhin Roh-dimlevel, jetzt korrekt dimlevel*17.

