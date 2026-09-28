# 🎙️ Agent vocal IA téléphonique — BeautyBook

Serveur Node.js qui fait passer et décrocher de **vrais appels téléphoniques**
à un agent IA qui converse en français : il qualifie le prospect et prend des
RDV **directement dans BeautyBook** (+ Google Agenda).

Un seul serveur, **un agent indépendant par salon** (config dans `salons/`).

## Comment ça marche

```
Appelant ──téléphone──▶ Twilio ──WebSocket──▶ ce serveur
                                          ├─▶ Deepgram   : voix → texte (détection auto de la langue, temps réel)
                                          ├─▶ OpenAI     : comprend + décide (function calling, prompt dans la langue de l'appelant)
                                          ├─▶ ElevenLabs : texte → voix (une voix par langue, streaming)
                                          ├─▶ Supabase   : services, horaires, RDV BeautyBook
                                          └─▶ Google     : événement dans l'agenda du salon
```

## Démarrage rapide

```bash
cp .env.example .env   # renseigner les clés
npm install
npm start
```

Puis suivez **[docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)** (clés API, déploiement,
webhooks Twilio, agenda Google, appel de test).

## Arborescence

```
├── src/
│   ├── index.js         # Express : webhooks Twilio, API, OAuth Google, dashboard
│   ├── media.js         # WebSocket /media : orchestration temps réel + barge-in + langue auto
│   ├── stt.js           # Deepgram streaming (détection auto de langue, verrouillage en cours d'appel)
│   ├── tts.js           # ElevenLabs streaming (voix par langue, ulaw 8kHz direct)
│   ├── llm.js           # OpenAI : prompt localisé (fr/en/…) + function calling
│   ├── tools.js         # get_services, check_availability, book_appointment, end_call
│   ├── availability.js  # créneaux réels (miroir hours.js + StepCalendar de BeautyBook)
│   ├── supabase.js      # lecture ProfilPro/Service, écriture Reservation
│   ├── google.js        # OAuth2 par salon + création d'événements Agenda
│   ├── twilio.js        # TwiML + appels sortants (REST)
│   ├── calllog.js       # historique des appels (mémoire + JSON)
│   ├── config.js        # env + configs salons (salons/*.json)
│   └── logger.js
├── salons/              # un JSON par salon (numéro, voix, prompt, agenda…)
├── public/index.html    # mini dashboard : appel de test + historique
├── docs/
│   ├── DEPLOIEMENT.md   # pas à pas : clés, déploiement, webhooks, test
│   └── SCENARIO.md      # script de qualification de l'agent
├── data/                # historique d'appels (JSON local)
├── Dockerfile
└── .env.example
```

## Fonctionnalités

- 📥 **Appels entrants** : décroche, salue, qualifie, réserve.
- 📤 **Appels sortants** : via le dashboard ou `POST /api/calls`.
- 🗣️ **Conversation naturelle** en français, avec **barge-in** (l'appelant peut
  couper la parole à l'agent).
- 🌍 **Multilingue** : langue de l'appelant détectée sur sa première phrase —
  l'agent bascule (transcription + conversation + voix dédiée) pour tout l'appel.
  Langue par défaut et voix par langue configurables par salon, depuis le dashboard.
- 📅 **Vrais créneaux** : horaires BeautyBook + RDV existants + buffer 15 min.
  Jamais de créneau inventé (si les horaires sont absents → rappel humain).
- 💾 **RDV écrits dans BeautyBook** (`Reservation`, statut `en_attente`,
  paiement `surplace`) **+ événement Google Agenda**.
- 🏪 **Multi-salon** : chaque salon a son numéro, sa voix, son prompt, son agenda.
- 🧾 **Historique** : qualification (`qualifie`, `non_interesse`, `rappel_humain`,
  `hors_sujet`), résumé et transcription par appel.

## Documentation

- [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md) — mise en production pas à pas
- [docs/SCENARIO.md](docs/SCENARIO.md) — le script de qualification
- [salons/README.md](salons/README.md) — ajouter un salon
