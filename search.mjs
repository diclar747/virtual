// In-memory search over the passages stored in the database (BM25). The site is small, so
// ranking here is instant and, unlike SQL full-text ranking, weighs rare words properly.
const STOPWORDS = new Set('a al algo algun alguna como con cual cuales cuando cuanto cuanta cuantos de del donde el ella en es esa ese eso esta este esto hay la las le lo los me mi mis muy necesito no o para pero por que quiero quisiera saber se si sin sobre su sus te tengo tiene tienen tu un una uno unos y ya yo hola buenas buenos tardes gracias favor puedo podes pueden sale salen cuesta cuestan vale valen personal paraguay hago hacer hace tenes tenemos seria queria mas menos todo todos cosa ahora hoy bien bueno dale anda andan ser son esta estan fue'.split(' '));

// People do not speak with the words the site uses, so each spoken word also searches its equivalents.
const EQUIVALENTS = {
  casa: 'hogar', domicilio: 'hogar', wifi: 'internet fibra', celular: 'equipo telefono', telefono: 'equipo celular', tele: 'flow tv', television: 'flow tv', cable: 'flow tv',
  canal: 'grilla', deporte: 'deportivo futbol', robaron: 'robo denuncia', robo: 'denuncia', perdi: 'extravio denuncia', chip: 'sim', viaje: 'roaming', viajar: 'roaming', viajo: 'roaming', exterior: 'roaming',
  celu: 'celular equipo', auricular: 'audifono earbuds freepods', audifono: 'auricular earbuds', televisor: 'tv smart', parlante: 'bluetooth altavoz', cargador: 'carga', barato: 'economico menor', economico: 'barato menor', caro: 'premium', cuota: 'tarjeta', tarjeta: 'cuota credito', envio: 'entrega domicilio', envian: 'envio entrega', mandan: 'envio entrega', comprar: 'tienda',
  cambiarme: 'portabilidad', pasarme: 'portabilidad', portar: 'portabilidad', pagar: 'pago', recargar: 'recarga', cargar: 'recarga', billetera: 'pay', empresa: 'negocio', negocio: 'empresa',
  mil: '1000 1gbps giga', gb: 'giga', mb: 'mega', mbps: 'mega', lento: 'velocidad', lenta: 'velocidad', corta: 'inconveniente', cobertura: 'zona',
  uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', diez: '10', quince: '15', treinta: '30',
};

// Folds accents and trims Spanish plurals so "planes", "plan" and "Plan" are one word.
function stem(word) {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}
// Model names such as "S26" or "A16" also count by their number alone, because speech
// recognition often writes them apart ("S 26", "A 16").
function tokens(text) {
  const words = (text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9ñ]+/g) || []).filter((word) => word.length > 1 || /\d/.test(word));
  return words.flatMap((word) => {
    const model = word.match(/^[a-z]{1,2}(\d{1,3})$/);
    if (model) return [word, model[1]];
    // "128GB" in the catalogue must meet "128 gigas" as people say it.
    const size = word.match(/^(\d+)(gb|tb|mb|mbps|gbps)$/);
    if (size) return [size[1], size[2] === 'gb' ? 'giga' : size[2] === 'mb' || size[2] === 'mbps' ? 'mega' : size[2]];
    return [stem(word)];
  });
}

function bm25Field(documents) {
  const frequency = new Map();
  let total = 0;
  const entries = documents.map((text) => {
    const counts = new Map();
    const words = tokens(text);
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    for (const word of counts.keys()) frequency.set(word, (frequency.get(word) || 0) + 1);
    total += words.length;
    return { counts, length: words.length };
  });
  const average = total / Math.max(1, documents.length);
  return (index, word) => {
    const count = entries[index].counts.get(word);
    if (!count) return 0;
    const idf = Math.log(1 + (documents.length - frequency.get(word) + 0.5) / (frequency.get(word) + 0.5));
    return idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * entries[index].length / average));
  };
}

// passages: [{ url, title, heading, content, topic }] where topic describes the whole page.
export function buildIndex(passages) {
  const body = bm25Field(passages.map((passage) => `${passage.heading} ${passage.content}`));
  const topic = bm25Field(passages.map((passage) => passage.topic));
  return { passages, body, topic };
}

export function searchIndex(index, question, limit = 6) {
  if (!index?.passages.length) return [];
  const asked = [...new Set(tokens(question))].filter((word) => !STOPWORDS.has(word)).slice(0, 14);
  if (!asked.length) return [];
  // Each spoken word scores as the best of itself and its equivalents.
  const groups = asked.map((word) => [word, ...tokens(EQUIVALENTS[word] || '')]);
  const scored = index.passages.map((passage, position) => {
    let score = 0, matched = 0;
    for (const group of groups) {
      const inBody = Math.max(...group.map((word) => index.body(position, word)));
      const inTopic = Math.max(...group.map((word) => index.topic(position, word)));
      if (inBody || inTopic) matched += 1;
      // What the page is about counts double: it puts "pack ilimitado" on the unlimited packs page.
      score += inBody + 2 * inTopic;
    }
    // A passage answering every part of the question beats one that repeats a single word.
    return { passage, score: score * (0.5 + 0.5 * matched / groups.length) };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  // At most three passages per page, so one long page cannot crowd out the rest.
  const perPage = new Map(), results = [];
  for (const entry of scored) {
    const used = perPage.get(entry.passage.url) || 0;
    if (used >= 3) continue;
    perPage.set(entry.passage.url, used + 1);
    results.push({ ...entry.passage, rank: entry.score });
    if (results.length >= limit) break;
  }
  return results;
}
