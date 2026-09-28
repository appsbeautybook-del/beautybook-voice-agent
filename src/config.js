// ─── Configuration : env + salons ───────────────────────────────────────────
// - Les secrets viennent UNIQUEMENT des variables d'environnement (.env).
// - Chaque salon a son fichier salons/<id>.json (nom, pro_email, numéro Twilio,
//   voix, prompt, agenda...). Le serveur est multi-salon : un seul process
//   sert tous les salons, chacun avec son agent indépendant.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SALONS_DIR = path.join(__dirname, "..", "salons");

// Variables obligatoires au démarrage (on échoue vite et fort si absentes,
// plutôt que de découvrir le problème en plein appel).
const COMMON_REQUIRED = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "PUBLIC_BASE_URL",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

// ─── Cerveau LLM : OpenAI ou xAI/Grok (API compatible OpenAI) ───────────────
// LLM_PROVIDER = "openai" (défaut) ou "xai". La clé, l'URL et le modèle
// suivent le provider ; tout est surchargeable via LLM_BASE_URL / LLM_MODEL.
const LLM_PROVIDER = String(process.env.LLM_PROVIDER || "openai").toLowerCase();
if (!["openai", "xai"].includes(LLM_PROVIDER)) {
  console.error(`[CONFIG] LLM_PROVIDER invalide : "${process.env.LLM_PROVIDER}" (attendu : "openai" ou "xai").`);
  process.exit(1);
}

let llmApiKey, llmBaseUrl, llmModel;
if (LLM_PROVIDER === "xai") {
  llmApiKey = process.env.XAI_API_KEY || process.env.LLM_API_KEY;
  llmBaseUrl = process.env.LLM_BASE_URL || "https://api.x.ai/v1";
  // Modèle non-reasoning = faible latence, idéal pour la voix temps réel.
  llmModel = process.env.LLM_MODEL || "grok-4.20-non-reasoning-latest";
} else {
  llmApiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  llmBaseUrl = process.env.LLM_BASE_URL || undefined; // défaut du SDK = api.openai.com
  llmModel = process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";
}

const missing = COMMON_REQUIRED.filter((k) => !process.env[k]);
if (!llmApiKey) missing.push(LLM_PROVIDER === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY");
if (missing.length > 0) {
  console.error(`[CONFIG] Variables d'environnement manquantes : ${missing.join(", ")}`);
  console.error("[CONFIG] Copiez .env.example vers .env et renseignez les valeurs.");
  process.exit(1);
}

// PUBLIC_BASE_URL doit être en HTTPS pour Twilio (webhooks + WebSocket sécurisé).
if (!process.env.PUBLIC_BASE_URL.startsWith("https://")) {
  console.error("[CONFIG] PUBLIC_BASE_URL doit commencer par https:// (exigé par Twilio).");
  process.exit(1);
}

console.log(`[CONFIG] Cerveau LLM : ${LLM_PROVIDER} (modèle ${llmModel})`);

export const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL.replace(/\/$/, ""),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  },
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  // Cerveau conversationnel : provider OpenAI-compatible ("openai" | "xai").
  llm: {
    provider: LLM_PROVIDER,
    apiKey: llmApiKey,
    baseURL: llmBaseUrl, // undefined = URL par défaut du SDK (OpenAI)
    model: llmModel,
  },
  // Alias historiques (compatibilité) — préférez config.llm désormais.
  openaiApiKey: llmApiKey,
  openaiModel: llmModel,
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    // Doit être déclaré tel quel dans la console Google Cloud (OAuth redirect URI).
    redirectUri: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/google/callback`,
  },
};

// ─── Chargement des salons ──────────────────────────────────────────────────

function loadSalons() {
  const salons = new Map();
  if (!fs.existsSync(SALONS_DIR)) return salons;
  for (const file of fs.readdirSync(SALONS_DIR)) {
    if (!file.endsWith(".json") || file.endsWith(".tokens.json")) continue;
    const id = file.slice(0, -".json".length);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SALONS_DIR, file), "utf8"));
      validateSalon(id, raw);
      applyLangDefaults(raw);
      salons.set(id, { id, ...raw });
    } catch (err) {
      console.error(`[CONFIG] Salon ignoré (${file}) : ${err.message}`);
    }
  }
  return salons;
}

function validateSalon(id, s) {
  const required = ["name", "pro_email", "twilio_number", "elevenlabs_voice_id", "greeting"];
  for (const k of required) {
    if (!s[k]) throw new Error(`champ manquant : ${k}`);
  }
  if (!/^\+[1-9]\d{6,14}$/.test(s.twilio_number)) {
    throw new Error(`twilio_number invalide (format E.164 attendu, ex +33612345678) : ${s.twilio_number}`);
  }
  if (s.default_language && !normalizeLang(s.default_language)) {
    throw new Error(`default_language invalide (code ISO à 2 lettres attendu, ex "fr") : ${s.default_language}`);
  }
  if (s.voices !== undefined && s.voices !== null) {
    if (typeof s.voices !== "object" || Array.isArray(s.voices)) {
      throw new Error(`voices doit être un objet { langue: voice_id }, ex {"fr":"...","en":"..."}`);
    }
    for (const [l, v] of Object.entries(s.voices)) {
      if (!normalizeLang(l)) throw new Error(`voices : code langue invalide "${l}" (attendu : fr, en, es…)`);
      if (!v || String(v).length < 10) {
        console.warn(`[CONFIG] Salon ${id} : voice_id suspect pour la langue "${l}" (vérifiez ElevenLabs → Voices).`);
      }
    }
  }
}

export const salons = loadSalons();

if (salons.size === 0) {
  console.warn("[CONFIG] Aucun salon configuré dans salons/*.json — le serveur démarre mais ne pourra traiter aucun appel.");
} else {
  console.log(`[CONFIG] ${salons.size} salon(s) chargé(s) : ${[...salons.keys()].join(", ")}`);
}

// ─── Langues & voix ─────────────────────────────────────────────────────────
// default_language : langue parlée par défaut (accueil + repli).
// voices           : { "fr": "voice_id", "en": "voice_id" } — une voix par langue.
// default_voice    : voix de repli si la langue détectée n'a pas de voix dédiée.
// Ordre de résolution d'une voix : voices[langue] → default_voice → elevenlabs_voice_id.

export const LANG_NAMES = {
  fr: "français", en: "anglais", es: "espagnol", de: "allemand",
  it: "italien", pt: "portugais", nl: "néerlandais", ar: "arabe",
  pl: "polonais", ro: "roumain",
};

/** Normalise un code langue vers ISO 639-1 ("fr-FR" → "fr"). Retourne null si invalide. */
export function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(c) ? c : null;
}

export function langName(code) {
  const c = normalizeLang(code);
  return (c && LANG_NAMES[c]) || c || "inconnu";
}

export const LANG_NAMES_EN = {
  fr: "French", en: "English", es: "Spanish", de: "German",
  it: "Italian", pt: "Portuguese", nl: "Dutch", ar: "Arabic",
  pl: "Polish", ro: "Romanian",
};

/** Nom de la langue en anglais (pour les prompts génériques). */
export function langNameEn(code) {
  const c = normalizeLang(code);
  return (c && LANG_NAMES_EN[c]) || c || "unknown";
}

/** Applique les valeurs par défaut liées aux langues (appelé au chargement). */
function applyLangDefaults(raw) {
  raw.default_language = normalizeLang(raw.default_language) || "fr";
  if (raw.voices === undefined || raw.voices === null) raw.voices = {};
  return raw;
}

/**
 * Voix à utiliser pour une langue donnée.
 * Retourne { voiceId, language, fallback } — fallback=true si on a dû
 * retomber sur la voix par défaut (à journaliser par l'appelant).
 */
export function getVoiceForLanguage(salon, lang) {
  const l = normalizeLang(lang) || salon.default_language || "fr";
  if (salon.voices && salon.voices[l]) {
    return { voiceId: salon.voices[l], language: l, fallback: false };
  }
  return {
    voiceId: salon.default_voice || salon.elevenlabs_voice_id,
    language: l,
    fallback: true,
  };
}

/**
 * Langue à adopter pour un appel après détection.
 * Si la langue détectée a une voix configurée → on l'adopte.
 * Sinon → repli sur default_language (l'appelant est informé via les logs).
 */
export function resolveCallLanguage(salon, detected) {
  const d = normalizeLang(detected);
  const def = salon.default_language || "fr";
  if (d && salon.voices && salon.voices[d]) {
    return { language: d, fallback: false };
  }
  if (d && d !== def) {
    return { language: def, fallback: true, detected: d };
  }
  return { language: d || def, fallback: false };
}

/** Recharge un salon depuis son JSON (après édition via le dashboard). */
export function reloadSalon(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Identifiant de salon invalide : ${id}`);
  const file = path.join(SALONS_DIR, `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  validateSalon(id, raw);
  applyLangDefaults(raw);
  salons.set(id, { id, ...raw });
  return salons.get(id);
}

export function getSalon(id) {
  const salon = salons.get(id);
  if (!salon) throw new Error(`Salon inconnu : ${id}`);
  return salon;
}

/** Masque une clé pour l'affichage (jamais de secret en clair dans les logs). */
export function maskSecret(v) {
  if (!v) return "(absent)";
  const s = String(v);
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
