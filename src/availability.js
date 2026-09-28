// ─── Disponibilités : miroir de la logique BeautyBook ────────────────────────
// Reproduit fidèlement :
//   - src/lib/hours.js (interprétation des horaires : mode nuit, congés,
//     objet ouverture vide = absent)
//   - src/components/reservation/StepCalendar.jsx (génération des créneaux,
//     chevauchement avec buffer de 15 min)
//
// Différence assumée avec l'app : si les horaires ne sont PAS configurés, on
// ne retombe PAS sur un 09h-19h factice — on le signale (l'agent proposera
// alors un rappel humain plutôt qu'un faux créneau).

import { getProfilPro, getActiveReservations } from "./supabase.js";
import { log } from "./logger.js";

export const DAY_KEYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
export const DAY_KEYS_JS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
export const BUFFER_MIN = 15; // transition/nettoyage entre deux prestations
export const NIGHT_START = "09:00";
export const NIGHT_END = "07:00";

// ─── Utilitaires temps ──────────────────────────────────────────────────────

export function timeToMin(t) {
  if (!t || typeof t !== "string") return null;
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

export function addMinutes(t, mins) {
  const total = timeToMin(t) + mins;
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return timeToMin(aStart) < timeToMin(bEnd) && timeToMin(aEnd) > timeToMin(bStart);
}

export function isOvernight(start, end) {
  const s = timeToMin(start);
  const e = timeToMin(end);
  return s != null && e != null && e <= s;
}

/** "10:30" → "10h30", "10:00" → "10h" (pour la synthèse vocale). */
export function spokenTime(t) {
  const [h, m] = t.split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

/** Date + heure actuelles dans un fuseau (défaut : Europe/Paris). */
export function nowInTz(tz = "Europe/Paris") {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (k) => parts.find((p) => p.type === k)?.value;
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { dateStr, minutes };
}

/** "lundi 30 septembre" pour une date YYYY-MM-DD. */
export function dateLabelFr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" })
    .format(new Date(y, m - 1, d));
}

// ─── Horaires (miroir hours.js) ─────────────────────────────────────────────

function parseMaybeJson(v) {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export function hasHoursData(ouverture) {
  if (!ouverture || typeof ouverture !== "object") return false;
  return DAY_KEYS.some((k) => {
    const d = ouverture[k];
    return d && typeof d === "object" && (d.open === true || d.open === false || d.start || d.end);
  });
}

export function applyNightMode(ouverture, travailNuit) {
  if (!travailNuit || !hasHoursData(ouverture)) return ouverture;
  const night = {};
  DAY_KEYS.forEach((k) => {
    const d = ouverture[k];
    night[k] = d && d.open ? { ...d, start: NIGHT_START, end: NIGHT_END } : d;
  });
  if (ouverture.conges) night.conges = ouverture.conges;
  return night;
}

/** Horaires effectifs : ouverture, sinon horaires (même priorité que l'app). */
export function getEffectiveOpening(profil) {
  if (!profil) return null;
  const ouv = parseMaybeJson(profil.ouverture);
  if (hasHoursData(ouv)) return applyNightMode(ouv, profil.travail_nuit);
  const hor = parseMaybeJson(profil.horaires);
  if (hasHoursData(hor)) return applyNightMode(hor, profil.travail_nuit);
  return null;
}

function isInConges(dateStr, ouverture) {
  const conges = parseMaybeJson(ouverture)?.conges || [];
  if (!conges.length) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const ts = new Date(y, m - 1, d, 12, 0, 0).getTime();
  return conges.some((c) => {
    if (!c?.start || !c?.end) return false;
    const s = new Date(c.start + "T00:00:00").getTime();
    const e = new Date(c.end + "T23:59:59").getTime();
    return ts >= s && ts <= e;
  });
}

// ─── Génération des créneaux (miroir StepCalendar.generateSlotsForDay) ──────

function generateSlotsForDay(dateStr, ouverture, duration) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dayKey = DAY_KEYS_JS[date.getDay()];
  const dayConfig = ouverture[dayKey];

  if (!dayConfig || dayConfig.open === false || dayConfig.open === "false") {
    return { open: false, reason: "closed", dayLabel: dayKey };
  }
  if (isInConges(dateStr, ouverture)) {
    return { open: false, reason: "conges" };
  }

  const openMin = timeToMin(dayConfig.start || "09:00");
  const closeMin = timeToMin(dayConfig.end || "18:00");
  const overnightRange = closeMin <= openMin;
  const endCursor = overnightRange ? closeMin + 24 * 60 : closeMin;

  const interval = duration + BUFFER_MIN;
  const slots = [];
  let cursor = openMin;
  while (cursor + duration <= endCursor) {
    const h = Math.floor(cursor / 60) % 24;
    const min = cursor % 60;
    const slotStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    const endStr = addMinutes(slotStr, duration);
    // Pause déjeuner éventuelle
    const inPause = dayConfig.pause_start && dayConfig.pause_end &&
      timeToMin(slotStr) < timeToMin(dayConfig.pause_end) &&
      timeToMin(endStr) > timeToMin(dayConfig.pause_start);
    if (!inPause) slots.push(slotStr);
    cursor += interval;
  }
  return { open: true, slots };
}

// ─── API principale ─────────────────────────────────────────────────────────

/**
 * Créneaux réellement libres pour un salon, une date et une durée de service.
 * Retourne { ok, slots: [{time, spoken}], dateLabel, reason? }.
 */
export async function getFreeSlots({ proEmail, dateStr, durationMin = 60, limit = 8, timezone = "Europe/Paris", callSid }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) {
    return { ok: false, reason: "bad_date" };
  }
  const now = nowInTz(timezone);
  if (dateStr < now.dateStr) {
    return { ok: false, reason: "past", dateLabel: dateLabelFr(dateStr) };
  }

  const profil = await getProfilPro(proEmail);
  if (!profil) {
    log.warn(`ProfilPro introuvable pour ${proEmail}`, callSid);
    return { ok: false, reason: "no_profil" };
  }
  const ouverture = getEffectiveOpening(profil);
  if (!ouverture) {
    // Pas d'horaires configurés : on ne fabrique PAS de créneaux.
    return { ok: false, reason: "no_hours" };
  }

  const gen = generateSlotsForDay(dateStr, ouverture, durationMin);
  if (!gen.open) {
    return { ok: false, reason: gen.reason, dateLabel: dateLabelFr(dateStr), dayLabel: gen.dayLabel };
  }

  // Réservations actives du jour → on retire les créneaux qui se chevauchent
  // (avec buffer, même logique que StepCalendar).
  const reservations = await getActiveReservations(proEmail, dateStr);
  const isToday = dateStr === now.dateStr;

  const free = gen.slots.filter((slot) => {
    if (isToday && timeToMin(slot) <= now.minutes) return false; // créneau déjà passé
    const slotEnd = addMinutes(slot, durationMin);
    const slotEndBuf = addMinutes(slotEnd, BUFFER_MIN);
    const clash = reservations.some((r) => {
      const resaStart = r.time_slot;
      if (!resaStart) return false;
      const resaEnd = r.end_time_slot || addMinutes(resaStart, r.duration_min || 60);
      const resaEndBuf = addMinutes(resaEnd, BUFFER_MIN);
      return overlaps(slot, slotEndBuf, resaStart, resaEndBuf);
    });
    return !clash;
  });

  return {
    ok: true,
    dateLabel: dateLabelFr(dateStr),
    slots: free.slice(0, limit).map((time) => ({ time, spoken: spokenTime(time) })),
    totalFree: free.length,
  };
}
