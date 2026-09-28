// ─── Google Agenda : OAuth2 par salon + création d'événements ───────────────
// Chaque salon connecte SON agenda Google via /auth/google?salon=<id>.
// Le refresh token est stocké côté serveur dans salons/<id>.tokens.json
// (gitignoré, jamais exposé). À la réservation, l'agent crée l'événement.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { config } from "./config.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SALONS_DIR = path.join(__dirname, "..", "salons");
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

function tokensPath(salonId) {
  return path.join(SALONS_DIR, `${salonId}.tokens.json`);
}

function oauthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

function googleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

/** URL de consentement Google pour connecter l'agenda d'un salon. */
export function getAuthUrl(salonId) {
  if (!googleConfigured()) throw new Error("Google OAuth non configuré (GOOGLE_CLIENT_ID/SECRET manquants).");
  return oauthClient().generateAuthUrl({
    access_type: "offline", // indispensable pour obtenir un refresh_token
    prompt: "consent",
    scope: SCOPES,
    state: salonId, // on récupère le salon au retour (callback)
  });
}

/** Échange le code OAuth contre des tokens et les stocke pour le salon. */
export async function handleOAuthCallback(code) {
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google n'a pas renvoyé de refresh_token (reconnectez en forçant le consentement).");
  }
  return tokens;
}

export function saveTokens(salonId, tokens) {
  fs.writeFileSync(tokensPath(salonId), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  log.info(`Tokens Google enregistrés pour le salon ${salonId}`);
}

export function isGoogleConnected(salonId) {
  try {
    const t = JSON.parse(fs.readFileSync(tokensPath(salonId), "utf8"));
    return Boolean(t.refresh_token);
  } catch {
    return false;
  }
}

function authorizedClient(salonId) {
  const tokens = JSON.parse(fs.readFileSync(tokensPath(salonId), "utf8"));
  const auth = oauthClient();
  auth.setCredentials(tokens);
  // Sauvegarde automatique si Google renouvelle les tokens.
  auth.on("tokens", (newTokens) => {
    try {
      const merged = { ...tokens, ...newTokens };
      fs.writeFileSync(tokensPath(salonId), JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch (err) {
      log.warn(`Sauvegarde tokens Google (${salonId}) : ${err.message}`);
    }
  });
  return auth;
}

/**
 * Crée l'événement "RDV BeautyBook" dans l'agenda du salon.
 * Ne fait rien (sans erreur) si l'agenda n'est pas connecté.
 */
export async function createCalendarEvent(salon, { summary, description, date, startTime, endTime, clientPhone }) {
  if (!isGoogleConnected(salon.id)) {
    log.info(`Agenda Google non connecté pour ${salon.id} — événement ignoré.`);
    return null;
  }
  const calendar = google.calendar({ version: "v3", auth: authorizedClient(salon.id) });
  const timeZone = salon.timezone || "Europe/Paris";
  const event = {
    summary,
    description: `${description || ""}\nTél : ${clientPhone || "—"}`.trim(),
    start: { dateTime: `${date}T${startTime}:00`, timeZone },
    end: { dateTime: `${date}T${endTime}:00`, timeZone },
  };
  const { data } = await calendar.events.insert({
    calendarId: salon.google_calendar_id || "primary",
    requestBody: event,
  });
  log.info(`Événement Agenda créé pour ${salon.id} : ${data.htmlLink || data.id}`);
  return data;
}
