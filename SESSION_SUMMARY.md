# Projekt-Status: Homeduino Bridge (v5.0.2)

## Letzter Stand
- **Humidity Fix für weather2**: Die Luftfeuchtigkeits-Bytes wurden in den RAW-Daten (Bits 28-35) identifiziert. Ein Laufzeit-Patch für `rfcontroljs` wurde in `index.js` integriert, um die Feuchtigkeit automatisch zu extrahieren.
- **Improved UID Logic**: Die UIDs werden nun aus ID, Systemcode oder Unitcode generiert. Falls diese fehlen, wird ein 6-stelliger MD5-Hash aus dem Protokoll und den RAW-Daten erzeugt, um Kollisionen zu vermeiden.
- **Fancy UI (v5.0.2)**: Ein modernes "Cyberpunk" Dark Theme mit Glow-Effekten wurde implementiert. 
- **Selective Discovery**: Die GUI verfügt nun über einen "In HA hinzufügen" Button, der bei Klick eine MQTT-Discovery-Nachricht an Home Assistant sendet (Temperatur, Luftfeuchtigkeit und Schalter).
- **Update auf v5.0.2**: Versionen in `package.json`, `config.yaml` und den Start-Logs wurden konsolidiert.

## Todo für die nächste Sitzung
1. Add-on in Home Assistant neu installieren (Docker-Cache leeren).
2. Start-Logs auf "Bridge Server v5.0.2" prüfen.
3. GUI testen: Erscheinen die Luftfeuchtigkeitswerte nun korrekt in den Cards?
4. "Add to HA" testen: Werden die Geräte in der HA-Integration "MQTT" korrekt angelegt?
5. Sende-Logik für Schalter (Encoden der MQTT-Befehle zurück an Serial) implementieren.
