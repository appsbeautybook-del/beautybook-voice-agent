// ─── Historique des appels ──────────────────────────────────────────────────
// Stockage simple : en mémoire + persistance JSON dans data/calllog.json.
// (Une table Supabase dédiée pourra remplacer ce module plus tard sans
// changer son interface.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "calllog.json");
const MAX = 200;

let entries = [];
try {
  entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (!Array.isArray(entries)) entries = [];
} catch {
  entries = [];
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(entries.slice(0, MAX), null, 2));
  } catch (err) {
    log.warn(`Persistance calllog : ${err.message}`);
  }
}

export function logCallStart({ callSid, direction, salonId, from, to, context, language }) {
  const entry = {
    callSid,
    direction, // 'inbound' | 'outbound'
    salonId,
    from: from || "",
    to: to || "",
    context: context || "",
    language: language || null, // langue détectée de l'appelant (ex "fr", "en")
    startedAt: new Date().toISOString(),
    status: "en_cours",
    qualification: null, // 'qualifie' | 'non_interesse' | 'rappel_humain' | 'hors_sujet'
    summary: "",
    transcript: [],
  };
  entries.unshift(entry);
  entries = entries.slice(0, MAX);
  persist();
  return entry;
}

export function logTranscript(callSid, role, text) {
  const e = entries.find((x) => x.callSid === callSid);
  if (!e) return;
  e.transcript.push({ at: new Date().toISOString(), role, text });
  if (e.transcript.length > 60) e.transcript = e.transcript.slice(-60);
}

export function logCallEnd(callSid, { status, qualification, summary }) {
  const e = entries.find((x) => x.callSid === callSid);
  if (!e) return;
  e.status = status || "termine";
  e.endedAt = new Date().toISOString();
  if (qualification) e.qualification = qualification;
  if (summary) e.summary = summary;
  persist();
}

export function getCallLog(limit = 50) {
  return entries.slice(0, limit).map((e) => ({ ...e, transcript: e.transcript }));
}

/** Met à jour la langue détectée d'un appel en cours. */
export function setCallLanguage(callSid, language) {
  const e = entries.find((x) => x.callSid === callSid);
  if (!e) return;
  e.language = language;
  persist();
}
