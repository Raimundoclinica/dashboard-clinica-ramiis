// Conector Medilink -> Dashboard
// Llama a la API oficial de Medilink, arma el resumen del día y lo guarda
// como archivo JSON dentro de /data para que el dashboard lo lea.
//
// Requiere la variable de entorno MEDILINK_TOKEN (token generado en
// Medilink > Administrador > Configuración API).
//
// Uso: node scripts/sync-medilink.js [YYYY-MM-DD]
// Si no se pasa fecha, usa el día de hoy (America/Santiago).

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.medilink.healthatom.com/api/v1';
const TOKEN = process.env.MEDILINK_TOKEN;

if (!TOKEN) {
  console.error('Falta la variable de entorno MEDILINK_TOKEN');
  process.exit(1);
}

const PALABRAS_CANCELADA = ['anulad', 'cancel'];
const PALABRAS_INASISTENCIA = ['no show', 'no asist', 'inasist', 'no confirmad'];

function fechaSantiagoHoy() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

async function medilinkGet(urlPath, query) {
  let url = `${API_BASE}${urlPath}`;
  if (query) {
    url += `?q=${encodeURIComponent(JSON.stringify(query))}`;
  }
  const allData = [];
  let next = url;
  let guard = 0;
  while (next && guard < 50) {
    guard++;
    const res = await fetch(next, {
      headers: { Authorization: `Token ${TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Error ${res.status} en ${next}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [json.data];
    allData.push(...data.filter(Boolean));
    next = json.links && json.links.next && json.links.next !== next
      ? json.links.next
      : null;
  }
  return allData;
}

async function primeraAtencionFecha(idPaciente) {
  try {
    const atenciones = await medilinkGet(`/pacientes/${idPaciente}/atenciones`);
    if (!atenciones.length) return null;
    const fechas = atenciones.map((a) => a.fecha).filter(Boolean).sort();
    return fechas[0] || null;
  } catch (e) {
    console.warn(`No se pudo revisar historial del paciente ${idPaciente}:`, e.message);
    return null;
  }
}

async function main() {
  const fecha = process.argv[2] || fechaSantiagoHoy();
  console.log(`Sincronizando datos de Medilink para ${fecha}...`);

  const atenciones = await medilinkGet('/atenciones', { fecha: { eq: fecha } });

  const atencionesPorProfesional = {};
  const pacientesDelDia = new Map();

  for (const a of atenciones) {
    const prof = a.nombre_profesional || 'Sin asignar';
    atencionesPorProfesional[prof] = (atencionesPorProfesional[prof] || 0) + 1;
    if (a.id_paciente) {
      pacientesDelDia.set(a.id_paciente, a.nombre_paciente || 'Paciente');
    }
  }

  let nuevos = 0;
  let recurrentes = 0;
  for (const idPaciente of pacientesDelDia.keys()) {
    const primeraFecha = await primeraAtencionFecha(idPaciente);
    if (primeraFecha === fecha) nuevos++;
    else recurrentes++;
  }

  let citasHoy = [];
  try {
    citasHoy = await medilinkGet('/citas', { fecha: { eq: fecha } });
  } catch (e) {
    console.warn('No se pudo obtener /citas, se omite ese bloque:', e.message);
  }

  let canceladas = 0;
  let inasistencias = 0;
  for (const c of citasHoy) {
    const estado = (c.estado_cita || '').toLowerCase();
    if (PALABRAS_CANCELADA.some((p) => estado.includes(p))) canceladas++;
    else if (PALABRAS_INASISTENCIA.some((p) => estado.includes(p))) inasistencias++;
  }

  let pagos = [];
  try {
    pagos = await medilinkGet('/pagos', { fecha_recepcion: { eq: fecha } });
  } catch (e) {
    console.warn('No se pudo obtener /pagos directamente, revisa permisos del token:', e.message);
  }

  const ventasPorMedioPago = {};
  let ventasTotal = 0;
  for (const p of pagos) {
    const medio = p.medio_pago || 'Otro';
    const monto = Number(p.monto_pago) || 0;
    ventasPorMedioPago[medio] = (ventasPorMedioPago[medio] || 0) + monto;
    ventasTotal += monto;
  }

  const resumen = {
    fecha,
    generado: new Date().toISOString(),
    ventas: { total: ventasTotal, porMedioPago: ventasPorMedioPago },
    atenciones: { total: atenciones.length, porProfesional: atencionesPorProfesional },
    pacientes: { nuevos, recurrentes, total: pacientesDelDia.size },
    citas: { total: citasHoy.length, canceladas, inasistencias },
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${fecha}.json`), JSON.stringify(resumen, null, 2));

  const indexPath = path.join(dataDir, 'index.json');
  let indice = [];
  if (fs.existsSync(indexPath)) {
    indice = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  if (!indice.includes(fecha)) {
    indice.push(fecha);
    indice.sort();
  }
  fs.writeFileSync(indexPath, JSON.stringify(indice, null, 2));

  console.log(`Listo. Guardado data/${fecha}.json`);
  console.log(resumen);
}

main().catch((err) => {
  console.error('Error sincronizando Medilink:', err);
  process.exit(1);
});
