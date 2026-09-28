// ─── Orchestrateur d'appel : WebSocket Twilio Media Streams ─────────────────
// Câble ensemble : audio Twilio (mulaw 8kHz) → Deepgram STT → OpenAI →
// ElevenLabs TTS → audio Twilio. Gère le barge-in (l'appelant coupe la
// parole à l'agent), les timeouts d'inactivité et la fin d'appel.

import { getSalon, getVoiceForLanguage, resolveCallLanguage, langName } from "./config.js";
import { SttStream } from "./stt.js";
import { TtsStream, assertVoiceId } from "./tts.js";
import { initialMessages, agentReply, detectLanguageFromText, getStrings } from "./llm.js";
import { hangupCall, maskPhone } from "./twilio.js";
import { logCallStart, logCallEnd, logTranscript, setCallLanguage } from "./calllog.js";
import { log } from "./logger.js";

const INACTIVITY_NUDGE_MS = 45_000; // "vous êtes toujours là ?" après 45 s de silence
const INACTIVITY_END_MS = 30_000;   // puis fin d'appel 30 s plus tard

/** Sessions actives (pour le dashboard et le debug). */
export const sessions = new Map();

class CallSession {
  constructor(ws, { salonId, direction, callerPhone, context }) {
    this.ws = ws;
    this.salon = getSalon(salonId);
    this.direction = direction; // 'inbound' | 'outbound'
    this.callerPhone = callerPhone || "inconnu";
    this.context = context || "";
    this.callSid = null;
    this.streamSid = null;
    this.state = "init"; // init → greeting → listening → thinking → speaking → ended
    this.stt = null;
    this.tts = null;
    this.nudgeTimer = null;
    // ─── Langue de l'appel ──────────────────────────────────────────────
    // Démarre sur la langue par défaut du salon (l'accueil est joué avant
    // que l'appelant ne parle). Dès sa première phrase, on détecte sa langue
    // réelle et on verrouille STT + LLM + TTS dessus pour tout l'appel.
    this.lang = salon.default_language || "fr";
    this.langLocked = false;
    this.deepgramLang = null;
    this.voiceFallbackLogged = false;
    this.ctx = {
      salon: this.salon,
      callSid: null,
      callerPhone: this.callerPhone,
      lang: this.lang,
      messages: initialMessages(this.salon, this.lang, { direction, callerPhone: this.callerPhone, context: this.context }),
      servicesCache: null,
      callOutcome: null,
      booked: null,
    };
    assertVoiceId(this.salon.elevenlabs_voice_id);
  }

  // ─── Cycle de vie ─────────────────────────────────────────────────────────

  onTwilioStart(msg) {
    this.callSid = msg.start.callSid;
    this.streamSid = msg.start.streamSid;
    this.ctx.callSid = this.callSid;
    sessions.set(this.callSid, this);

    logCallStart({
      callSid: this.callSid,
      direction: this.direction,
      salonId: this.salon.id,
      from: this.direction === "inbound" ? this.callerPhone : this.salon.twilio_number,
      to: this.direction === "inbound" ? this.salon.twilio_number : this.callerPhone,
      context: this.context,
    });
    log.info(`Appel ${this.direction} démarré (${maskPhone(this.callerPhone)}) — salon ${this.salon.id}`, this.callSid);

    // Démarre la transcription en mode détection auto de langue.
    this.stt = new SttStream({
      callSid: this.callSid,
      language: "auto",
      onInterim: (t) => this.onInterim(t),
      onFinal: (t) => this.onUserTurn(t),
      onLanguage: (l) => { this.deepgramLang = l; },
    });

    // L'agent salue en premier (sans attendre que l'appelant parle).
    this.speak(this.salon.greeting, "greeting");
  }

  onTwilioMedia(msg) {
    if (this.state === "ended") return;
    const chunk = Buffer.from(msg.media.payload, "base64");
    this.stt?.sendAudio(chunk);
  }

  onTwilioStop() {
    log.info("Appel terminé côté Twilio.", this.callSid);
    this.cleanup("termine");
  }

  // ─── Tours de parole ──────────────────────────────────────────────────────

  /** L'appelant commence à parler pendant que l'agent parle → on l'interrompt. */
  onInterim(text) {
    if (this.state === "speaking" && text.trim().length > 3) {
      log.debug(`Barge-in : "${text.slice(0, 40)}…"`, this.callSid);
      this.sendTwilio({ event: "clear", streamSid: this.streamSid });
      this.tts?.cancel();
      this.tts = null;
      this.state = "listening";
      this.armInactivityTimer();
    }
  }

  /** Fin du tour de l'appelant → réflexion du LLM puis réponse vocale. */
  async onUserTurn(text) {
    if (this.state === "ended" || this.state === "thinking") return;
    if (this.state === "speaking") this.onInterim(text + " "); // sécurise le barge-in
    this.state = "thinking";
    this.clearInactivityTimer();
    log.info(`Client : "${text}"`, this.callSid);
    logTranscript(this.callSid, "client", text);

    // Première phrase de l'appelant → détection + verrouillage de la langue.
    if (!this.langLocked) {
      this.langLocked = true;
      await this.resolveCallLanguage(text);
    }

    const { text: reply } = await agentReply(this.ctx, text);
    if (this.state === "ended") return;
    log.info(`Agent : "${reply.slice(0, 120)}${reply.length > 120 ? "…" : ""}"`, this.callSid);
    logTranscript(this.callSid, "agent", reply);
    this.speak(reply, "reply");
  }

  /**
   * Détecte la langue de l'appelant sur sa première phrase :
   * 1) langue vue par Deepgram (detect_language), 2) sinon mini-classification
   * par le LLM. Adopte la langue si une voix est configurée, sinon repli sur
   * la langue par défaut du salon (précisé dans les logs).
   */
  async resolveCallLanguage(firstText) {
    let detected = this.deepgramLang || this.stt?.detectedLanguage || null;
    if (!detected) {
      detected = await detectLanguageFromText(firstText);
      if (detected) log.info(`Langue détectée par classification : "${detected}"`, this.callSid);
    } else {
      log.info(`Langue détectée par Deepgram : "${detected}"`, this.callSid);
    }

    const res = resolveCallLanguage(this.salon, detected);
    if (res.fallback && res.detected) {
      log.warn(
        `Pas de voix configurée pour la langue "${res.detected}" — repli sur "${res.language}" (langue par défaut du salon).`,
        this.callSid
      );
    }

    if (res.language !== this.lang) {
      this.lang = res.language;
      this.ctx.lang = this.lang;
      // L'historique est encore vide (seul l'accueil a été joué) : on
      // reconstruit le prompt système dans la langue de l'appelant.
      this.ctx.messages = initialMessages(this.salon, this.lang, {
        direction: this.direction, callerPhone: this.callerPhone, context: this.context,
      });
      log.info(`Langue de l'appel verrouillée : "${this.lang}" (${langName(this.lang)})`, this.callSid);
    }
    // Verrouille le STT sur la langue (explicite > détection continue).
    this.stt?.switchLanguage(this.lang);
    setCallLanguage(this.callSid, this.lang);
  }

  /** Envoie un texte à la synthèse vocale puis à Twilio, morceau par morceau. */
  speak(text, kind) {
    if (this.state === "ended" || !text?.trim()) {
      this.afterSpeech(kind);
      return;
    }
    this.state = "speaking";
    // Voix choisie selon la langue de l'appel (avec repli voix par défaut).
    const { voiceId, language, fallback } = getVoiceForLanguage(this.salon, this.lang);
    if (fallback && !this.voiceFallbackLogged) {
      this.voiceFallbackLogged = true;
      log.warn(`TTS : pas de voix dédiée pour "${language}" — utilisation de la voix par défaut.`, this.callSid);
    }
    const tts = new TtsStream({ callSid: this.callSid, voiceId, text });
    this.tts = tts;
    tts.onAudio = (buf) => {
      if (this.state === "ended") return;
      this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: buf.toString("base64") } });
    };
    tts.onError = () => {
      // Repli : si la voix IA échoue, on ne reste pas muet.
      log.error("TTS en échec — repli silencieux impossible, fin d'appel.", this.callSid);
      this.cleanup("erreur_tts");
      hangupCall(this.callSid);
    };
    tts.onDone = () => {
      if (this.tts === tts) this.tts = null;
      if (this.state === "speaking") this.afterSpeech(kind);
    };
    tts.start();
  }

  /** Après chaque prise de parole de l'agent : fin d'appel ou ré-écoute. */
  afterSpeech(kind) {
    if (this.state === "ended") return;
    if (this.ctx.callOutcome) {
      const { motif, resume } = this.ctx.callOutcome;
      log.info(`Fin d'appel demandée par l'agent : ${motif} — ${resume}`, this.callSid);
      logCallEnd(this.callSid, { status: "termine", qualification: motif, summary: resume });
      this.state = "ended";
      // Laisse le temps à Twilio de jouer la fin du message avant de raccrocher.
      setTimeout(() => {
        hangupCall(this.callSid);
        this.cleanup("termine");
      }, 2500);
      return;
    }
    this.state = "listening";
    this.armInactivityTimer();
    if (kind === "greeting") {
      log.debug("Accueil joué — écoute du client.", this.callSid);
    }
  }

  // ─── Inactivité ───────────────────────────────────────────────────────────

  armInactivityTimer() {
    this.clearInactivityTimer();
    this.nudged = this.nudged || false;
    this.nudgeTimer = setTimeout(() => {
      if (this.state !== "listening") return;
      if (!this.nudged) {
        this.nudged = true;
        log.info("Inactivité : relance.", this.callSid);
        this.speak(getStrings(this.lang).nudge, "nudge");
      } else {
        log.info("Inactivité prolongée : fin d'appel.", this.callSid);
        logCallEnd(this.callSid, { status: "termine", qualification: "hors_sujet", summary: "Appel sans réponse." });
        this.state = "ended";
        hangupCall(this.callSid);
        this.cleanup("termine");
      }
    }, this.nudged ? INACTIVITY_END_MS : INACTIVITY_NUDGE_MS);
  }

  clearInactivityTimer() {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  sendTwilio(obj) {
    try {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch (err) {
      log.warn(`Envoi Twilio : ${err.message}`, this.callSid);
    }
  }

  cleanup(status) {
    if (this.state !== "ended") {
      this.state = "ended";
      logCallEnd(this.callSid || "inconnu", { status });
    }
    this.clearInactivityTimer();
    this.stt?.close();
    this.tts?.cancel();
    if (this.callSid) sessions.delete(this.callSid);
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** Point d'entrée du WebSocket /media (appelé par index.js). */
export function handleMediaConnection(ws, req) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const salonId = params.get("salon");
  const direction = params.get("direction") || "inbound";
  const callerPhone = params.get("caller") || "inconnu";
  const context = params.get("context") || "";

  let session = null;
  try {
    session = new CallSession(ws, { salonId, direction, callerPhone, context });
  } catch (err) {
    log.error(`Session refusée : ${err.message}`);
    ws.close(1008, err.message);
    return;
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.event) {
        case "connected": break;
        case "start": session.onTwilioStart(msg); break;
        case "media": session.onTwilioMedia(msg); break;
        case "stop": session.onTwilioStop(); break;
        default: log.debug(`Événement Twilio ignoré : ${msg.event}`, session.callSid);
      }
    } catch (err) {
      log.error(`Message Twilio : ${err.message}`, session.callSid);
    }
  });

  ws.on("close", () => {
    if (session.state !== "ended") {
      log.info("WebSocket fermé par Twilio.", session.callSid);
      session.cleanup("termine");
    }
  });

  ws.on("error", (err) => log.warn(`WebSocket : ${err.message}`, session?.callSid));
}
