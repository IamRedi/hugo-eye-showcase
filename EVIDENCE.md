# Prüfprotokoll

Was für diese öffentliche Fassung am 27.10.2026 tatsächlich ausgeführt wurde. Umgebung: Linux-Container, Node 22.22, ffmpeg, Chromium über Playwright. Keine echte Kamera, kein Mini-PC.

| Prüfung | Ergebnis |
|---|---|
| `npm test` (node:test, Node 22.22) | **96 Tests** bestanden, 0 fehlgeschlagen |
| Oberfläche: `tsc -b` und `vite build` in `ui/` | ohne Fehler; Ergebnis liegt in `ui/dist` |
| Secret-Scan, gitleaks 8.28 über alle Dateien | keine Funde |
| Suche nach privaten Daten (Netzadressen, Pfade, E-Mail, MAC) | nur noch Platzhalter |
| `npm run demo`: echte Anwendung gegen `scripts/demo-camera.mjs` | Kamera-Register, RTSP-Verbindung, RelayHub `connecting → streaming`, fMP4-Live-Bild im Browser |
| Browser-Durchgang (Chromium, 1440 × 900, dunkles Schema): Live, Aktivität, Suche, Aufnahmen, Kameras, Intelligenz, Personen, Automationen, Einstellungen | alle Seiten laden ohne JavaScript-Fehler; Screenshots in `docs/assets` |
| HUGO-Schnittstelle in der Demo: `GET /api/adapter/manifest`, `/api/adapter/capabilities` | Manifest mit SHA-256-Digest, 13 Fähigkeiten; ohne Anmeldung 401 |
| HUGO-Core-Vertrag | Commit `cf03ce5` und Aufgabe H078 im privaten HUGO-Core-Repository nachgesehen; dort ist `BodyAdapter`/`DeviceAdapter` als Geräteschnittstelle beschrieben |

## Aus den privaten Entwicklungsunterlagen (hier nicht nachgeprüft)

- Bericht EYE-023 vom 09.10.2026: 78/78 Tests, Live-Prüfungen an der Tapo C520WS, Messwerte, Stromausfall-Wiederanlauf; Urteil „bedingt bestanden, bereit zur Abnahme durch den Besitzer“ ([docs/EYE023_REPORT.md](docs/EYE023_REPORT.md)).
- Laut Projektübersicht des Autors läuft HUGO Eye als eigenständiger Dienst auf dem Mini-PC; 16 von 16 Selbsttests gegen die echte Kamera bestanden. Welche Fassung dort gerade läuft, ist hier nicht geprüft.

## Was nicht geprüft ist

- **Echte Kamera in dieser Fassung.** Hier lief nichts gegen eine Tapo-Kamera; ONVIF und PTZ sind in der Demo nicht nachgebaut.
- **KI-Modelle.** YOLO, YuNet, SFace, CLIP und das VLM wurden hier nicht geladen (kein Netzzugriff auf die Modellquellen); die Oberfläche meldet sie als „nicht installiert“.
- **Live-Kopplung mit HUGO Core.**
- **Handy, Firefox, iOS.**
