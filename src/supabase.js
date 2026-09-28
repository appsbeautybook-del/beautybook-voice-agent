// ─── Client Supabase (clé service_role) ─────────────────────────────────────
// La clé service_role contourne les règles RLS : le serveur peut lire les
// profils/horaires/services et écrire les réservations pour tous les salons.
// Elle ne doit JAMAIS être exposée au navigateur ni committée.

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Accès métier BeautyBook ────────────────────────────────────────────────

/** Profil pro (horaires, nom du salon...) — sélectionné par email pro. */
export async function getProfilPro(proEmail) {
  const { data, error } = await supabase
    .from("ProfilPro")
    .select("email, nom, salon_nom, ouverture, horaires, travail_nuit, telephone, ville, adresse")
    .ilike("email", proEmail)
    .limit(5);
  if (error) throw new Error(`ProfilPro: ${error.message}`);
  if (!data || data.length === 0) return null;
  // S'il y a des doublons, on prend le profil le plus complet (même logique que l'app).
  const score = (p) => (p.nom ? 1 : 0) + (p.ouverture ? 2 : 0) + (p.salon_nom ? 1 : 0);
  return data.sort((a, b) => score(b) - score(a))[0];
}

/** Prestations actives du salon (table Service). */
export async function getServices(proEmail) {
  const { data, error } = await supabase
    .from("Service")
    .select("id, name, title, description, category, price, duration_min, status")
    .ilike("pro_email", proEmail)
    .order("category", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Service: ${error.message}`);
  // On ne propose que les prestations publiées (pas les brouillons).
  return (data || []).filter((s) => (s.status || "publie") !== "brouillon");
}

/** Réservations actives d'un pro pour une date donnée (YYYY-MM-DD). */
export async function getActiveReservations(proEmail, dateStr) {
  const { data, error } = await supabase
    .from("Reservation")
    .select("time_slot, end_time_slot, duration_min, persons, status")
    .ilike("pro_email", proEmail)
    .eq("date", dateStr)
    .in("status", ["en_attente", "confirme"])
    .limit(500);
  if (error) throw new Error(`Reservation: ${error.message}`);
  return data || [];
}

/**
 * Écrit une réservation prise par l'agent vocal.
 * - status 'en_attente' : le salon la confirme ensuite dans Gestion Agenda.
 * - payment_type 'surplace' + payment_status 'non_paye' : le client paie au salon
 *   (contraintes CHECK de la table : voir FIX_RESERVATION.sql du repo BeautyBook).
 * - client_email est NOT NULL : sans email, on utilise un identifiant déterministe
 *   basé sur le téléphone (tel:+336...@phone.local). Le vrai numéro est en notes.
 */
export async function createReservation({
  proEmail,
  proName,
  salonName,
  service,
  date,
  timeSlot,
  endTimeSlot,
  clientName,
  clientPhone,
  notes,
}) {
  const payload = {
    client_email: `tel:${clientPhone.replace(/\s/g, "")}@phone.local`,
    client_name: clientName,
    pro_email: proEmail,
    pro_name: proName || "",
    service_id: service.id,
    service_name: service.name || service.title,
    service_price: service.price || 0,
    date,
    time_slot: timeSlot,
    duration_min: service.duration_min || 60,
    end_time_slot: endTimeSlot,
    persons: 1,
    total_price: service.price || 0,
    payment_type: "surplace",
    payment_status: "non_paye",
    status: "en_attente",
    notes: [`RDV pris par l'assistante vocale IA. Tél client : ${clientPhone}.`, notes].filter(Boolean).join(" "),
    salon_name: salonName || "",
  };
  const { data, error } = await supabase.from("Reservation").insert(payload).select().single();
  if (error) throw new Error(`Insert Reservation: ${error.message}`);
  return data;
}
