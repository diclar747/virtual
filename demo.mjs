// Fictitious customer accounts for the demo: a caller can be "identified" by a demo phone number,
// a demo ID code or a name, and then ask about balance, data, bills and extra packs. None of this
// is connected to Personal's systems; every record is made up and the assistant says so.

export const DEMO_CLIENTS = [
  { id: 1, name: 'Carlos Benítez', cedula: 'DEMO-CI-001', phone: '0975-000-001', plan: 'Personal Max 80 GB', gbTotal: 80, gbUsed: 52.5, balance: 18500, bill: 125000, due: '2026-11-15', status: 'Pendiente', calls: 'Ilimitadas', sms: 100 },
  { id: 2, name: 'María González', cedula: 'DEMO-CI-002', phone: '0975-000-002', plan: 'Personal Max 120 GB', gbTotal: 120, gbUsed: 32.8, balance: 42000, bill: 185000, due: '2026-11-20', status: 'Pendiente', calls: 'Ilimitadas', sms: 200 },
  { id: 3, name: 'Roberto Fernández', cedula: 'DEMO-CI-003', phone: '0975-000-003', plan: 'Personal Max 40 GB', gbTotal: 40, gbUsed: 38.2, balance: 3500, bill: 89000, due: '2026-11-05', status: 'Vencida', calls: '500 minutos', sms: 50 },
  { id: 4, name: 'Ana Martínez', cedula: 'DEMO-CI-004', phone: '0975-000-004', plan: 'Personal Max 200 GB', gbTotal: 200, gbUsed: 74.6, balance: 67000, bill: 245000, due: '2026-11-25', status: 'Pagada', calls: 'Ilimitadas', sms: 300 },
  { id: 5, name: 'Diego Ramírez', cedula: 'DEMO-CI-005', phone: '0975-000-005', plan: 'Personal Max 60 GB', gbTotal: 60, gbUsed: 59.1, balance: 8200, bill: 110000, due: '2026-11-12', status: 'Pendiente', calls: 'Ilimitadas', sms: 100 },
];

// Simulated extra packs: they are never activated or charged.
export const DEMO_PACKS = [{ gb: 2, price: 10000 }, { gb: 5, price: 20000 }, { gb: 10, price: 35000 }, { gb: 20, price: 60000 }];

const plain = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const SPOKEN_DIGITS = { cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9' };

// Finds a demo account in what the person said or typed. Phone numbers are compared by digits
// (speech recognition writes them in many ways), ID codes by their final number, names by words.
export function findDemoClient(clients, said) {
  const text = plain(said);
  const digits = text.replace(/\b(cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g, (word) => SPOKEN_DIGITS[word]).replace(/\D/g, '');
  if (digits.length >= 6) {
    // With the whole number (nine digits or more) the prefix must match too, so a Tigo or Claro
    // number with the same ending is not taken for a Personal demo line.
    const byPhone = clients.find((client) => { const phone = client.phone.replace(/\D/g, ''); return digits.length >= 9 ? digits.endsWith(phone.slice(1)) : digits.endsWith(phone.slice(-6)); });
    if (byPhone) return byPhone;
  }
  // "demo ce i cero cero cinco" → "demo ce i 005"
  const spoken = text.replace(/\b(cero|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g, (word) => SPOKEN_DIGITS[word]).replace(/(\d)\s+(?=\d)/g, '$1');
  const code = spoken.match(/(?:demo|\bci\b|c\.?\s?i\b|ce\s?i\b|cedula|codigo)\D{0,12}(\d{1,3})\b/);
  if (code) { const byCode = clients.find((client) => Number(client.cedula.slice(-3)) === Number(code[1])); if (byCode) return byCode; }
  const words = new Set(text.match(/[a-zñ]{3,}/g) || []);
  const byFull = clients.find((client) => plain(client.name).split(' ').every((part) => words.has(part)));
  if (byFull) return byFull;
  const bySurname = clients.filter((client) => words.has(plain(client.name).split(' ')[1]));
  return bySurname.length === 1 ? bySurname[0] : null;
}

// "Gs. 18.500": the same form the store uses, which the voice code turns into words.
const money = (value) => `Gs. ${Math.round(value).toLocaleString('es-PY').replace(/,/g, '.')}`;
const gigas = (value) => `${Number(value).toLocaleString('es-PY', { maximumFractionDigits: 1 })} GB`;
const date = (iso) => iso.split('-').reverse().join('/');

// Days from today (Paraguay time) to a date; negative when it already passed.
function daysUntil(iso, now = new Date()) {
  const today = new Date(now.toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${iso}T00:00:00`) - today) / 86400000);
}

// Everything computed about an account: remaining data, percentage used and the alerts a real
// service would send (little data left, a bill about to fall due or overdue).
export function describeClient(client, now = new Date()) {
  const gbLeft = Math.round((client.gbTotal - client.gbUsed) * 10) / 10;
  const usedPercent = Math.round((client.gbUsed / client.gbTotal) * 1000) / 10;
  const days = daysUntil(client.due, now);
  const alerts = [];
  if (gbLeft / client.gbTotal < 0.1) alerts.push(`Le quedan solamente ${gigas(gbLeft)} de internet: usó el ${String(usedPercent).replace('.', ',')}% del plan.`);
  if (client.status === 'Vencida') alerts.push(`Su factura de ${money(client.bill)} está vencida desde el ${date(client.due)}.`);
  else if (client.status === 'Pendiente' && days >= 0 && days <= 7) alerts.push(`Su factura de ${money(client.bill)} vence ${days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`}, el ${date(client.due)}.`);
  if (client.balance < 5000) alerts.push(`Tiene poco saldo: ${money(client.balance)}.`);
  const dueText = client.status === 'Pagada' ? `pagada (vencía el ${date(client.due)})`
    : client.status === 'Vencida' ? `vencida desde el ${date(client.due)}, hace ${-days} días`
    : `pendiente, vence el ${date(client.due)}${days >= 0 ? ` (${days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`})` : ''}`;
  const text = [
    `CUENTA DE DEMOSTRACIÓN (datos ficticios) de ${client.name}. Línea ${client.phone}, código de cédula de prueba ${client.cedula}.`,
    `Plan: ${client.plan}. Llamadas: ${client.calls}. SMS disponibles: ${client.sms}.`,
    `Internet: contratado ${gigas(client.gbTotal)}, consumido ${gigas(client.gbUsed)}, disponible ${gigas(gbLeft)}; usó el ${String(usedPercent).replace('.', ',')}% del plan.`,
    `Saldo disponible: ${money(client.balance)}.`,
    `Factura mensual: ${money(client.bill)}, estado ${dueText}.`,
    alerts.length ? `Alertas: ${alerts.join(' ')}` : 'Sin alertas.',
    'No hay datos de consumo diario, por aplicación ni de llamadas individuales en esta demostración, ni fecha de renovación de los datos.',
  ].join('\n');
  return {
    text,
    view: { id: client.id, name: client.name, phone: client.phone, plan: client.plan, gbTotal: client.gbTotal, gbUsed: client.gbUsed, gbLeft, usedPercent, balance: client.balance, bill: client.bill, due: date(client.due), status: client.status, calls: client.calls, sms: client.sms, alerts },
  };
}

export function packsText() {
  return `Paquetes extra de demostración (precios simulados, no son ofertas oficiales): ${DEMO_PACKS.map((pack) => `Extra ${pack.gb} GB por ${money(pack.price)}`).join('; ')}.`;
}

// A simulated purchase: it confirms what would happen and stresses that nothing was charged.
export function simulatePack(client, gb) {
  const pack = DEMO_PACKS.find((option) => option.gb === Number(gb));
  if (!pack) return { ok: false, text: `Ese paquete no existe en la demostración. ${packsText()}` };
  const left = client ? Math.round((client.gbTotal - client.gbUsed + pack.gb) * 10) / 10 : null;
  return {
    ok: true, pack,
    text: `CONFIRMACIÓN SIMULADA: se activaría el paquete Extra ${pack.gb} GB por ${money(pack.price)}${client ? ` en la línea de demostración ${client.phone} de ${client.name}, que quedaría con ${gigas(left)} disponibles` : ''}. Es solo una simulación: no se activó nada ni se cobró nada.`,
  };
}
