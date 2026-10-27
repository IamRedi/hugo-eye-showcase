# Sicherheit / Security

## Einsatzmodell

HUGO Eye ist für das eigene Heimnetz gebaut. Kein Konto, keine Cloud, keine Telemetrie. Video, Aufnahmen und KI-Auswertung bleiben auf dem Rechner.

| Port | Zweck | Standard |
|---|---|---|
| 8764 | HTTP-API und Web-Oberfläche | `127.0.0.1`; eine LAN-Adresse nur in vertrauenswürdigen Netzen |

## Was im Code abgesichert ist

- **Anmeldung:** API-Token aus `.env`, daraus serverseitige, widerrufbare Sitzungen in der Datenbank. Live-Streams über kurzlebige HMAC-Freigaben.
- **Browser:** Same-Origin-Prüfung, Sicherheits-Header, Ratenbegrenzung, höchstens 4 Streams pro Client und 12 Abnehmer pro Kamera.
- **Kamera-Zugang:** Benutzer und Passwort stehen nur in `.env` (Rechte 600, nicht im Repository) oder im Kamera-Register und gehen nur in RTSP/ONVIF-Authentifizierungs-Header des eigenen Clients. Nie in Prozessargumenten, Umgebung von ffmpeg oder Logs; Logs maskieren Kennungen. Beides ist durch Tests abgedeckt (`test/redaction.test.mjs`).
- **Privatsphäre:** Aufnahme, Mikrofon, Videoanalyse und Personenerkennung sind ausgeschaltet, bis man sie einschaltet, und werden serverseitig durchgesetzt. Pro Kamera gibt es eine Sperre, die Live-Bild, Schnappschüsse, PTZ und Aufnahmen auf einmal abschaltet.
- **PWA:** Der Service Worker speichert nie `/api/*` oder `/media/*`.
- **HUGO-Schnittstelle:** Kopplung authentifiziert nur den Transport. Ob HUGO etwas tun darf, entscheidet HUGO Core mit einer Freigabe-Referenz; das Gerät erteilt sich keine Rechte und lehnt unbekannte Fähigkeiten ab.
- **Dienst:** systemd-User-Unit mit `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`.
- Secret-Scan (gitleaks) in GitHub Actions bei jedem Push.

## Bekannte Grenzen

- Kein TLS im Dienst selbst. Für Zugriff von außen gehört ein abgesicherter Weg davor (VPN o. Ä.); keine Portfreigabe ins Internet.
- Gesichtsprofile sind biometrische Daten. Sie liegen nur lokal in der Datenbank, und nur der Betreiber legt sie an. Wer HUGO Eye einsetzt, ist für die rechtliche Zulässigkeit (z. B. DSGVO, Einwilligung von Mitbewohnern und Gästen) selbst verantwortlich.

## Schwachstelle melden

Bitte nicht als öffentliches Issue. Kontakt über das GitHub-Profil [@IamRedi](https://github.com/IamRedi) oder über „Report a vulnerability“ im Security-Tab dieses Repositorys, falls aktiviert.
