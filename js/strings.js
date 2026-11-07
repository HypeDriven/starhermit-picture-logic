// Picture Logic — the generated pictures' name word banks; the string tables are assets/strings.json.
'use strict';

const words = (a, b, join) => ({ a, b, join });
const A = ['Lantern', 'Sprout', 'Beacon', 'Petal', 'Pebble', 'Moth', 'Acorn', 'Comet', 'Shell', 'Fern', 'Ember', 'Drift', 'Wisp', 'Bloom', 'Hollow', 'Sparrow', 'Mushroom', 'Kite', 'Anchor'];
const B = ['Fox', 'Owl', 'Whale', 'Hare', 'Wren', 'Newt', 'Crane', 'Mole', 'Lark', 'Otter', 'Finch', 'Badger', 'Heron', 'Shrew', 'Raven', 'Toad', 'Vole', 'Ibis', 'Elk', 'Wolf'];
const zip = (keys, vals) => Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
export const NAME_WORDS = {
  en: words(zip(A, A), zip(B, B), (a, b) => `${a} ${b}`),
  de: words(
    zip(A, ['Laternen', 'Spross', 'Leuchtfeuer', 'Blüten', 'Kiesel', 'Motten', 'Eichel', 'Kometen', 'Muschel', 'Farn', 'Glut', 'Treib', 'Hauch', 'Blumen', 'Mulden', 'Spatzen', 'Pilz', 'Drachen', 'Anker']),
    zip(B, ['Fuchs', 'Eule', 'Wal', 'Hase', 'Zaunkönig', 'Molch', 'Kranich', 'Maulwurf', 'Lerche', 'Otter', 'Fink', 'Dachs', 'Reiher', 'Spitzmaus', 'Rabe', 'Kröte', 'Wühlmaus', 'Ibis', 'Elch', 'Wolf']),
    (a, b) => `${a}-${b}`),
  es: words(
    zip(A, ['Farol', 'Brote', 'Faro', 'Pétalo', 'Guijarro', 'Polilla', 'Bellota', 'Cometa', 'Concha', 'Helecho', 'Ascua', 'Deriva', 'Bruma', 'Flor', 'Hondonada', 'Gorrión', 'Seta', 'Cometa de papel', 'Ancla']),
    zip(B, ['Zorro', 'Búho', 'Ballena', 'Liebre', 'Chochín', 'Tritón', 'Grulla', 'Topo', 'Alondra', 'Nutria', 'Pinzón', 'Tejón', 'Garza', 'Musaraña', 'Cuervo', 'Sapo', 'Topillo', 'Ibis', 'Alce', 'Lobo']),
    (a, b) => `${b} ${a}`),
  fr: words(
    zip(A, ['Lanterne', 'Pousse', 'Phare', 'Pétale', 'Galet', 'Phalène', 'Gland', 'Comète', 'Coquille', 'Fougère', 'Braise', 'Dérive', 'Volute', 'Floraison', 'Creux', 'Moineau', 'Champignon', 'Cerf-volant', 'Ancre']),
    zip(B, ['Renard', 'Hibou', 'Baleine', 'Lièvre', 'Roitelet', 'Triton', 'Grue', 'Taupe', 'Alouette', 'Loutre', 'Pinson', 'Blaireau', 'Héron', 'Musaraigne', 'Corbeau', 'Crapaud', 'Campagnol', 'Ibis', 'Élan', 'Loup']),
    (a, b) => `${b} ${a}`),
  pt: words(
    zip(A, ['Lanterna', 'Broto', 'Farol', 'Pétala', 'Seixo', 'Mariposa', 'Bolota', 'Cometa', 'Concha', 'Samambaia', 'Brasa', 'Deriva', 'Névoa', 'Flor', 'Vale', 'Pardal', 'Cogumelo', 'Pipa', 'Âncora']),
    zip(B, ['Raposa', 'Coruja', 'Baleia', 'Lebre', 'Corruíra', 'Tritão', 'Grou', 'Toupeira', 'Cotovia', 'Lontra', 'Tentilhão', 'Texugo', 'Garça', 'Musaranho', 'Corvo', 'Sapo', 'Rato-do-campo', 'Íbis', 'Alce', 'Lobo']),
    (a, b) => `${b} ${a}`),
  it: words(
    zip(A, ['Lanterna', 'Germoglio', 'Faro', 'Petalo', 'Ciottolo', 'Falena', 'Ghianda', 'Cometa', 'Conchiglia', 'Felce', 'Brace', 'Deriva', 'Bruma', 'Fiore', 'Conca', 'Passero', 'Fungo', 'Aquilone', 'Ancora']),
    zip(B, ['Volpe', 'Gufo', 'Balena', 'Lepre', 'Scricciolo', 'Tritone', 'Gru', 'Talpa', 'Allodola', 'Lontra', 'Fringuello', 'Tasso', 'Airone', 'Toporagno', 'Corvo', 'Rospo', 'Arvicola', 'Ibis', 'Alce', 'Lupo']),
    (a, b) => `${b} ${a}`),
};
