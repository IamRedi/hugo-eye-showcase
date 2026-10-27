# Projektstand HUGO Eye

Stand: 27.10.2026. Dieses öffentliche Repository ist eine Momentaufnahme des privaten Entwicklungs-Repositorys. Es enthält den neuesten Quellstand (Ausbaustufe EYE-025, Code vom 10.10.2026).

## Ausbaustufen

| Stufe | Inhalt | Stand laut privaten Unterlagen |
|---|---|---|
| 0.1 | Erste Fassung als Gartenkamera mit Patrouille | abgelöst, Daten getrennt archiviert |
| 2.0 / 2.1 | Innenkamera-Produkt: RelayHub, MSE-Live-Bild, Aufnahmen, YOLOv8n, Sicherheitsmodell | Release 2.1.0, auf dem Mini-PC ausgerollt |
| EYE-022 | Gemeinsame Bilddekodierung, Tracker, Gesichtserkennung (YuNet + SFace), HUGO-Core-Adapter | in 2.2 aufgegangen |
| EYE-023 | Szenenbeschreibung (VLM), CLIP-Suche, Auto-Follow, Kamera-Register, PWA, Wiederanlauf nach Absturz | Release 2.2.0, Bericht: [EYE023_REPORT.md](EYE023_REPORT.md), „bedingt bestanden, bereit zur Abnahme“ |
| EYE-025 | Identitäts-Kontinuität („erkannt / verfolgt / möglicherweise / unbekannt“), Haltung, AI-Vision-Overlay, Ursachenkette eingefrorener Live-Bilder behoben (Watchdog, MSE→MJPEG, Generationsschutz), Schutz gegen Bewegungs-Ereignisfluten | Quellstand dieses Repositorys; nicht unabhängig geprüft und nicht abgenommen |

## Was am echten Gerät belegt ist (laut privatem Bericht EYE-023, 09.10.2026)

- Live-Bild, Schnappschuss, PTZ (Schwenken/Neigen, Positionen, Positionsrückmeldung), Mikrofon-Aufnahme, Gesundheitsprüfung, Kamera-Register, VLM-Fragen und CLIP-Suche an der Tapo C520WS.
- Kamera 11 Stunden 44 Minuten stromlos: Ausfall nach höchstens 42 Sekunden erkannt, genau zwei Ereignisse, keine Neustart-Schleife, danach selbstständig wieder da, Datenbank und Medien unversehrt ([SOAK-INCIDENT-2026-10-08.md](SOAK-INCIDENT-2026-10-08.md)).
- Messwerte auf dem Mini-PC (16 Kerne, 29 GB RAM): Personenerkennung p50 95 ms pro Bild bei 2 fps; voller Betrieb mit Daueraufnahme, Bewegung, Personen und Gesichtern bei rund 19 % eines Kerns für Node.
- Was die Kamera nicht kann, wird nicht angezeigt: Gegensprechen, Sirene, Licht, IR-Schalter, Motorzoom und kamerainterne Ereignisse sind nur über das Tapo-eigene Protokoll erreichbar und bewusst nicht nachgebaut.

## Offen

- **Abnahme durch den Besitzer:** Rundgang mit Gesichtserkennung im Bild, Auto-Follow mit einer echten Person, Bedienung auf dem Android-Handy.
- **24-Stunden-Dauerlauf** auf 2.2.0 ohne Unterbrechung: Ergebnis in diesen Unterlagen nicht festgehalten.
- **Zweite echte Kamera:** nur synthetisch geprüft (zwei nachgebaute Kameras unabhängig voneinander).
- **HUGO Core:** Adapter fertig und getestet, aber noch nie live mit HUGO Core gekoppelt.
- **EYE-025:** Funktionen im Quellcode und in Tests, unabhängige Prüfung und Abnahme fehlen.
- Firefox und iOS: nur Chromium geprüft.

## Was gegenüber dem privaten Repository entfernt oder geändert wurde

- Kompletter Git-Verlauf; dieses Repository beginnt mit einem einzigen Commit.
- Interne Veröffentlichungs-Protokolldatei, ein Migrationsskript für alte Daten des Autors.
- Private Netzadressen in Beispielen und Berichten durch Platzhalter ersetzt (`192.168.1.x`), lokale Pfade durch `/home/dev`.
- Erste Kamera-Drehung beim Einrichten: früher fest 180° (Deckenmontage beim Autor), jetzt über `CAM1_ROTATE` einstellbar, Standard 0°.
- Neu: `npm run demo` mit nachgebauter RTSP-Kamera, Screenshots, diese Dokumente, LICENSE, SECURITY.md, CI mit gitleaks.
- `ui/dist` aus dem EYE-025-Quellstand neu gebaut (im privaten Stand lag noch der Build von 2.2).
