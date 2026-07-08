# SafeZone – Kamera-App (2. Handy)

Streamt Live-Kamerabilder per WebSocket an den KI-Detektionsdienst
(`ws://<server>:8090/ingest/<kamera>`). Server nur über Tailscale erreichbar →
Handy muss im selben Tailnet sein (Tailscale-App installiert + an).

## Einrichten
```bash
cd 04-Code/app-camera
npm install
```

## Testen (ohne APK-Build, sofort)
```bash
npx expo start
```
Auf dem Handy die **Expo Go**-App öffnen, QR-Code scannen. In den ⚙︎-Einstellungen
Server-Host (Tailscale-IP `100.105.250.113`), Port `8090` und Kameranamen setzen.

## Als APK bauen
Siehe `01-Doku/architektur/APK-BUILD.md` (EAS-Cloud oder lokales Android-SDK).

## Bedienung
- „STREAM STARTEN" → verbindet WebSocket, sendet ~2-3 Bilder/Sek.
- Bei Waffenverdacht meldet der Server zurück (⚠-Anzeige oben) und legt im
  Backend automatisch einen Vorfall an.
- ⚙︎ = Einstellungen (werden lokal gespeichert).
