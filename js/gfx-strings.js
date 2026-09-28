// Picture Logic — localized strings for the Graphics settings section.
// The rest of the game is English-only; this panel follows navigator.language.
'use strict';

const en = {
  section: 'Graphics',
  quality: 'Quality',
  qualityHint: 'Choosing a quality level clears the per-category overrides.',
  auto: 'Auto (detected: {tier})',
  tier: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  renderScaleHint: 'Multiplies the screen resolution the board is drawn at.',
  fromPreset: 'From preset ({tier})',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles',
    background: 'Ambient motion', detail: 'Board detail',
  },
  val: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Static', animated: 'Animated',
    plain: 'Plain', detailed: 'Detailed',
  },
  adaptive: 'Adaptive resolution',
  adaptiveHint: 'Lowers the resolution briefly when frames run slow.',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; effects that need it are skipped.',
  flat: '3D is unavailable in this browser; graphics settings apply once it is.',
  unknownGpu: 'unknown GPU',
  words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing' },
};

const enGB = {
  ...en,
  cat: { ...en.cat, grade: 'Colour grade' },
  unknownGpu: 'unknown GPU',
};

const es = {
  section: 'Gráficos',
  quality: 'Calidad',
  qualityHint: 'Elegir un nivel de calidad borra los ajustes por categoría.',
  auto: 'Automática (detectada: {tier})',
  tier: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado',
  renderScaleHint: 'Multiplica la resolución con la que se dibuja el tablero.',
  fromPreset: 'Según la calidad ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
    antialias: 'Suavizado', reflections: 'Reflejos', particles: 'Partículas',
    background: 'Movimiento ambiental', detail: 'Detalle del tablero',
  },
  val: {
    off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado',
    plain: 'Sencillo', detailed: 'Detallado',
  },
  adaptive: 'Resolución adaptativa',
  adaptiveHint: 'Baja la resolución un momento cuando los fotogramas van lentos.',
  showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; se omiten los efectos que lo necesitan.',
  flat: 'El 3D no está disponible en este navegador; los ajustes se aplicarán cuando lo esté.',
  unknownGpu: 'GPU desconocida',
  words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin suavizado' },
};

const es419 = {
  ...es,
  renderScale: 'Escala de renderización',
  postFailed: 'El posprocesamiento no está disponible en este dispositivo; se omiten los efectos que lo necesitan.',
};

const de = {
  section: 'Grafik',
  quality: 'Qualität',
  qualityHint: 'Die Wahl einer Qualitätsstufe setzt die Einzeleinstellungen zurück.',
  auto: 'Automatisch (erkannt: {tier})',
  tier: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung',
  renderScaleHint: 'Vervielfacht die Auflösung, mit der das Brett gezeichnet wird.',
  fromPreset: 'Laut Stufe ({tier})',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel',
    background: 'Umgebungsbewegung', detail: 'Brettdetails',
  },
  val: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statisch', animated: 'Animiert',
    plain: 'Schlicht', detailed: 'Detailliert',
  },
  adaptive: 'Adaptive Auflösung',
  adaptiveHint: 'Senkt die Auflösung kurz, wenn Bilder zu langsam kommen.',
  showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte, die sie brauchen, entfallen.',
  flat: '3D ist in diesem Browser nicht verfügbar; die Einstellungen gelten, sobald es verfügbar ist.',
  unknownGpu: 'unbekannte GPU',
  words: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung', bloom: 'Leuchten', reflections: 'Spiegelungen', noAa: 'keine Kantenglättung' },
};

const fr = {
  section: 'Graphismes',
  quality: 'Qualité',
  qualityHint: 'Choisir un niveau de qualité efface les réglages par catégorie.',
  auto: 'Automatique (détecté : {tier})',
  tier: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu',
  renderScaleHint: 'Multiplie la résolution à laquelle le plateau est dessiné.',
  fromPreset: 'Selon la qualité ({tier})',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage',
    antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules',
    background: 'Mouvement ambiant', detail: 'Détail du plateau',
  },
  val: {
    off: 'Non', on: 'Oui', low: 'Basses', medium: 'Moyennes', high: 'Hautes',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statique', animated: 'Animé',
    plain: 'Simple', detailed: 'Détaillé',
  },
  adaptive: 'Résolution adaptative',
  adaptiveHint: 'Baisse brièvement la résolution quand les images ralentissent.',
  showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets qui en ont besoin sont ignorés.',
  flat: 'La 3D n’est pas disponible dans ce navigateur ; les réglages s’appliqueront dès qu’elle le sera.',
  unknownGpu: 'GPU inconnu',
  words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète', bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage' },
};

const frCA = {
  ...fr,
  auto: 'Automatique (détectée : {tier})',
  showFps: 'Afficher la fréquence d’images',
  unknownGpu: 'processeur graphique inconnu',
};

const ptBR = {
  section: 'Gráficos',
  quality: 'Qualidade',
  qualityHint: 'Escolher um nível de qualidade apaga os ajustes por categoria.',
  auto: 'Automática (detectada: {tier})',
  tier: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização',
  renderScaleHint: 'Multiplica a resolução em que o tabuleiro é desenhado.',
  fromPreset: 'Conforme a qualidade ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
    antialias: 'Suavização', reflections: 'Reflexos', particles: 'Partículas',
    background: 'Movimento ambiente', detail: 'Detalhe do tabuleiro',
  },
  val: {
    off: 'Não', on: 'Sim', low: 'Baixas', medium: 'Médias', high: 'Altas',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado',
    plain: 'Simples', detailed: 'Detalhado',
  },
  adaptive: 'Resolução adaptativa',
  adaptiveHint: 'Reduz a resolução por um instante quando os quadros ficam lentos.',
  showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste aparelho; os efeitos que dependem dele são ignorados.',
  flat: 'O 3D não está disponível neste navegador; os ajustes valerão quando estiver.',
  unknownGpu: 'GPU desconhecida',
  words: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem suavização' },
};

const it = {
  section: 'Grafica',
  quality: 'Qualità',
  qualityHint: 'Scegliere un livello di qualità azzera le impostazioni per categoria.',
  auto: 'Automatica (rilevata: {tier})',
  tier: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering',
  renderScaleHint: 'Moltiplica la risoluzione con cui viene disegnata la griglia.',
  fromPreset: 'Dalla qualità ({tier})',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
    antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle',
    background: 'Movimento ambientale', detail: 'Dettaglio della griglia',
  },
  val: {
    off: 'No', on: 'Sì', low: 'Basse', medium: 'Medie', high: 'Alte',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statico', animated: 'Animato',
    plain: 'Semplice', detailed: 'Dettagliato',
  },
  adaptive: 'Risoluzione adattiva',
  adaptiveHint: 'Abbassa per un attimo la risoluzione quando i fotogrammi rallentano.',
  showFps: 'Mostra fotogrammi al secondo',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti che la richiedono vengono saltati.',
  flat: 'Il 3D non è disponibile in questo browser; le impostazioni si applicheranno quando lo sarà.',
  unknownGpu: 'GPU sconosciuta',
  words: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza antialiasing' },
};

export const GFX_STRINGS = {
  'en-US': en, 'en-GB': enGB, 'es-419': es419, 'es-ES': es, 'de-DE': de,
  'fr-FR': fr, 'fr-CA': frCA, 'pt-BR': ptBR, 'it-IT': it,
};

/** Pick the closest supported locale for a BCP-47 tag. */
export function gfxLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(GFX_STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split('-');
  if (lang === 'en') return ['gb', 'uk', 'ie', 'au', 'nz', 'in', 'za'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'es' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'ca' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(tag) {
  return GFX_STRINGS[gfxLocale(tag)];
}
