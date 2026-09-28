// ─── Outils (function calling) de l'agent ───────────────────────────────────
// Ce sont les "mains" de l'agent : le LLM les appelle quand il en a besoin.
// Chaque outil retourne du texte simple que le LLM reformule à l'oral.

import { getServices, getProfilPro, createReservation } from "./supabase.js";
import { getFreeSlots, dateLabelFr, spokenTime } from "./availability.js";
import { createCalendarEvent } from "./google.js";
import { formatQuestionsForCall, getQuestionsForService, summarizeAnswers } from "./questions.js";
import { log } from "./logger.js";

// ─── Définitions OpenAI (JSON Schema) ───────────────────────────────────────

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "get_services",
      description: "Liste les prestations proposées par le salon (nom, prix, durée). À appeler quand le client demande ce que fait le salon ou pour proposer un service.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Vérifie les VRAIS créneaux libres du salon pour une date et un service. La date doit être au format YYYY-MM-DD (ex : 2026-09-30). Utiliser la date du jour indiquée dans le contexte.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date au format YYYY-MM-DD" },
          service_id: { type: "string", description: "Identifiant du service (obtenu via get_services)" },
        },
        required: ["date", "service_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_service_questions",
      description: "Retourne les VRAIES questions de préparation du salon pour la catégorie du service choisi (mêmes questions que l'étape 2 du parcours de réservation BeautyBook : coiffure, tresses, ongles, maquillage...). À appeler dès que le service est choisi, AVANT de proposer les créneaux. Pose ensuite ces questions au client à l'oral, naturellement (les plus pertinentes d'abord : allergies, état, particularités), sans lire les listes de choix exhaustivement.",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "string", description: "Identifiant du service (obtenu via get_services)" },
        },
        required: ["service_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Réserve le créneau. À appeler UNIQUEMENT quand le client a confirmé : son prénom/nom, le service, la date et l'heure. Vérifie que le créneau est toujours libre avant d'écrire. Transmets les réponses aux questions de préparation dans 'answers'.",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "string", description: "Identifiant du service choisi" },
          date: { type: "string", description: "Date au format YYYY-MM-DD" },
          time_slot: { type: "string", description: "Heure au format HH:MM (ex : 10:30)" },
          client_name: { type: "string", description: "Prénom et nom du client" },
          answers: {
            type: "array",
            description: "Réponses du client aux questions de préparation (get_service_questions). Chaque réponse : la question posée et la réponse donnée.",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                answer: { type: "string" },
              },
              required: ["question", "answer"],
              additionalProperties: false,
            },
          },
        },
        required: ["service_id", "date", "time_slot", "client_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "Termine l'appel poliment. À appeler en fin de conversation avec le motif : qualifie (RDV pris ou prospect chaud avec rappel prévu), non_interesse, rappel_humain (cas complexe / réclamation / urgence), hors_sujet.",
      parameters: {
        type: "object",
        properties: {
          motif: { type: "string", enum: ["qualifie", "non_interesse", "rappel_humain", "hors_sujet"] },
          resume: { type: "string", description: "Résumé en une phrase de l'appel pour le salon" },
        },
        required: ["motif", "resume"],
        additionalProperties: false,
      },
    },
  },
];

// ─── Implémentations ────────────────────────────────────────────────────────

export async function runTool(ctx, name, args) {
  const { salon, callSid, callerPhone } = ctx;
  log.info(`Outil appelé : ${name} ${JSON.stringify(args)}`, callSid);

  switch (name) {
    case "get_services": {
      const services = await getServices(salon.pro_email);
      if (!services.length) return "Le salon n'a aucune prestation publiée pour le moment.";
      ctx.servicesCache = services;
      return services
        .map((s) => `- ${s.name || s.title} (${s.category || "soin"}) : ${s.price}€, ${s.duration_min || 60} min [id: ${s.id}]`)
        .join("\n");
    }

    case "check_availability": {
      const services = ctx.servicesCache || (await getServices(salon.pro_email));
      ctx.servicesCache = services;
      const service = services.find((s) => String(s.id) === String(args.service_id));
      if (!service) return "Service introuvable. Rappelle get_services pour la liste à jour.";
      const res = await getFreeSlots({
        proEmail: salon.pro_email,
        dateStr: args.date,
        durationMin: service.duration_min || 60,
        timezone: salon.timezone,
        callSid,
      });
      if (!res.ok) {
        if (res.reason === "no_hours") return "Les horaires du salon ne sont pas configurés dans BeautyBook : propose au client d'être rappelé par l'équipe.";
        if (res.reason === "closed") return `Le salon est fermé ce jour-là (${res.dayLabel || ""}). Propose un autre jour.`;
        if (res.reason === "conges") return "Le salon est en congés à cette date. Propose un autre jour.";
        if (res.reason === "past") return "Cette date est déjà passée. Propose une date à venir.";
        return "Impossible de vérifier les disponibilités pour cette date. Propose un rappel humain.";
      }
      if (!res.slots.length) {
        return `Aucun créneau libre le ${res.dateLabel} pour ${service.name || service.title}. Propose un autre jour.`;
      }
      ctx.lastAvailability = { service, date: args.date };
      return `Créneaux libres le ${res.dateLabel} pour ${service.name || service.title} (${service.price}€, ${service.duration_min || 60} min) : ` +
        res.slots.map((s) => s.spoken).join(", ") + ".";
    }

    case "get_service_questions": {
      const services = ctx.servicesCache || (await getServices(salon.pro_email));
      ctx.servicesCache = services;
      const service = services.find((s) => String(s.id) === String(args.service_id));
      if (!service) return "Service introuvable. Rappelle get_services pour la liste à jour.";
      const q = formatQuestionsForCall(service);
      ctx.lastQuestions = { service, questions: q.all };
      return q.text +
        `\nPose ces questions au client à l'oral, de façon naturelle et concise (les plus pertinentes d'abord : allergies, état, particularités). Ne lis pas les exemples de choix comme une liste exhaustive — propose-les seulement si le client hésite. Transmets ensuite ses réponses dans book_appointment via le paramètre answers.`;
    }

    case "book_appointment": {
      const services = ctx.servicesCache || (await getServices(salon.pro_email));
      const service = services.find((s) => String(s.id) === String(args.service_id));
      if (!service) return "ERREUR : service introuvable, ne confirme pas de RDV.";
      // Re-vérification anti double-réservation (le créneau a pu se remplir entre-temps).
      const check = await getFreeSlots({
        proEmail: salon.pro_email,
        dateStr: args.date,
        durationMin: service.duration_min || 60,
        timezone: salon.timezone,
        callSid,
      });
      const stillFree = check.ok && check.slots.some((s) => s.time === args.time_slot);
      if (!stillFree) {
        return `ERREUR : le créneau ${spokenTime(args.time_slot)} le ${dateLabelFr(args.date)} vient d'être pris. Propose un autre créneau avec check_availability.`;
      }
      const durationMin = service.duration_min || 60;
      const [h, m] = args.time_slot.split(":").map(Number);
      const endMin = h * 60 + m + durationMin;
      const endTimeSlot = `${String(Math.floor(endMin / 60) % 24).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      const profil = await getProfilPro(salon.pro_email);

      // Réponses aux questions de préparation (synchronisées avec BeautyBook).
      const answersSummary = summarizeAnswers(args.answers);
      const notes = answersSummary
        ? `Réponses aux questions de préparation : ${answersSummary}`
        : "";

      const reservation = await createReservation({
        proEmail: salon.pro_email,
        proName: profil?.nom || salon.name,
        salonName: salon.name,
        service,
        date: args.date,
        timeSlot: args.time_slot,
        endTimeSlot,
        clientName: args.client_name,
        clientPhone: callerPhone || "inconnu",
        notes,
      });

      // Agenda Google du salon (si connecté — sinon on continue sans bloquer).
      try {
        await createCalendarEvent(salon, {
          summary: `RDV BeautyBook — ${service.name || service.title} (${args.client_name})`,
          description: `Réservation ${reservation.id} — ${service.price}€, paiement sur place.`,
          date: args.date,
          startTime: args.time_slot,
          endTime: endTimeSlot,
          clientPhone: callerPhone,
        });
      } catch (err) {
        log.warn(`Agenda Google : ${err.message}`, callSid);
      }

      ctx.booked = {
        service: service.name || service.title,
        dateLabel: dateLabelFr(args.date),
        time: spokenTime(args.time_slot),
        price: service.price,
        clientName: args.client_name,
      };
      log.info(`RDV créé : ${reservation.id} — ${args.client_name}, ${args.date} ${args.time_slot}`, callSid);
      return `CONFIRMÉ : RDV enregistré pour ${args.client_name} — ${service.name || service.title}, ${dateLabelFr(args.date)} à ${spokenTime(args.time_slot)} (${service.price}€, paiement sur place). Annonce-le clairement au client et conclus l'appel.`;
    }

    case "end_call": {
      ctx.callOutcome = { motif: args.motif, resume: args.resume };
      return "OK — phrase de clôture, puis raccroche.";
    }

    default:
      return `Outil inconnu : ${name}`;
  }
}
