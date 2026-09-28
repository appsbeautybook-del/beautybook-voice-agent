// ─── Twilio : TwiML entrant + appels sortants (REST) ─────────────────────────

import twilio from "twilio";
import { config } from "./config.js";
import { log } from "./logger.js";

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

/**
 * TwiML renvoyé quand un appel arrive sur le numéro d'un salon.
 * <Connect><Stream> ouvre un flux audio bidirectionnel (mulaw 8kHz) vers
 * notre WebSocket /media — c'est là que vit l'agent vocal.
 */
export function incomingTwiml(salonId) {
  const streamUrl = `wss://${wsHost()}/media?salon=${encodeURIComponent(salonId)}&direction=inbound`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" track="inbound_track">
      <Parameter name="salon" value="${salonId}" />
    </Stream>
  </Connect>
</Response>`;
}

/**
 * TwiML pour un appel SORTANT : identique, mais on transmet en plus le
 * contexte de campagne (ex : nom du prospect, motif) au WebSocket.
 */
export function outboundTwiml(salonId, context = "") {
  const streamUrl = `wss://${wsHost()}/media?salon=${encodeURIComponent(salonId)}&direction=outbound&context=${encodeURIComponent(context || "")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" track="inbound_track">
      <Parameter name="salon" value="${salonId}" />
    </Stream>
  </Connect>
</Response>`;
}

/** Hôte du WebSocket déduit de PUBLIC_BASE_URL (https://x → x). */
function wsHost() {
  return config.publicBaseUrl.replace(/^https:\/\//, "");
}

/**
 * Déclenche un appel sortant vers `to` (format E.164, ex +33612345678)
 * depuis le numéro Twilio du salon.
 */
export async function startOutboundCall({ salon, to, context }) {
  const voiceUrl = `${config.publicBaseUrl}/voice/outbound?salon=${encodeURIComponent(salon.id)}&context=${encodeURIComponent(context || "")}`;
  const statusUrl = `${config.publicBaseUrl}/voice/status?salon=${encodeURIComponent(salon.id)}`;
  log.info(`Appel sortant vers ${maskPhone(to)} depuis ${salon.twilio_number} (salon ${salon.id})`);
  const call = await client.calls.create({
    to,
    from: salon.twilio_number,
    url: voiceUrl,
    statusCallback: statusUrl,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    timeout: 30,
  });
  return call.sid;
}

/** Raccroche un appel en cours (utilisé par l'outil end_call du LLM). */
export async function hangupCall(callSid) {
  try {
    await client.calls(callSid).update({ status: "completed" });
  } catch (err) {
    log.warn(`Raccrochage ${callSid} : ${err.message}`);
  }
}

/** Masque un numéro dans les logs (+33612****78). */
export function maskPhone(phone) {
  const p = String(phone || "");
  return p.length > 6 ? `${p.slice(0, 6)}****${p.slice(-2)}` : "****";
}
