# Déploiement — Agent vocal IA téléphonique

Guide pas à pas, de zéro jusqu'au premier vrai appel. Comptez ~1 h (hors validation
du numéro français Twilio : 1 à 2 jours — lancez-la en premier).

---

## Étape 0 — Ce qu'il vous faut

| Élément | Où l'obtenir | Coût indicatif |
|---|---|---|
| Compte Twilio + n° français | [twilio.com/try-twilio](https://www.twilio.com/try-twilio) | n° ~1-2 €/mois, appels ~1-2 ct/min |
| Clé Deepgram | [console.deepgram.com](https://console.deepgram.com) → API Keys | 200 $ de crédit offert |
| Clé ElevenLabs | [elevenlabs.io](https://elevenlabs.io) → Profile → API Key | offre gratuite limitée, puis ~5 $/mois |
| Clé OpenAI **ou** xAI (Grok) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) ou [console.x.ai](https://console.x.ai) | ~0,15 $/1M tokens (gpt-4o-mini) |
| Projet Google Cloud (Agenda) | [console.cloud.google.com](https://console.cloud.google.com) | gratuit |

> **Compte Twilio d'essai** : ~15 $ offerts, mais les appels sortants ne marchent que
> vers des numéros **vérifiés** et un message « trial » se joue avant chaque appel.
> Pour appeler de vrais prospects : console Twilio → **Upgrade** (carte bancaire),
> puis achetez le numéro français (Phone Numbers → Buy a number → France, Voice).
> Le numéro français demande un justificatif (domicile/entreprise) : 1-2 jours.

---

## Étape 1 — Clés IA (10 min)

1. **Deepgram** : créez un compte, copiez une API Key.
2. **ElevenLabs** : créez un compte, copiez l'API Key. Choisissez ensuite une voix
   française : *Voices* → filtrez par langue « French » → cliquez la voix → copiez
   son **Voice ID** (il ira dans le fichier du salon). Pour le mode multilingue,
   choisissez aussi une voix par langue supplémentaire (ex : une voix anglaise) —
   les Voice ID se renseignent ensuite dans le dashboard, carte « Voix & langues ».
3. **Le cerveau (OpenAI ou Grok)** : créez une clé sur platform.openai.com
   **ou** sur console.x.ai (voir « Choisir le cerveau » ci-dessous).

## Choisir le cerveau (OpenAI ou Grok)

Le serveur parle à un LLM via une API **compatible OpenAI** — les deux options
fonctionnent pareil (appels d'outils inclus), seul le provider change :

| | OpenAI | xAI (Grok) |
|---|---|---|
| Variable | `LLM_PROVIDER=openai` (défaut) | `LLM_PROVIDER=xai` |
| Clé | `OPENAI_API_KEY` (platform.openai.com) | `XAI_API_KEY` (console.x.ai) |
| Modèle par défaut | `gpt-4o-mini` (via `OPENAI_MODEL`) | `grok-4.20-non-reasoning-latest` (via `LLM_MODEL`) |
| Pourquoi ce défaut | bon compromis coût/latence/qualité FR | **non-reasoning** = pas de raisonnement long = **faible latence**, idéal pour la voix temps réel |

Pour Grok, le serveur utilise automatiquement `https://api.x.ai/v1`
(`LLM_BASE_URL` ne sert qu'en cas d'URL personnalisée). Pour forcer un autre
modèle Grok : `LLM_MODEL=grok-4.1-fast-non-reasoning`, par exemple.

## Étape 2 — Google Cloud pour l'Agenda (15 min)

1. [console.cloud.google.com](https://console.cloud.google.com) → créez un projet (ex `voice-agent`).
2. *APIs & Services → Library* → activez **Google Calendar API**.
3. *APIs & Services → OAuth consent screen* → type **Externe** → renseignez nom + email.
4. *Credentials → Create Credentials → OAuth client ID* → type **Application Web**.
5. Dans **Authorized redirect URIs**, ajoutez (remplacez par votre vrai domaine —
   vous l'aurez à l'étape 3) :
   `https://votre-serveur.onrender.com/auth/google/callback`
6. Copiez le **Client ID** et le **Client Secret**.

> Si vous changez de domaine après coup, revenez ajouter la nouvelle URL ici,
> sinon Google refusera la connexion.

## Étape 3 — Déployer le serveur (15 min)

Le serveur doit être joignable en **HTTPS public** (Twilio l'exige).

**Option Render (recommandée) :**
1. Mettez ce dossier dans un dépôt Git (GitHub/GitLab).
2. [dashboard.render.com](https://dashboard.render.com) → *New → Web Service* → connectez le dépôt.
3. Render détecte le `Dockerfile` → laissez les réglages par défaut.
4. Dans *Environment*, ajoutez **toutes** les variables du `.env.example`
   (`PUBLIC_BASE_URL` = l'URL Render, ex `https://voice-agent.onrender.com`).
5. *Deploy*. Notez l'URL publique.

**Option Railway :** même principe (*New Project → Deploy from repo*), Dockerfile
détecté automatiquement, variables dans l'onglet *Variables*.

**En local pour tester** (avec [ngrok](https://ngrok.com)) :
```bash
cp .env.example .env   # puis renseignez les valeurs
npm install
npm start              # port 3000
ngrok http 3000        # PUBLIC_BASE_URL = l'URL https ngrok
```

## Étape 4 — Configurer le salon

1. Éditez `salons/mamara-hair-91.json` (ou créez `<id>.json`, voir `salons/README.md`) :
   - `pro_email` : l'email pro du salon **dans BeautyBook** (c'est lui qui donne
     les services, les horaires et l'agenda des RDV) ;
   - `twilio_number` : le numéro Twilio acheté, format `+33...` ;
   - `elevenlabs_voice_id` : l'ID de la voix française choisie ;
   - `default_language` : langue parlée par défaut (ex `"fr"`) ;
   - `greeting`, `extra_prompt` : personnalisez l'accueil et les consignes.
   Les voix par langue (`voices`) et la langue par défaut se règlent aussi
   directement dans le dashboard (carte « Voix & langues par salon »), sans
   redémarrer le serveur.
2. Redéployez (ou redémarrez) le serveur.

## Étape 5 — Brancher Twilio

Dans la [console Twilio](https://console.twilio.com) → *Phone Numbers → Manage* →
cliquez votre numéro → rubrique **Voice Configuration** :
- *A call comes in* : **Webhook**, `https://votre-serveur.onrender.com/voice/incoming`, méthode **POST**.
- *Save*.

## Étape 6 — Connecter Google Agenda

Dans votre navigateur, ouvrez :
`https://votre-serveur.onrender.com/auth/google?salon=mamara-hair-91`
Connectez-vous avec le compte Google du salon → autorisez → « Agenda connecté ✔ ».
(Vérifiable dans le dashboard : point vert « Agenda connecté ».)

## Étape 7 — Premier appel de test 🎉

1. Ouvrez le dashboard : `https://votre-serveur.onrender.com/`.
2. *Lancer un appel de test* → votre propre numéro de portable (vérifié dans
   Twilio si compte d'essai) → *Lancer l'appel*.
3. Décrochez : l'agent vous salue. Testez : « je voudrais un lissage jeudi »,
   choisissez un créneau, confirmez. Vérifiez ensuite :
   - le RDV dans **BeautyBook → Gestion Agenda** (statut `en_attente`) ;
   - l'événement dans **Google Agenda** ;
   - la transcription dans l'historique du dashboard.

---

## Coûts mensuels estimés (un salon, usage modéré)

| Poste | Estimation |
|---|---|
| Numéro Twilio FR | ~1-2 € |
| Appels Twilio (~100 min) | ~2 € |
| Deepgram (transcription) | ~1-2 € |
| ElevenLabs (voix) | 0-5 € |
| LLM : OpenAI (gpt-4o-mini) ou xAI (Grok) | < 1 € |
| **Total** | **~5-10 €/mois** |

## Dépannage

| Symptôme | Piste |
|---|---|
| Le serveur refuse de démarrer | Variable d'env manquante (le log dit laquelle) |
| Twilio : erreur 11200 / webhook en échec | `PUBLIC_BASE_URL` en HTTP au lieu de HTTPS, ou serveur injoignable |
| Webhook rejeté (403) | Horloge serveur désynchronisée ou mauvaise URL publique → la signature ne correspond plus |
| L'agent ne décroche pas / silence | Vérifier les logs : Deepgram (clé ?), ElevenLabs (voice ID ?), LLM (clé/crédit ?) |
| « Horaires non configurés » | Le `pro_email` du salon n'a pas d'horaires dans BeautyBook → section Horaires & Congés |
| Aucun créneau proposé | Vérifier les congés / jours fermés dans BeautyBook |
| Google : `redirect_uri_mismatch` | L'URL de callback n'est pas déclarée dans Google Cloud (étape 2.5) |
| L'appel se coupe quand je parle | Normal : c'est le barge-in (l'agent s'interrompt quand vous parlez) |
| Latence élevée (3-5 s) | Normal en v1 (STT → LLM → TTS séquentiels). Piste : passer à l'API Realtime d'OpenAI |

## Sécurité

- Ne commitez **jamais** `.env` ni `salons/*.tokens.json` (déjà dans `.gitignore`).
- Définissez `ADMIN_TOKEN` en production : le dashboard exigera alors
  l'en-tête `x-admin-token` pour lancer des appels et voir l'historique.
- Les webhooks Twilio sont vérifiés par signature (`X-Twilio-Signature`).
