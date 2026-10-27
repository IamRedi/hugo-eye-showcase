# HUGO Eye

[![CI](https://github.com/IamRedi/hugo-eye-showcase/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/IamRedi/hugo-eye-showcase/actions/workflows/ci.yml)

**Eine lokale Kamera-Plattform für zu Hause, ohne Cloud.** HUGO Eye läuft auf einem kleinen Ubuntu-Rechner im eigenen Netz, holt das Bild direkt per RTSP/ONVIF von der Kamera, erkennt Bewegung, Personen und Gegenstände lokal, nimmt absturzsicher auf und zeigt alles in einer Web-Oberfläche. Bilder, Aufnahmen und KI-Auswertung verlassen den Rechner nie.

HUGO Eye ist das erste Gerät der HUGO-Familie mit einer fertigen Schnittstelle zu [HUGO Core](https://github.com/IamRedi/hugo-core-showcase), dem persönlichen KI-Kern des Autors. Was davon bewiesen ist und was nicht, steht unten im Abschnitt [Rolle im HUGO-Ökosystem](#rolle-im-hugo-ökosystem).

[English version](README.en.md) · [Projektstand](docs/PROJEKTSTAND.md) · [Prüfprotokoll](EVIDENCE.md) · [Sicherheit](SECURITY.md)

![Live-Ansicht mit Demo-Kamera: Bild über MSE/fMP4, PTZ-Steuerung, Aufnahme- und Mikrofon-Schalter](docs/assets/live.png)


> **Nachweisstand und Grenzen:** Die öffentliche Fassung wurde mit Testmaterial und ohne angeschlossene Kamera geprüft. Der Betrieb auf dem privaten Mini-PC mit realer Kamera ist durch Angaben des Autors dokumentiert, nicht durch eine in diesem Snapshot wiederholte Hardwareprüfung. [Prüfprotokoll](EVIDENCE.md).

## Auf einen Blick

| | |
|---|---|
| **Was** | Kamera-Server und Web-Panel: Live-Bild, Aufnahmen, Ereignisse, Suche, Personen, Automationen, PTZ |
| **Hardware** | Ubuntu-Mini-PC, TP-Link Tapo C520WS (ONVIF Profile S, RTSP H.264). Weitere Kameras über die `CameraDriver`-Schnittstelle |
| **Technik** | Node.js 22 (ESM, ohne Pflicht-Abhängigkeiten), eigener RTSP-Client, ffmpeg, SQLite (`node:sqlite`), React 19 + TypeScript + Vite |
| **KI lokal** | Bewegung (Bilddifferenz), Personen/Objekte (YOLOv8n über onnxruntime), Gesichter (YuNet + SFace), semantische Suche (CLIP), Szenenbeschreibung (Qwen2.5-VL über Ollama). Alles optional und ausgeschaltet, bis man es einschaltet |
| **Tests** | 96 Tests mit `node:test`, darunter eine nachgebaute RTSP-Kamera, alle grün ([Prüfprotokoll](EVIDENCE.md)) |
| **Status** | Läuft laut den Unterlagen des Autors als Dienst auf seinem Mini-PC mit einer echten Kamera. Kein kommerzielles Produkt; die Abnahme durch den Besitzer steht aus ([Projektstand](docs/PROJEKTSTAND.md)) |

## Was es kann

- **Eine Kamera-Sitzung für alle.** Pro Stream gibt es genau eine RTSP-Verbindung zur Kamera (`RelayHub`). Live-Ansicht, Aufnahme, Bewegungserkennung und KI hängen sich über interne Pipes daran. Eine Zustandsmaschine (`idle → connecting → streaming ⇄ recovering`) mit Watchdog holt die Kamera nach Ausfällen von selbst zurück.
- **Live-Bild im Browser.** H.264 geht unverändert als fMP4 an den Browser (MSE, kaum CPU). Bleibt das Bild stehen, schaltet der Player selbst auf MJPEG um.
- **Aufnahmen, die einen Absturz überleben.** 60-Sekunden-Segmente, sauber abgeschlossen, mit echten Zeitstempeln, Speicherquote, Aufbewahrungsfrist und Aufräumen nach einem Absturz. Auf Wunsch mit Vorlauf vor einem Ereignis.
- **Lokale Erkennung mit ehrlichen Zuständen.** Jeder KI-Baustein meldet `not_installed`, `inactive`, `starting`, `active` oder `error`. Ohne installiertes Modell behauptet die Oberfläche keine Erkennung.
- **Personen kennen, vorsichtig benennen.** Gesichter werden nur für selbst angelegte Profile wiedererkannt. Die Live-Anzeige unterscheidet „erkannt“, „verfolgt“, „möglicherweise“ und „unbekannt“, statt einen Namen zu raten.
- **PTZ und Auto-Follow.** Schwenken, Neigen, Positionen speichern; auf Wunsch folgt die Kamera einer Person (geschlossene Regelschleife über ONVIF). Jede manuelle Bewegung bricht das sofort ab.
- **Suche in natürlicher Sprache.** „jemand sitzt auf dem Sofa“ findet passende Ereignisbilder über CLIP-Embeddings, mit Wert und Link zur Aufnahme.
- **Sicher im Heimnetz.** Anmeldung mit Token, widerrufbare Sitzungen, kurzlebige Stream-Freigaben, Same-Origin-Prüfung, Ratenbegrenzung. Kamera-Passwörter tauchen nie in Prozessargumenten oder Logs auf (per Test geprüft).

| Kameras und Fähigkeiten | Lokale Intelligenz | Einstellungen und Datenschutz |
|---|---|---|
| ![Kameras](docs/assets/cameras.png) | ![Intelligenz](docs/assets/intelligence.png) | ![Einstellungen](docs/assets/settings.png) |

Die Bilder stammen aus der lokalen Demo unten: eine nachgebaute RTSP-Kamera mit Testbild, ohne KI-Modelle. Darum steht oben „Camera offline“ (die Demo-Kamera hat kein ONVIF) und die Erkennung meldet ehrlich „nicht installiert“.

## Rolle im HUGO-Ökosystem

HUGO ist der persönliche KI-Assistent des Autors. [HUGO Core](https://github.com/IamRedi/hugo-core-showcase) hält Identität, Gedächtnis, Berechtigungen und das Routing von Fähigkeiten. Geräte wie HUGO Eye, [LED Wall](https://github.com/IamRedi/led-wall-showcase) oder ein ESP32-Roboter bleiben eigenständig und bieten HUGO nur eine kontrollierte Schnittstelle an. Die Regel dabei: **die KI schlägt vor, das Gerät führt deterministisch aus und behält die Hoheit.**

```
HUGO Core ──(DeviceAdapter, Freigabe durch Core)──▶ HUGO Eye API ──▶ RTSP/ONVIF ──▶ Kamera
```

**Was im Code steht und getestet ist:**

- `src/adapter/deviceAdapter.js` setzt die Anbieter-Schnittstelle von HUGO Core um (`identity`, `runtimeSnapshot`, `negotiate`, `registerCapabilities`, `execute`, `cancel`). `src/adapter/contracts.js` bildet die Kotlin-Regeln von HUGO Core nach (Stand: HUGO-Core-Commit `cf03ce5`, Aufgabe H078 „Portable perception foundation“).
- 13 Fähigkeiten mit Risiko- und Sicherheitsklasse, zum Beispiel `camera.snapshot@1.0`, `camera.ptz_move@1.0` (Risiko ELEVATED, physische Aktion), `perception.observations@1.0`, `perception.subscribe@1.0`.
- Das Gerät erteilt sich selbst keine Rechte: jede Anfrage braucht eine Freigabe-Referenz von HUGO Core, ein exakt benanntes Ziel und eine Frist. Entdecken heißt nicht steuern dürfen.
- 20 Vertragstests in `test/adapter-contracts.test.mjs` (Format der Fähigkeiten, Anfrage- und Ergebnis-Umschläge, Verhandlung, Manifeste mit SHA-256-Digest).
- Die laufende Anwendung liefert das Manifest unter `/api/adapter/manifest` aus (in der Demo geprüft).

**Was noch nicht bewiesen ist:** HUGO Core und HUGO Eye wurden noch nie live miteinander gekoppelt; die Schnittstelle ist bewusst nicht verdrahtet. Der erste echte Durchgang (Kopplung, Freigabe in Core, Schnappschuss und PTZ über HUGO) ist der nächste HUGO-Schritt.

## Ausprobieren ohne Kamera

Voraussetzungen: Node.js 22.5 oder neuer, ffmpeg.

```bash
git clone https://github.com/IamRedi/hugo-eye-showcase && cd hugo-eye-showcase
npm run demo
```

Dann `http://127.0.0.1:8764/` öffnen und mit dem Token `demo-token-demo-token-demo-token` anmelden. Die Demo startet die echte Anwendung gegen eine nachgebaute RTSP-Kamera (`scripts/demo-camera.mjs`, ffmpeg-Testbild als H.264). Alles liegt in einem temporären Ordner und verschwindet mit Strg+C. Mit `npm run demo -- --input clip.mp4` läuft ein eigenes Video statt des Testbilds.

Für die lokale Erkennung lädt `npm run ai:setup` die Modelle (Prüfsummen und Lizenzen stehen im Skript), `npm install onnxruntime-node` installiert die Laufzeit.

## Betrieb mit echter Kamera

```bash
cp .env.example .env && chmod 600 .env   # Kamera-Zugang, Token, Datenordner eintragen
npm start                                # Dienst, Panel auf http://127.0.0.1:8764/
npm run selftest                         # Prüfungen gegen die echte Kamera
npm run install:service                  # als systemd --user Dienst einrichten
```

Die Oberfläche liegt fertig gebaut in `ui/dist`. Neu bauen: `cd ui && npm ci && npm run build`.

## Tests

```bash
npm test                                 # 96 Tests, Node 22, keine Kamera nötig
cd ui && npm ci && npm run build         # TypeScript-Prüfung und Build der Oberfläche
```

In GitHub Actions laufen bei jedem Push die Tests, der Build der Oberfläche und gitleaks.

## Aufbau

```
src/
  camera/        RTSP-Client, RelayHub, ONVIF, Tapo-Treiber, ffmpeg-Verbraucher
  vision/        gemeinsame Dekodierung, Tracker, Identität, Haltung, Auto-Follow
  ai/            YOLO, YuNet/SFace, CLIP, VLM (alle optional)
  adapter/       HUGO-Core-DeviceAdapter und Vertragsregeln
  api/server.js  authentifizierte API und statische Oberfläche
  recordings.js, intelligence.js, security.js, db.js, …
ui/              React-Panel (Live, Aktivität, Suche, Aufnahmen, Kameras, Personen, …)
scripts/         Demo, Demo-Kamera, Selbsttest, Benchmark, Soak-Monitor, Modell-Setup
test/            node:test, inklusive nachgebauter RTSP-Kamera
docs/            Architektur, Entwurf und Prüfberichte der Ausbaustufen
```

## Lizenz

Quellcode zum Lesen und Bewerten, nicht zur Weiterverwendung: siehe [LICENSE](LICENSE). Die KI-Modelle gehören nicht zum Repository und haben eigene Lizenzen (YOLOv8n: AGPL-3.0; YuNet, SFace, CLIP: Apache-2.0/MIT), siehe `scripts/ai-setup.mjs`.
