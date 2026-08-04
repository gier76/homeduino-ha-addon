# Projekt-Status: Homeduino Bridge (v5.1.5)

## Erledigte Punkte in v5.1.5
- [x] **Senden mit MQTT Switch gefixt**:
  - Vollständiges Mapping aller Protocol-Values (`unit`, `channel`, `id`, `houseCode`, `unitCode`, `systemcode`, `unitcode`, `all`).
  - Groß-/Kleinschreibungs-Toleranz bei `payload_on` / `payload_off` (`true`, `on`, `1`).
  - 5-fache Signal-Wiederholung (burst send with 40ms interval) für hohe 433MHz-Reichweite & Zuverlässigkeit.
- [x] **Empfangen MQTT Switch gefixt**:
  - `v.unit` und `v.channel` in die UID-Generierung aufgenommen (`hd_switch1_12_3_single`).
  - Korrekte Statusübertragung in MQTT (`homeduino/<protocol>/<uid>/state`).
- [x] **GUI MQTT Connected Status-Badge hinzugefügt**:
  - Glowing LED-Statusanzeige in der GUI für den MQTT Broker Status (Grün: Connected, Rot: Disconnected).
- [x] **GUI USB Connected Status-Badge hinzugefügt**:
  - Glowing LED-Statusanzeige für den Serien-Port USB Hardware Status (Grün: Connected, Rot: Disconnected).

## Status
- Weather Devices GUI & MQTT: I.O
- Switch Devices GUI & MQTT: I.O
- Senden & Empfangen MQTT Switch: I.O
- Status-Anzeigen (USB & MQTT) in Web GUI: I.O

