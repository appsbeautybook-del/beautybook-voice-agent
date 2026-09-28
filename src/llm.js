// ─── Cerveau conversationnel (LLM compatible OpenAI + function calling) ─────
// Provider configurable : OpenAI ou xAI/Grok (voir LLM_PROVIDER dans config.js).
// xAI expose une API compatible OpenAI : le function calling fonctionne tel quel.
// Un tour de parole = un appel chat completions avec les outils du salon.
// Boucle sur les appels d'outils (max 4) jusqu'à obtenir le texte final à dire.
// MULTILINGUE : le prompt système est généré dans la langue de l'appelant
// (détectée sur sa première phrase). Prompts complets en fr/en, repli
// générique pour les autres langues.

import OpenAI from "openai";
import { config, normalizeLang, langNameEn } from "./config.js";
import { TOOL_DEFS, runTool } from "./tools.js";
import { nowInTz } from "./availability.js";
import { log } from "./logger.js";

// baseURL = URL du provider (api.openai.com par défaut du SDK, ou api.x.ai/v1).
const openai = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL, timeout: 20000, maxRetries: 1 });

const MAX_TOOL_ROUNDS = 4;

// ─── Petites phrases localisées (relances, erreurs) ─────────────────────────

export const STRINGS = {
  fr: {
    nudge: "Vous êtes toujours là ? Je vous écoute.",
    techIssue: "Je rencontre un petit souci technique, pouvez-vous répéter s'il vous plaît ?",
    notUnderstood: "Pardon, je n'ai pas bien saisi.",
    toolLoop: "Très bien, je transmets tout cela à l'équipe du salon qui vous recontactera.",
  },
  en: {
    nudge: "Are you still there? I'm listening.",
    techIssue: "I'm having a small technical issue, could you please repeat that?",
    notUnderstood: "Sorry, I didn't quite catch that.",
    toolLoop: "Very well, I'll pass all of this on to the salon team, who will get back to you.",
  },
};

/** Phrases dans la langue de l'appel (repli : anglais). */
export function getStrings(lang) {
  return STRINGS[normalizeLang(lang)] || STRINGS.en;
}

// ─── Prompts système localisés ─────────────────────────────────────────────

function promptFr(salon, todayFr) {
  return `Tu es ${salon.agent_name || "Léa"}, l'assistante téléphonique du salon « ${salon.name} ».
Tu parles français, avec un ton chaleureux, professionnel et naturel — comme une vraie réceptionniste. Tes réponses sont COURTES (1 à 2 phrases max à l'oral), sans listes à puces, sans émojis, sans jargon technique.

TA MISSION : accueillir l'appelant, comprendre son besoin, et si la personne est intéressée par une réservation :
1. Découvre le service souhaité (utilise get_services pour connaître les vraies prestations, prix et durées — ne jamais inventer).
2. Propose des créneaux avec check_availability (date au format YYYY-MM-DD ; aujourd'hui nous sommes le ${todayFr}).
3. Quand le client choisit : demande son prénom et nom, RÉCAPITULE à voix haute (service, date, heure, prix), attends sa confirmation explicite, puis appelle book_appointment.
4. Annonce la confirmation et termine par end_call avec le motif "qualifie".

RÈGLES STRICTES :
- Ne propose JAMAIS un créneau sans avoir appelé check_availability, et ne confirme JAMAIS un RDV sans book_appointment.
- Si les horaires ne sont pas configurés ou aucun créneau n'est libre : propose un rappel par l'équipe (end_call "rappel_humain"), sans inventer.
- Urgence, réclamation complexe, demande hors sujet (emploi, partenariat...) : reste polie, propose un rappel humain, puis end_call.
- Si la personne n'est pas intéressée : remercie et end_call "non_interesse".
- Ne demande jamais d'email ni de coordonnées bancaires. Le paiement se fait sur place.
- Si tu ne comprends pas : fais répéter simplement, 2 fois maximum, puis propose le rappel humain.
${salon.extra_prompt ? `\nCONSIGNES SPÉCIFIQUES DU SALON :\n${salon.extra_prompt}` : ""}`;
}

function promptEn(salon, todayEn) {
  return `You are ${salon.agent_name || "Léa"}, the phone assistant of the salon "${salon.name}".
You speak English, with a warm, professional and natural tone — like a real receptionist. Your answers are SHORT (1 to 2 sentences max when spoken), no bullet lists, no emojis, no technical jargon.

YOUR MISSION: greet the caller, understand their need, and if the person is interested in booking:
1. Find out the desired service (use get_services for the real services, prices and durations — never invent any).
2. Offer time slots with check_availability (date in YYYY-MM-DD format; today is ${todayEn}).
3. When the client chooses: ask for their first and last name, RECAP out loud (service, date, time, price), wait for their explicit confirmation, then call book_appointment.
4. Announce the confirmation and finish with end_call and the reason "qualifie".

STRICT RULES:
- NEVER offer a slot without calling check_availability, and NEVER confirm an appointment without book_appointment.
- If opening hours are not configured or no slot is free: offer a callback from the team (end_call "rappel_humain"), without inventing anything.
- Emergency, complex complaint, off-topic request (jobs, partnerships...): stay polite, offer a human callback, then end_call.
- If the person is not interested: thank them and end_call "non_interesse".
- Never ask for an email address or bank details. Payment is made on site.
- If you don't understand: simply ask them to repeat, 2 times maximum, then offer the human callback.
${salon.extra_prompt ? `\nSALON-SPECIFIC INSTRUCTIONS:\n${salon.extra_prompt}` : ""}`;
}

/** Repli générique pour les autres langues : prompt anglais + consigne de langue. */
function promptGeneric(salon, lang, todayEn) {
  const name = langNameEn(lang);
  return promptEn(salon, todayEn) +
    `\n\nIMPORTANT: The caller speaks ${name}. Conduct the ENTIRE conversation in ${name} (not in English), keeping the same short, natural spoken style.`;
}

/** Prompt système : personnalité + règles métier, dans la langue de l'appelant. */
export function buildSystemPrompt(salon, lang) {
  const l = normalizeLang(lang) || salon.default_language || "fr";
  const tz = salon.timezone || "Europe/Paris";
  const todayFr = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz,
  }).format(new Date());
  const todayEn = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz,
  }).format(new Date());

  if (l === "fr") return promptFr(salon, todayFr);
  if (l === "en") return promptEn(salon, todayEn);
  return promptGeneric(salon, l, todayEn);
}

function inboundNote(lang) {
  return normalizeLang(lang) === "en"
    ? "INBOUND CALL. The client is calling the salon on their own: greet them with the welcome message, then listen to their need."
    : "APPEL ENTRANT. Le client appelle le salon de lui-même : accueille-le avec le message d'accueil puis écoute son besoin.";
}

function outboundNote(lang, callerPhone, context) {
  return normalizeLang(lang) === "en"
    ? `OUTBOUND CALL to ${callerPhone}. Campaign context: ${context || "prospecting / callback"}. Introduce yourself, briefly explain why you are calling, then follow your mission.`
    : `APPEL SORTANT vers le ${callerPhone}. Contexte de la campagne : ${context || "prospection / rappel"}. Présente-toi, explique brièvement pourquoi tu appelles, puis suis ta mission.`;
}

/** Contexte initial de la conversation (appel entrant ou sortant). */
export function initialMessages(salon, lang, { direction, callerPhone, context }) {
  const l = normalizeLang(lang) || salon.default_language || "fr";
  const msgs = [{ role: "system", content: buildSystemPrompt(salon, l) }];
  if (direction === "outbound") {
    msgs.push({ role: "system", content: outboundNote(l, callerPhone, context) });
  } else {
    msgs.push({ role: "system", content: inboundNote(l) });
  }
  return msgs;
}

/**
 * Mini-classification de secours : si Deepgram n'a pas détecté la langue
 * (audio trop court, bruit…), on demande au LLM d'identifier la langue du texte.
 * Retourne un code ISO 639-1 ("fr", "en"…) ou null.
 */
export async function detectLanguageFromText(text) {
  const sample = String(text || "").trim().slice(0, 300);
  if (sample.length < 4) return null;
  try {
    const r = await openai.chat.completions.create({
      model: config.llm.model,
      temperature: 0,
      max_tokens: 10,
      messages: [
        {
          role: "system",
          content: "Identify the language of the following text. Reply with ONLY the ISO 639-1 code (e.g. fr, en, es, de, it, pt). No other text.",
        },
        { role: "user", content: sample },
      ],
    });
    const code = normalizeLang(r.choices[0].message.content?.trim());
    return code;
  } catch (err) {
    log.warn(`Détection de langue (LLM) : ${err.message}`);
    return null;
  }
}

/**
 * Fait parler l'agent : envoie le tour de l'utilisateur au LLM, exécute les
 * outils demandés, retourne { text } (à synthétiser) et met à jour ctx.
 * ctx.lang porte la langue de l'appel (pour les messages de repli).
 */
export async function agentReply(ctx, userText) {
  const { salon, callSid } = ctx;
  const S = getStrings(ctx.lang || salon.default_language || "fr");
  ctx.messages.push({ role: "user", content: userText });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: config.llm.model,
        messages: ctx.messages,
        tools: TOOL_DEFS,
        tool_choice: "auto",
        temperature: 0.6,
        max_tokens: 220, // réponses orales courtes
      });
    } catch (err) {
      log.error(`LLM (${config.llm.provider}) : ${err.message}`, callSid);
      return { text: S.techIssue };
    }

    const msg = completion.choices[0].message;
    ctx.messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return { text: msg.content?.trim() || S.notUnderstood };
    }

    // Exécute chaque outil et renvoie les résultats au LLM.
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* args invalides → outil répondra */ }
      let result;
      try {
        result = await runTool(ctx, tc.function.name, args);
      } catch (err) {
        log.error(`Outil ${tc.function.name} : ${err.message}`, callSid);
        result = `ERREUR technique : ${err.message}. Propose un rappel humain au client.`;
      }
      ctx.messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 2000) });
    }
  }

  log.warn("Trop de tours d'outils — réponse de repli.", callSid);
  return { text: S.toolLoop };
}

// Pour compatibilité : buildSystemPrompt(salon) seul = langue par défaut.
export function buildSystemPromptDefault(salon) {
  return buildSystemPrompt(salon, salon.default_language || "fr");
}
