// ─── TTS temps réel : ElevenLabs (voix française, streaming) ───────────────
// Demande le format ulaw_8000 : l'audio arrive déjà au format Twilio
// (mulaw 8 kHz) — aucun transcodage nécessaire, on relaie les chunks tels quels.
// Émet 'audio' (Buffer) au fil de l'eau et 'done' à la fin.

import WebSocket from "ws";
import { config } from "./config.js";
import { log } from "./logger.js";

export class TtsStream {
  constructor({ callSid, voiceId, text }) {
    this.callSid = callSid;
    this.voiceId = voiceId;
    this.text = text;
    this.cancelled = false;
    this.onAudio = null;
    this.onDone = null;
    this.onError = null;
  }

  start() {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
      `?model_id=eleven_multilingual_v2&output_format=ulaw_8000&optimize_streaming_latency=3`;

    const ws = new WebSocket(url, {
      headers: { "xi-api-key": config.elevenLabsApiKey },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.cancelled) { ws.close(); return; }
      // Message d'initialisation (voix + réglages), puis le texte.
      ws.send(JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.55, similarity_boost: 0.75 },
      }));
      ws.send(JSON.stringify({ text: this.text }));
      ws.send(JSON.stringify({ text: "" })); // "" = fin du texte
    });

    ws.on("message", (raw) => {
      if (this.cancelled) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.audio) {
        this.onAudio?.(Buffer.from(msg.audio, "base64"));
      }
      if (msg.isFinal) {
        this.finish();
      }
    });

    ws.on("error", (err) => {
      log.warn(`ElevenLabs erreur : ${err.message}`, this.callSid);
      this.onError?.(err);
      this.finish();
    });

    ws.on("close", () => this.finish());

    // Sécurité : si rien ne sort en 25 s, on abandonne ce segment.
    this.timeout = setTimeout(() => {
      log.warn("ElevenLabs timeout", this.callSid);
      this.finish();
    }, 25000);
    return this;
  }

  /** Interruption (barge-in) : stoppe la synthèse en cours. */
  cancel() {
    this.cancelled = true;
    this.finish();
  }

  finish() {
    if (this._finished) return;
    this._finished = true;
    clearTimeout(this.timeout);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.onDone?.();
  }
}

/** Voix française de repli si l'ID configuré est invalide (log + erreur claire). */
export function assertVoiceId(voiceId) {
  if (!voiceId || voiceId.length < 10) {
    throw new Error("elevenlabs_voice_id invalide dans la config du salon (voir ElevenLabs → Voices).");
  }
}
