// ─── Serveur principal ──────────────────────────────────────────────────────
// Routes :
//   POST /voice/incoming          → webhook Twilio (appel entrant) → TwiML Stream
//   POST /voice/outbound          → webhook Twilio (appel sortant) → TwiML Stream
//   POST /voice/status            → callbacks de statut Twilio (logs)
//   POST /api/calls               → déclenche un appel sortant (dashboard)
//   GET  /api/calls/log          → historique des appels
//   GET  /api/salons             → salons + état connexion Google
//   GET  /auth/google?salon=xxx  → connecte l'agenda Google d'un salon
//   GET  /auth/google/callback   → retour OAuth Google
//   GET  /health                 → sonde de santé
//   WS   /media                  → flux audio temps réel (voir media.js)
//   /                           → mini dashboard web

import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

import { config, salons, getSalon, reloadSalon, normalizeLang } from "./config.js";
import { incomingTwiml, outboundTwiml, startOutboundCall, maskPhone } from "./twilio.js";
import { handleMediaConnection, sessions } from "./media.js";
import { getCallLog, logCallStart } from "./calllog.js";
import { getAuthUrl, handleOAuthCallback, saveTokens, isGoogleConnected, createCalendarEvent } from "./google.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.urlencoded({ extended: false })); // webhooks Twilio (form)
app.use(express.json());
// CORS : l'app BeautyBook (autre origine) pilote l'API depuis le navigateur.
app.use(cors());

// ─── Sécurité webhooks Twilio ───────────────────────────────────────────────
// Vérifie la signature X-Twilio-Signature : seuls les vrais webhooks Twilio
// sont acceptés (sinon n'importe qui pourrait déclencher des appels).
function twilioWebhook(req, res, next) {
  const signature = req.headers["x-twilio-signature"];
  const url = `${config.publicBaseUrl}${req.originalUrl}`;
  const valid = twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
  if (!valid) {
    log.warn(`Webhook rejeté (signature invalide) : ${req.path} ← ${req.ip}`);
    return res.status(403).send("Signature Twilio invalide.");
  }
  next();
}

// ─── Protection du déclenchement d'appels ───────────────────────────────────
// Si ADMIN_TOKEN est défini, POST /api/calls exige l'en-tête x-admin-token.
// (Sans token, le dashboard reste ouvert — à n'utiliser qu'en test.)
function adminGuard(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers["x-admin-token"] !== token) {
    return res.status(401).json({ error: "Non autorisé (x-admin-token manquant ou invalide)." });
  }
  next();
}

// ─── Webhooks voix ──────────────────────────────────────────────────────────

/** Appel ENTRANT : on retrouve le salon via le numéro appelé (To). */
app.post("/voice/incoming", twilioWebhook, (req, res) => {
  const to = req.body.To;
  const from = req.body.From;
  const salon = [...salons.values()].find((s) => s.twilio_number === to);
  if (!salon) {
    log.warn(`Appel entrant vers un numéro inconnu : ${to} (de ${maskPhone(from)})`);
    res.type("text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say language="fr-FR">Ce numéro n'est pas configuré. Au revoir.</Say><Hangup/></Response>`);
  }
  log.info(`Appel entrant de ${maskPhone(from)} → salon ${salon.id}`);
  res.type("text/xml");
  res.send(incomingTwimlWithCaller(salon.id, from));
});

/** Appel SORTANT : le contexte de campagne transite dans l'URL. */
app.post("/voice/outbound", twilioWebhook, (req, res) => {
  const salonId = req.query.salon;
  const context = req.query.context || "";
  try {
    getSalon(salonId);
  } catch {
    log.warn(`Webhook sortant : salon inconnu ${salonId}`);
    return res.status(404).type("text/xml").send(errorTwiml());
  }
  res.type("text/xml");
  res.send(outboundTwiml(salonId, context));
});

/** Callbacks de statut (sonnerie, décroché, terminé) — traçabilité. */
app.post("/voice/status", twilioWebhook, (req, res) => {
  const { CallSid, CallStatus, To } = req.body;
  log.info(`Statut appel ${String(CallSid).slice(-6)} : ${CallStatus} → ${maskPhone(To)}`);
  res.sendStatus(200);
});

// ─── API ────────────────────────────────────────────────────────────────────

/** Déclenche un appel sortant : { to: "+336...", salon: "mamara-hair-91", context: "..." } */
app.post("/api/calls", adminGuard, async (req, res) => {
  const { to, salon: salonId, context } = req.body || {};
  if (!to || !/^\+[1-9]\d{6,14}$/.test(String(to))) {
    return res.status(400).json({ error: "Numéro 'to' invalide (format E.164, ex +33612345678)." });
  }
  let salon;
  try {
    salon = getSalon(salonId);
  } catch {
    return res.status(400).json({ error: `Salon inconnu : ${salonId}` });
  }
  try {
    const callSid = await startOutboundCall({ salon, to, context });
    logCallStart({
      callSid, direction: "outbound", salonId: salon.id,
      from: salon.twilio_number, to, context: context || "",
    });
    res.json({ ok: true, callSid });
  } catch (err) {
    log.error(`Appel sortant : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/calls/log", adminGuard, (req, res) => {
  res.json(getCallLog(50));
});

app.get("/api/calls/active", adminGuard, (req, res) => {
  res.json([...sessions.values()].map((s) => ({
    callSid: s.callSid, salonId: s.salon.id, direction: s.direction,
    caller: maskPhone(s.callerPhone), state: s.state,
  })));
});

app.get("/api/salons", adminGuard, (req, res) => {
  res.json([...salons.values()].map((s) => ({
    id: s.id, name: s.name, twilio_number: s.twilio_number,
    pro_email: s.pro_email || null,
    default_language: s.default_language || "fr",
    voices: s.voices || {},
    default_voice: s.default_voice || "",
    google_connected: isGoogleConnected(s.id),
  })));
});

/**
 * POST /api/calendar/event — création d'un événement Google Agenda pour un salon.
 * Utilisé par l'assistant conversationnel (page /social-media de BeautyBook)
 * qui réutilise la connexion Google du salon (mêmes tokens que les appels).
 * Protégé par adminGuard (x-admin-token).
 * Corps : { salon_id, summary, description, date (YYYY-MM-DD),
 *           start_time (HH:MM), end_time (HH:MM), client_phone }
 */
app.post("/api/calendar/event", adminGuard, async (req, res) => {
  try {
    const { salon_id, summary, description, date, start_time, end_time, client_phone } = req.body || {};
    if (!salon_id || !date || !start_time || !end_time) {
      return res.status(400).json({ ok: false, error: "salon_id, date, start_time et end_time sont requis." });
    }
    const salon = salons.get(salon_id);
    if (!salon) return res.status(404).json({ ok: false, error: "Salon inconnu." });
    if (!isGoogleConnected(salon.id)) {
      return res.json({ ok: false, error: "not_connected" });
    }
    const ev = await createCalendarEvent(salon, {
      summary: summary || "Rendez-vous",
      description,
      date,
      startTime: start_time,
      endTime: end_time,
      clientPhone: client_phone,
    });
    res.json({ ok: true, event_id: ev?.id || null, link: ev?.htmlLink || null });
  } catch (e) {
    log.error(`POST /api/calendar/event : ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Met à jour la config voix/langues d'un salon (dashboard).
 * Corps accepté : { default_language, voices, default_voice }.
 * Les autres champs (numéro, pro_email…) ne sont pas modifiables ici.
 */
app.put("/api/salons/:id/voice-config", adminGuard, (req, res) => {
  const salonId = req.params.id;
  if (!/^[a-z0-9-]+$/.test(salonId)) {
    return res.status(400).json({ error: "Identifiant de salon invalide." });
  }
  let salon;
  try {
    salon = getSalon(salonId);
  } catch {
    return res.status(404).json({ error: `Salon inconnu : ${salonId}` });
  }

  const { default_language, voices, default_voice } = req.body || {};
  const patch = {};

  if (default_language !== undefined) {
    const l = normalizeLang(default_language);
    if (!l) return res.status(400).json({ error: "default_language invalide (code ISO à 2 lettres, ex \"fr\")." });
    patch.default_language = l;
  }
  if (voices !== undefined) {
    if (typeof voices !== "object" || voices === null || Array.isArray(voices)) {
      return res.status(400).json({ error: "voices doit être un objet { langue: voice_id }." });
    }
    const clean = {};
    for (const [l, v] of Object.entries(voices)) {
      const code = normalizeLang(l);
      if (!code) return res.status(400).json({ error: `Code langue invalide : "${l}".` });
      const vid = String(v || "").trim();
      if (vid) {
        if (vid.length < 10) return res.status(400).json({ error: `Voice ID suspect pour "${code}" (trop court).` });
        clean[code] = vid;
      }
    }
    patch.voices = clean;
  }
  if (default_voice !== undefined) {
    const vid = String(default_voice || "").trim();
    if (vid && vid.length < 10) return res.status(400).json({ error: "default_voice invalide (Voice ID trop court)." });
    patch.default_voice = vid;
  }

  try {
    const file = path.join(__dirname, "..", "salons", `${salonId}.json`);
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
    const updated = reloadSalon(salonId);
    log.info(`Config voix/langues mise à jour pour le salon ${salonId} (langue défaut : ${updated.default_language}, voix : ${Object.keys(updated.voices || {}).join(", ") || "aucune"})`);
    res.json({
      ok: true,
      id: updated.id,
      default_language: updated.default_language,
      voices: updated.voices,
      default_voice: updated.default_voice || "",
    });
  } catch (err) {
    log.error(`Sauvegarde config voix (${salonId}) : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Google OAuth ───────────────────────────────────────────────────────────

app.get("/auth/google", (req, res) => {
  const salonId = req.query.salon;
  try {
    getSalon(salonId);
    res.redirect(getAuthUrl(salonId));
  } catch (err) {
    res.status(400).send(`Salon inconnu : ${salonId}`);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  const salonId = req.query.state;
  const code = req.query.code;
  if (req.query.error) return res.status(400).send(`Google : ${req.query.error}`);
  try {
    const tokens = await handleOAuthCallback(code);
    saveTokens(salonId, tokens);
    log.info(`Agenda Google connecté pour le salon ${salonId}`);
    res.send(`<h2>Agenda connecté ✔</h2><p>Le salon <b>${salonId}</b> est relié à Google Agenda. Vous pouvez fermer cette page.</p>`);
  } catch (err) {
    log.error(`OAuth Google : ${err.message}`);
    res.status(500).send(`Échec de la connexion Google : ${err.message}`);
  }
});

// ─── Divers ─────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ ok: true, salons: salons.size, activeCalls: sessions.size }));

app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Démarrage ──────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  log.info(`Serveur vocal démarré sur le port ${config.port}`);
  log.info(`Webhooks : ${config.publicBaseUrl}/voice/incoming`);
  log.info(`Dashboard : ${config.publicBaseUrl}/`);
});

// WebSocket /media (upgrade HTTP → WS sur le même port).
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname !== "/media") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleMediaConnection(ws, req));
});

// Arrêt propre.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info(`Signal ${sig} — arrêt…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// ─── Petits utilitaires TwiML ───────────────────────────────────────────────

function incomingTwimlWithCaller(salonId, caller) {
  // On fait transiter le numéro de l'appelant vers le WebSocket.
  const base = incomingTwiml(salonId);
  return base.replace("/media?", `/media?caller=${encodeURIComponent(caller || "")}&`);
}

function errorTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say language="fr-FR">Une erreur est survenue. Au revoir.</Say><Hangup/></Response>`;
}
