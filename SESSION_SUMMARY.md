# Projekt-Status: Homeduino Bridge (v5.0.1)

## Letzter Stand
- Umstellung auf `server.js` zurück auf `index.js` (Einstiegspunkt bereinigt).
- Version 5.0.1 ist auf GitHub gepusht.
- Serieller Puffer zur Fragmentierungsvermeidung ist implementiert.
- Logging ist für die Humidity-Analyse optimiert.

## Todo für morgen
1. Add-on in Home Assistant deinstallieren und neu installieren (um Docker-Cache zu leeren).
2. Start-Logs prüfen: "Bridge Server v5.0.1" muss erscheinen.
3. GUI-Test: Kommen jetzt "RAW"-Daten an?
4. Falls ja: Luftfeuchtigkeits-Bytes in den `[DEBUG RAW]` Daten identifizieren und den `extractHumidity` Algorithmus anpassen.
5. Selektive Discovery ("In HA hinzufügen") testen.
