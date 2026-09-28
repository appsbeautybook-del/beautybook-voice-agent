// ─── STT temps réel : Deepgram (multilingue) ────────────────────────────────
// Reçoit l'audio brut mulaw 8kHz de Twilio et émet des événements :
//   - 'interim'  : transcription partielle (sert au barge-in)
//   - 'final'    : phrase complète de l'appelant (speech_final = fin de tour)
//   - 'language' : langue détectée (code ISO 639-1, ex "fr") — une seule fois
// Connexion WebSocket brute (sans SDK) : wss://api.deepgram.com/v1/listen.
//
// Mode "auto" (défaut en début d'appel) : Deepgram détecte la langue parlée.
// Ensuite l'appelant verrouille la langue via switchLanguage() pour le reste
// de l'appel (meilleure précision que la détection continue).

import WebSocket from "ws";
import { config, normalizeLang } from "./config.js";
import { log } from "./logger.js";

const DG_BASE =
  "wss://api.deepgram.com/v1/listen" +
  "?encoding=mulaw" +
  "&sample_rate=8000" +
  "&channels=1" +
  "&model=nova-2" +
  "&smart_format=true" +
  "&interim_results=true" +
  "&endpointing=400" + // silence de 400 ms = fin de tour de parole
  "&utterance_end_ms=1200";

export class SttStream {
  constructor({ callSid, language = "auto", onInterim, onFinal, onLanguage }) {
    this.callSid = callSid;
    this.language = normalizeLang(language) || "auto"; // "auto" | "fr" | "en" | …
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onLanguage = onLanguage;
    this.detectedLanguage = null;
    this.closed = false;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.suppressReconnectOnce = false;
    this.audioBuffer = []; // audio reçu pendant une reconnexion
    this.connect();
  }

  buildUrl() {
    // En mode auto, Deepgram détecte la langue dominante du flux audio.
    if (this.language === "auto") return DG_BASE + "&detect_language=true";
    return DG_BASE + `&language=${encodeURIComponent(this.language)}`;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.buildUrl(), {
      headers: { Authorization: `Token ${config.deepgramApiKey}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      log.debug(`Deepgram connecté (langue : ${this.language})`, this.callSid);
      this.reconnectAttempts = 0;
      // Rejoue l'audio bufferisé pendant la coupure.
      for (const chunk of this.audioBuffer) this.sendAudio(chunk);
      this.audioBuffer = [];
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== "Results") return;

      // Langue détectée par Deepgram (une seule notification par flux).
      if (!this.detectedLanguage && msg.channel?.detected_language) {
        const l = normalizeLang(msg.channel.detected_language);
        if (l) {
          this.detectedLanguage = l;
          log.debug(`Deepgram : langue détectée "${l}"`, this.callSid);
          this.onLanguage?.(l);
        }
      }

      const alt = msg.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      if (!text) return;
      if (msg.is_final && msg.speech_final) {
        this.onFinal?.(text);
      } else if (!msg.is_final) {
        this.onInterim?.(text);
      }
    });

    ws.on("error", (err) => log.warn(`Deepgram erreur : ${err.message}`, this.callSid));

    ws.on("close", (code) => {
      if (this.closed) return;
      if (this.suppressReconnectOnce) {
        // Fermeture volontaire (changement de langue) : pas de reconnexion auto ici,
        // connect() est rappelé explicitement par switchLanguage().
        this.suppressReconnectOnce = false;
        return;
      }
      log.warn(`Deepgram fermé (code ${code}) — reconnexion…`, this.callSid);
      this.ws = null;
      this.reconnectAttempts++;
      const delay = Math.min(1000 * this.reconnectAttempts, 5000);
      setTimeout(() => this.connect(), delay);
    });
  }

  /**
   * Verrouille la langue pour le reste de l'appel : reconnecte Deepgram avec
   * la langue explicite (plus précis que la détection continue).
   */
  switchLanguage(lang) {
    const l = normalizeLang(lang);
    if (!l || l === this.language || this.closed) return;
    log.info(`STT : langue verrouillée → "${l}"`, this.callSid);
    this.language = l;
    this.detectedLanguage = l;
    this.suppressReconnectOnce = true;
    try { this.ws?.terminate(); } catch { /* ignore */ }
    this.ws = null;
    this.connect();
  }

  /** Envoie un chunk audio mulaw brut (Buffer) à Deepgram. */
  sendAudio(chunk) {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else {
      // Bufferise (max ~5 s) pour ne pas perdre le début de phrase.
      if (this.audioBuffer.length < 250) this.audioBuffer.push(chunk);
    }
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
