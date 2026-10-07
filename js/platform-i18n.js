// Picture Logic — strings for the StarHermit account controls (sign-in, invite,
// sign-out notice), in the nine supported locales. Follows the browser
// language.

const EN_US = {
  signIn: "Sign in with StarHermit",
  invite: "Invite a friend",
  inviteCopied: "Invite link copied to the clipboard.",
  inviteFailed: "Copy this invite link: {link}",
  signedOut: "Signed out of StarHermit — progress keeps saving on this device.",
  lbPosting: "Posting score to the leaderboard…",
  lbRank: "Leaderboard rank: #{rank}",
  lbPosted: "Score posted to the leaderboard.",
  lbFailed: "Score not posted to the leaderboard.",
};

const STRINGS = {
  "en-US": EN_US,
  "en-GB": { ...EN_US },
  "es-419": {
    signIn: "Iniciar sesión con StarHermit",
    invite: "Invitar a un amigo",
    inviteCopied: "Enlace de invitación copiado al portapapeles.",
    inviteFailed: "Copia este enlace de invitación: {link}",
    signedOut: "Se cerró la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.",
    lbPosting: "Publicando la puntuación en la clasificación…",
    lbRank: "Puesto en la clasificación: #{rank}",
    lbPosted: "Puntuación publicada en la clasificación.",
    lbFailed: "No se publicó la puntuación en la clasificación.",
  },
  "es-ES": {
    signIn: "Iniciar sesión con StarHermit",
    invite: "Invitar a un amigo",
    inviteCopied: "Enlace de invitación copiado al portapapeles.",
    inviteFailed: "Copia este enlace de invitación: {link}",
    signedOut: "Se ha cerrado la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.",
    lbPosting: "Publicando la puntuación en la clasificación…",
    lbRank: "Puesto en la clasificación: #{rank}",
    lbPosted: "Puntuación publicada en la clasificación.",
    lbFailed: "No se ha publicado la puntuación en la clasificación.",
  },
  "de-DE": {
    signIn: "Mit StarHermit anmelden",
    invite: "Freund einladen",
    inviteCopied: "Einladungslink in die Zwischenablage kopiert.",
    inviteFailed: "Kopiere diesen Einladungslink: {link}",
    signedOut: "Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert.",
    lbPosting: "Punktzahl wird in die Bestenliste eingetragen…",
    lbRank: "Platz in der Bestenliste: #{rank}",
    lbPosted: "Punktzahl in die Bestenliste eingetragen.",
    lbFailed: "Punktzahl nicht in die Bestenliste eingetragen.",
  },
  "fr-FR": {
    signIn: "Se connecter avec StarHermit",
    invite: "Inviter un ami",
    inviteCopied: "Lien d’invitation copié dans le presse-papiers.",
    inviteFailed: "Copiez ce lien d’invitation : {link}",
    signedOut: "Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.",
    lbPosting: "Envoi du score au classement…",
    lbRank: "Rang au classement : #{rank}",
    lbPosted: "Score envoyé au classement.",
    lbFailed: "Score non envoyé au classement.",
  },
  "fr-CA": {
    signIn: "Se connecter avec StarHermit",
    invite: "Inviter un ami",
    inviteCopied: "Lien d’invitation copié dans le presse-papiers.",
    inviteFailed: "Copiez ce lien d’invitation : {link}",
    signedOut: "Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.",
    lbPosting: "Envoi du pointage au classement…",
    lbRank: "Rang au classement : #{rank}",
    lbPosted: "Pointage envoyé au classement.",
    lbFailed: "Pointage non envoyé au classement.",
  },
  "pt-BR": {
    signIn: "Entrar com StarHermit",
    invite: "Convidar um amigo",
    inviteCopied: "Link de convite copiado para a área de transferência.",
    inviteFailed: "Copie este link de convite: {link}",
    signedOut: "Você saiu do StarHermit — o progresso continua salvo neste dispositivo.",
    lbPosting: "Enviando a pontuação para o ranking…",
    lbRank: "Posição no ranking: #{rank}",
    lbPosted: "Pontuação enviada para o ranking.",
    lbFailed: "Pontuação não enviada para o ranking.",
  },
  "it-IT": {
    signIn: "Accedi con StarHermit",
    invite: "Invita un amico",
    inviteCopied: "Link di invito copiato negli appunti.",
    inviteFailed: "Copia questo link di invito: {link}",
    signedOut: "Disconnesso da StarHermit: i progressi continuano a essere salvati su questo dispositivo.",
    lbPosting: "Invio del punteggio alla classifica…",
    lbRank: "Posizione in classifica: #{rank}",
    lbPosted: "Punteggio inviato alla classifica.",
    lbFailed: "Punteggio non inviato alla classifica.",
  },
};

export const PLATFORM_LOCALES = Object.keys(STRINGS);

/** Best supported locale for a BCP-47 tag or list of tags. */
export function pickPlatformLocale(tags) {
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean).map(String);
  for (const tag of list) {
    const t = tag.replace("_", "-");
    const exact = PLATFORM_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
    if (exact) return exact;
    const [lang, region = ""] = t.split("-");
    const r = region.toUpperCase();
    switch (lang.toLowerCase()) {
      case "en": return r === "GB" || r === "UK" ? "en-GB" : "en-US";
      case "es": return r === "ES" ? "es-ES" : "es-419";
      case "fr": return r === "CA" ? "fr-CA" : "fr-FR";
      case "pt": return "pt-BR";
      case "de": return "de-DE";
      case "it": return "it-IT";
    }
  }
  return "en-US";
}

export function platformStrings(locale) {
  return STRINGS[locale] || EN_US;
}

/** Strings for the browser's language (or an explicit locale). */
export function currentPlatformStrings(locale) {
  if (locale) return platformStrings(pickPlatformLocale(locale));
  const langs = typeof navigator !== "undefined" ? (navigator.languages || [navigator.language]) : [];
  return platformStrings(pickPlatformLocale(langs));
}
