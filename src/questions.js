// ─── Questions de préparation par catégorie — synchronisées avec BeautyBook ──
// Source unique : l'app BeautyBook publie public/questionnaires.json à
// https://thelastjiren.vercel.app/questionnaires.json (généré au build depuis
// src/lib/questionnaires.js). Ce module le charge au démarrage, avec une
// copie locale de secours (data/questionnaires.json) et un rafraîchissement
// périodique. Les questions posées par l'agent vocal sont donc toujours les
// mêmes que celles de l'étape 2 du parcours de réservation web.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const QUESTIONNAIRES_URL =
  process.env.QUESTIONNAIRES_URL || "https://thelastjiren.vercel.app/questionnaires.json";

let cache = null; // { version, updatedAt, categories }

const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function loadLocalFallback() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "data", "questionnaires.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Charge (ou recharge) les questionnaires depuis BeautyBook. */
export async function loadQuestionnaires() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(QUESTIONNAIRES_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.categories) throw new Error("format inattendu");
    cache = data;
    log.info(`Questionnaires synchronisés : v${data.version}, ${Object.keys(data.categories).length} catégories`);
    return true;
  } catch (err) {
    log.warn(`Questionnaires distants injoignables (${err.message}) — repli local`);
    const local = loadLocalFallback();
    if (local && !cache) {
      cache = local;
      log.info(`Questionnaires locaux chargés : v${local.version}`);
    }
    return false;
  }
}

export function getQuestionnairesVersion() {
  return cache?.version ?? null;
}

function detectCategory(service = {}) {
  const fields = [service.category, service.name, service.title, service.subcategory, service.style].map(norm);
  const has = (...keys) => fields.some((v) => keys.some((k) => v.includes(k)));
  if (has("tresse", "braid", "natte", "vanille", "locs", "cornrow")) return "tresses";
  if (has("cil", "sourcil", "lash", "brow")) return "cils";
  if (has("coiff", "cheveu", "lissage", "coloration", "coupe", "brushing", "chignon")) return "coiffure";
  if (has("ongle", "manucure", "manucur", "pedicure", "nail")) return "ongles";
  if (has("maquillage", "makeup", "maquilleur")) return "maquillage";
  if (has("barbe", "rasage", "barbier")) return "barbe";
  if (has("massage", "spa", "bien-etre", "relax", "hammam")) return "massage";
  if (has("epilation", "epil")) return "epilation";
  if (has("soin", "visage", "peau", "facial", "gommage", "hydra")) return "soin_visage";
  return "general";
}

/** Questionnaire complet pour un service : { key, label, tip, questions }. */
export function getQuestionsForService(service = {}) {
  const cats = cache?.categories;
  const key = detectCategory(service);
  const cat = cats?.[key] || cats?.general;
  if (!cat) return { key: "general", label: "Préparation", tip: "", questions: [] };
  return { key, label: cat.label, tip: cat.tip || "", questions: cat.questions || [] };
}

/**
 * Texte compact pour l'outil get_service_questions (reformulé à l'oral par l'agent).
 * On limite aux questions les plus pertinentes à l'oral : l'agent les pose
 * naturellement, sans lire les listes de choix exhaustivement.
 */
export function formatQuestionsForCall(service = {}, maxQuestions = 6) {
  const { label, questions } = getQuestionsForService(service);
  const picked = questions.slice(0, maxQuestions);
  const lines = picked.map((q, i) => {
    const choices = q.options && q.options.length ? ` (ex : ${q.options.slice(0, 3).join(", ")})` : "";
    return `${i + 1}. ${q.question}${choices}`;
  });
  return {
    categoryLabel: label,
    count: picked.length,
    total: questions.length,
    text:
      `Questions de préparation — catégorie « ${label} » (${picked.length} questions) :\n` +
      lines.join("\n"),
    all: picked,
  };
}

/** "Question → Réponse ; ..." pour les notes de la réservation. */
export function summarizeAnswers(pairs = []) {
  return (pairs || [])
    .filter((p) => p && p.question && p.answer)
    .map((p) => `${p.question} → ${p.answer}`)
    .join(" ; ");
}
