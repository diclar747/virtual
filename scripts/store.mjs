// Reads the whole catalogue of tienda.personal.com.py (a VTEX shop) through its public
// product API, plus its help pages, and returns them in the same shape as scripts/crawl.mjs.
const STORE = 'https://tienda.personal.com.py';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (asistente-demo)' };
const HELP = ['como-comprar', 'metodos-de-pago', 'metodos-de-envio', 'preguntas-frecuentes'];
const SPECS = ['Sistema Operativo', 'Procesador', 'Memoria RAM', 'Memoria Interna', 'Pantalla', 'Tamaño de pantalla', 'Resolución', 'Cámara Principal', 'Camara Principal', 'Camara Frontal', 'Capacidad de Bateria', 'Carga Rapida', 'Carga Inalambrica', 'NFC', 'Peso', 'Características', 'Características técnicas', 'Especificaciones', 'Tecnología', 'Sonido', 'Dimensiones'];
const PLAN = ['Minutos Ilimitados a todas las compañías', 'Mensajes Ilimitados a todas las compañías', 'Beneficios', 'Roaming'];

const money = (value) => `Gs. ${Math.round(value).toLocaleString('es-PY').replace(/,/g, '.')}`;
const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const field = (product, name) => (Array.isArray(product[name]) ? product[name].map(plain).filter(Boolean).join(', ') : '');
const offer = (item) => item.sellers?.[0]?.commertialOffer || {};

async function getJson(url) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(40000) });
  if (!response.ok) throw new Error(`La tienda respondió ${response.status}`);
  return response.json();
}

async function products() {
  const all = [];
  for (let from = 0; from < 2500; from += 50) {
    const batch = await getJson(`${STORE}/api/catalog_system/pub/products/search?_from=${from}&_to=${from + 49}`);
    all.push(...batch);
    if (batch.length < 50) break;
  }
  return all;
}

// Card instalments as the shop publishes them: the longest plan and a few shorter ones.
function instalments(commercial) {
  const plans = new Map();
  for (const option of commercial.Installments || []) {
    if (/google pay/i.test(option.PaymentSystemName)) continue;
    const known = plans.get(option.NumberOfInstallments) || { value: option.Value, cards: new Set() };
    known.cards.add(option.PaymentSystemName);
    plans.set(option.NumberOfInstallments, known);
  }
  if (plans.size < 2) return '';
  const counts = [...plans.keys()].sort((a, b) => b - a);
  const shown = [...new Set([counts[0], 18, 12, 6, 3].filter((count) => plans.has(count)))];
  const cards = [...plans.get(counts[0]).cards].join(', ');
  return `Cuotas con tarjeta de crédito (${cards}): ${shown.map((count) => `${count} cuotas de ${money(plans.get(count).value)}`).join('; ')}.`;
}

function describe(product) {
  const category = (product.categories?.[0] || '').split('/').filter(Boolean).join(' › ');
  const combo = /Teléfono \+ Plan/.test(category);
  const plan = /Planes Pospago/.test(category);
  const available = product.items.filter((item) => offer(item).IsAvailable && offer(item).Price > 0);
  const lines = [`${product.productName} — marca ${product.brand}. Categoría de la tienda: ${category}.`];
  if (!available.length) lines.push('Sin stock en la tienda en este momento.');
  else if (combo || plan) {
    const prices = available.map((item) => `${/migra/i.test(item.name) ? 'migrando tu línea Personal' : 'con línea nueva'} ${money(offer(item).Price)}`);
    lines.push(`Precio mensual publicado ${plan ? 'del plan' : 'del combo teléfono más plan'}: ${[...new Set(prices)].join('; ')}.`);
    if (combo) lines.push('El combo incluye el plan pospago y la cuota del equipo en una sola factura mensual.');
  } else {
    const commercial = offer(available[0]);
    const discount = commercial.ListPrice > commercial.Price ? ` Antes ${money(commercial.ListPrice)}: ${Math.round((1 - commercial.Price / commercial.ListPrice) * 100)}% de descuento.` : '';
    lines.push(`Precio al contado: ${money(commercial.Price)}.${discount} Disponible.`);
    const cards = instalments(commercial);
    if (cards) lines.push(cards);
  }
  const conditions = field(product, 'Descripción SKU');
  if (conditions && conditions !== 'Descripción SKU') lines.push(`Promoción y pago: ${conditions}`);
  const planDetails = PLAN.map((name) => [name, field(product, name)]).filter(([, value]) => value);
  if (planDetails.length) lines.push(`Plan: ${planDetails.map(([name, value]) => (value === 'Sí' ? name : `${name}: ${value}`)).join('; ')}.`);
  const specs = [...new Map(SPECS.map((name) => [name.normalize('NFD').replace(/[̀-ͯ]/g, ''), [name, field(product, name)]])).values()].filter(([, value]) => value);
  if (specs.length) lines.push(`Ficha técnica: ${specs.map(([name, value]) => `${name} ${value}`).join('; ')}.`);
  const description = plain(product.description).slice(0, 260);
  if (description) lines.push(description);
  lines.push(`Se compra en ${product.link}`);
  const first = available.length ? offer(available[0]) : null;
  const details = {
    modalidades: product.items.map((item) => ({ nombre: item.name, precio: offer(item).Price || null, disponible: Boolean(offer(item).IsAvailable) })),
    cuotas: first && !combo && !plan ? instalments(first) : '',
    condiciones: conditions && conditions !== 'Descripción SKU' ? conditions : '',
    ficha: Object.fromEntries(specs),
    plan: Object.fromEntries(planDetails),
  };
  return { category, combo, plan, lines, price: first ? first.Price : null, listPrice: first ? first.ListPrice : null, details, available,
    planLine: planDetails.length ? lines.find((line) => line.startsWith('Plan: ')) : '', sheetLine: lines.find((line) => line.startsWith('Ficha técnica: ')) || '' };
}

async function helpPage(slug) {
  const html = await (await fetch(`${STORE}/ayuda/${slug}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) })).text();
  const text = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|svg|noscript|header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n');
  const lines = text.split('\n').map((line) => plain(line)).filter((line) => line.length > 2 && !/lorem ipsum|dummy text|welcome to our website|simple modal|^cerrar$/i.test(line));
  const start = lines.findIndex((line, position) => position > 2 && /contacto/i.test(line));
  return lines.slice(start + 1).filter((line) => !/^(-->|ayuda)$/i.test(line));
}

export async function store(log = () => {}) {
  const catalogue = await products();
  if (catalogue.length < 20) throw new Error(`La tienda devolvió solo ${catalogue.length} productos.`);
  const pages = [];
  const listings = new Map();
  const combos = new Map();
  for (const product of catalogue) {
    const card = describe(product);
    const content = card.lines.join('\n');
    // Each phone is sold with six different plans. Searching six near-identical entries per phone
    // finds the wrong one, so they are stored as products but searched as one entry per phone.
    const withPlan = card.combo && product.productName.match(/^(.*?)\s*\+\s*Plan (?:de )?(\d+)\s*GB/i);
    if (withPlan) {
      const group = combos.get(withPlan[1]) || { base: withPlan[1], brand: product.brand, category: card.category, link: product.link, sheetLine: card.sheetLine, planLine: card.planLine, options: [] };
      group.options.push({ gigas: Number(withPlan[2]), prices: card.available.map((item) => [/migra/i.test(item.name) ? 'migrando tu línea Personal' : 'con línea nueva', offer(item).Price]) });
      combos.set(withPlan[1], group);
      pages.push({ url: product.link, title: `${product.productName} | Tienda Personal`, description: plain(product.metaTagDescription), content, lines: card.lines, topic: product.productName, chunks: [],
        product: { name: product.productName, brand: product.brand, category: card.category, price: card.price, listPrice: card.listPrice, available: card.price !== null, details: card.details } });
      continue;
    }
    pages.push({
      url: product.link, title: `${product.productName} | Tienda Personal`, description: plain(product.metaTagDescription), content, lines: card.lines,
      topic: `${product.productName} ${product.brand} ${card.category} tienda ${card.combo ? 'telefono celular equipo con plan pospago combo' : card.plan ? 'plan pospago' : /Accesorios|Hogar/.test(card.category) ? 'accesorio producto precio comprar' : 'telefono celular equipo precio cuotas tarjeta comprar'}`,
      chunks: [{ heading: product.productName, content }],
      product: { name: product.productName, brand: product.brand, category: card.category, price: card.price, listPrice: card.listPrice, available: card.price !== null, details: card.details },
    });
    // One-line entries feed the price lists, which answer "what phones do you have" in one passage.
    const group = `${card.combo ? 'Teléfonos con plan' : card.plan ? 'Planes pospago' : card.category.split(' › ')[0]} ${card.combo || /Equipos|Outlet/.test(card.category) ? product.brand : ''}`.trim();
    const entry = card.price === null ? `${product.productName}: sin stock` : `${product.productName}: ${money(card.price)}${card.combo || card.plan ? ' por mes' : ''}`;
    listings.set(group, [...(listings.get(group) || []), entry]);
  }
  for (const group of combos.values()) {
    const options = group.options.filter((option) => option.prices.length).sort((a, b) => a.gigas - b.gigas);
    if (!options.length) continue;
    const priced = options.map((option) => { const distinct = [...new Set(option.prices.map(([, price]) => price))]; return `con plan de ${option.gigas} gigas: ${distinct.length === 1 ? money(distinct[0]) : option.prices.map(([how, price]) => `${how} ${money(price)}`).join(', ')}`; });
    const lines = [`${group.base} con plan pospago — marca ${group.brand}. Categoría de la tienda: ${group.category}.`,
      'Precio por mes del combo teléfono más plan, que incluye el plan y la cuota del equipo en una sola factura (vale para línea nueva y para migrar una línea Personal, salvo que se indique otro precio):',
      ...priced, group.planLine, group.sheetLine, `Se compra en ${group.link}`].filter(Boolean);
    const content = lines.join('\n');
    pages.push({ url: `${group.link}#con-plan`, title: `${group.base} con plan | Tienda Personal`, description: '', content, lines,
      topic: `${group.base} ${group.brand} con plan pospago combo telefono celular equipo precio por mes migrar linea nueva tienda`, chunks: [{ heading: `${group.base} con plan`, content }] });
    const cheapest = Math.min(...options.flatMap((option) => option.prices.map(([, price]) => price)));
    const label = `Teléfonos con plan ${group.brand}`;
    listings.set(label, [...(listings.get(label) || []), `${group.base} con plan: desde ${money(cheapest)} por mes`]);
  }
  // Cheapest-first list of the phones sold on their own, for "what is the cheapest phone".
  const phones = pages.filter((page) => page.product && /^Equipos/.test(page.product.category) && page.product.available).sort((a, b) => a.product.price - b.product.price);
  if (phones.length) {
    const brief = (page) => { const sheet = page.product.details.ficha; return [sheet['Cámara Principal'] || sheet['Camara Principal'], sheet['Capacidad de Bateria'], sheet['Memoria RAM'] && `RAM ${sheet['Memoria RAM']}`].filter((value) => value && !/^m[aá]s de/i.test(value)).join(', '); };
    const content = `Todos los teléfonos en stock de la Tienda Personal, del más barato al más caro (precio al contado, sin plan; cámara principal, batería y memoria)\n${phones.map((page) => `${page.product.name}: ${money(page.product.price)}${brief(page) ? ` — ${brief(page)}` : ''}`).join('\n')}\nCasi todos se consiguen también con plan pospago, pagando por mes.`;
    pages.push({ url: `${STORE}/#telefonos-por-precio`, title: 'Teléfonos por precio | Tienda Personal', description: '', content, lines: content.split('\n'), chunks: [{ heading: 'Teléfonos del más barato al más caro', content }],
      topic: 'telefono celular equipo mas barato economico accesible menor precio mas caro mejor gama opciones presupuesto tienda' });
  }
  for (const [group, entries] of listings) {
    const chunks = [];
    for (let position = 0; position < entries.length; position += 22) chunks.push({ heading: `Lista de precios: ${group}`, content: `Lista de precios de la Tienda Personal — ${group}\n${entries.slice(position, position + 22).join('\n')}` });
    pages.push({
      url: `${STORE}/#lista-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: `Lista de precios ${group} | Tienda Personal`, description: '',
      content: chunks.map((chunk) => chunk.content).join('\n\n'), lines: entries, chunks,
      topic: `lista precios catalogo tienda ${group} telefonos celulares equipos modelos disponibles oferta`,
    });
  }
  for (const slug of HELP) {
    try {
      const lines = await helpPage(slug);
      if (lines.join(' ').length < 80) continue;
      const content = lines.join('\n');
      pages.push({ url: `${STORE}/ayuda/${slug}`, title: `${lines[0]} | Tienda Personal`, description: '', content, lines, topic: `tienda compra ayuda ${slug.replace(/-/g, ' ')} ${lines[0]} formas medios pago tarjetas credito aceptan envio entrega domicilio retiro demora costo`, chunks: [{ heading: lines[0], content: content.slice(0, 1900) }] });
    } catch { /* the catalogue is still worth storing without a help page */ }
  }
  log(`  tienda: ${catalogue.length} productos, ${pages.length} entradas`);
  return pages;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pages = await store(console.log);
  if (process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(pages));
  for (const sample of [pages.find((page) => /A16/.test(page.title)), pages.find((page) => /S26 Negro- 256GB \+ Plan de 24GB/.test(page.title)), pages.find((page) => /Lista de precios Equipos SAMSUNG/i.test(page.title)), pages.find((page) => /metodos-de-pago/.test(page.url)), pages.find((page) => /metodos-de-envio/.test(page.url))]) console.log(`\n=== ${sample?.title} (${sample?.content.length} caracteres)\n${sample?.content}`);
  console.log('\n' + pages.filter((page) => /Lista de precios/.test(page.title)).map((page) => `${page.title} [${page.lines.length}]`).join('\n'));
}
