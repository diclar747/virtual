// Manual refresh of the stored copy of personal.com.py:  npm run sync
import { connect, sync } from '../db.mjs';
if (!await connect({})) { console.error('No se pudo conectar a la base de datos (DATABASE_URL).'); process.exit(1); }
const result = await sync(console.log);
console.log(result ? `Listo: ${result.pages} páginas y ${result.passages} pasajes guardados.` : 'No se actualizó.');
process.exit(result ? 0 : 1);
