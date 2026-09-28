// ─── Logger minimaliste ─────────────────────────────────────────────────────
// Format : [heure] [niveau] [callSid?] message
// Les secrets ne doivent JAMAIS transiter par ici (voir config.js : les clés
// sont masquées à l'affichage).

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function fmt(level, msg, callSid) {
  const ctx = callSid ? ` [${String(callSid).slice(-6)}]` : "";
  return `[${ts()}] [${level}]${ctx} ${msg}`;
}

export const log = {
  info: (msg, callSid) => console.log(fmt("INFO", msg, callSid)),
  warn: (msg, callSid) => console.warn(fmt("WARN", msg, callSid)),
  error: (msg, callSid) => console.error(fmt("ERROR", msg, callSid)),
  debug: (msg, callSid) => {
    if (process.env.LOG_LEVEL === "debug") console.log(fmt("DEBUG", msg, callSid));
  },
};
