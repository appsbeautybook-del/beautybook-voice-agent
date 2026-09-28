# Salons

Un fichier JSON par salon = un agent vocal indépendant avec son propre numéro,
sa propre voix, son propre prompt et son propre agenda Google.

## Créer un salon

1. Copiez `mamara-hair-91.json` vers `<id-du-salon>.json` (minuscules, tirets).
2. Renseignez les champs (voir ci-dessous).
3. Redémarrez le serveur (inutile après une modification via le dashboard :
   la carte « Voix & langues » recharge la config à chaud).

## Champs

| Champ | Obligatoire | Description |
|---|---|---|
| `name` | oui | Nom du salon (utilisé dans les RDV et l'agenda) |
| `pro_email` | oui | Email pro du salon dans BeautyBook — c'est lui qui détermine les services, les horaires et l'agenda des RDV |
| `twilio_number` | oui | Numéro Twilio dédié au salon, format E.164 (ex `+33912345678`) |
| `timezone` | non | Fuseau horaire (défaut `Europe/Paris`) |
| `agent_name` | non | Prénom que se donne l'assistante (défaut `Léa`) |
| `elevenlabs_voice_id` | oui | ID de la voix ElevenLabs par défaut (= voix de la langue par défaut) |
| `default_language` | non | Langue parlée par défaut : accueil + repli (code ISO, ex `"fr"`, `"en"`). Défaut `"fr"` |
| `voices` | non | Une voix par langue : `{ "fr": "voice_id_fr", "en": "voice_id_en" }`. Si l'appelant parle une de ces langues, l'agent bascule dessus (voix + langue) pour tout l'appel |
| `default_voice` | non | Voice ID de repli si la langue détectée n'a pas de voix dédiée (sinon : `elevenlabs_voice_id`) |
| `greeting` | oui | Phrase d'accueil jouée dès que l'appel est décroché (dans `default_language`) |
| `extra_prompt` | non | Consignes spécifiques ajoutées au prompt (spécialités, ton, offres…) |
| `google_calendar_id` | non | ID de l'agenda Google (`primary` par défaut) |

⚠️ Ne mettez **jamais** le Account SID ni l'Auth Token Twilio dans ces fichiers :
ils vont dans le `.env` du serveur, renseigné au moment du déploiement.

## Fichiers générés (ne pas éditer à la main)

- `<id>.tokens.json` : tokens OAuth Google du salon (créé via `/auth/google?salon=<id>`).
