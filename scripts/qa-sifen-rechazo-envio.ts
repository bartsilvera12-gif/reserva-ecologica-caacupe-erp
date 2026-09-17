/**
 * QA unitario (sin red, sin BD) de la lógica de rechazo de envío SIFEN:
 *   - construirMensajeRechazoLote: el mensaje visible sale SIEMPRE de la respuesta
 *     real del lote y NUNCA del 1264 del servicio síncrono.
 *   - debeBloquearReenvioPorDteAprobado: guardia anti-duplicación por CDC.
 *
 * Casos cubiertos (pedido del cliente):
 *   1. 0301 async + 1264 sync diagnóstico → el 1264 no debe aparecer.
 *   2. Rechazo real del lote (gResProc con código real) → se muestra ese código.
 *   3. 0301 sin detalle por-DE → mensaje limpio, sin "1264" ni "undefined".
 *   4. CDC aprobado → bloquear reenvío.
 *   5. CDC no encontrado → NO bloquear.
 *
 * Uso: npm run qa:sifen-rechazo-envio   (o: npx tsx scripts/qa-sifen-rechazo-envio.ts)
 */
import { construirMensajeRechazoLote } from "../src/lib/sifen/mensaje-rechazo-lote";
import { debeBloquearReenvioPorDteAprobado } from "../src/lib/sifen/guardia-reenvio-cdc";
import { facturaElectronicaYaAprobada, MSG_DOC_APROBADO } from "../src/lib/sifen/aprobado-guard";

let fallos = 0;
function check(nombre: string, cond: boolean, extra?: string) {
  const ok = cond === true;
  if (!ok) fallos++;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${nombre}${!ok && extra ? `\n        ${extra}` : ""}`);
}

const HINT = " — Use «Consultar lote SET» con el protocolo";
const PROT = "85010225259220718";

// ---------------------------------------------------------------------------
// Caso 1: 0301 asíncrono + 1264 síncrono. El envío real (lote) rechazó por un
// motivo real (aquí 0160). El servicio síncrono habría devuelto 1264, pero ese
// valor NO se le pasa al builder (proviene de siRecepDE, no del lote). El mensaje
// visible no debe contener 1264.
// ---------------------------------------------------------------------------
const soapLoteConDetalleReal =
  `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>` +
  `<rRetEnviLoteDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<dCodRes>0301</dCodRes>` +
  `<dMsgRes>Lote no encolado para procesamiento {Se rechazaron todos los DE del lote}</dMsgRes>` +
  `<dProtConsLote>${PROT}</dProtConsLote>` +
  `<gResProc><dCodRes>0160</dCodRes><dMsgRes>dRucRec inv&#225;lido</dMsgRes></gResProc>` +
  `</rRetEnviLoteDe></env:Body></env:Envelope>`;

// Lo que el ex-diagnóstico síncrono habría devuelto para este emisor (se ignora):
const _respuestaSincronaIgnorada = "[1264] RUC del emisor no está habilitado para utilizar el servicio síncrono [80131562]";
void _respuestaSincronaIgnorada;

const msg1 = construirMensajeRechazoLote({
  dCodRes: "0301",
  dMsgRes: "Lote no encolado para procesamiento {Se rechazaron todos los DE del lote}",
  cuerpoSoapCrudo: soapLoteConDetalleReal,
  protocolo: PROT,
  consultaLoteHint: HINT,
});
check("Caso 1a: el mensaje NO contiene el 1264 síncrono", !msg1.includes("1264"), `msg=${msg1}`);
check("Caso 1b: el mensaje contiene el código real del lote [0160]", msg1.includes("[0160]"), `msg=${msg1}`);
check("Caso 1c: el mensaje conserva el 0301 y el protocolo", msg1.includes("0301") && msg1.includes(PROT), `msg=${msg1}`);

// ---------------------------------------------------------------------------
// Caso 2: rechazo real del lote con otro código (ej. 0362 [1005]). Debe verse.
// ---------------------------------------------------------------------------
const soapLoteRechazoReal =
  `<rRetEnviLoteDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<dCodRes>0301</dCodRes><dMsgRes>Lote no encolado para procesamiento</dMsgRes>` +
  `<gResProc><dCodRes>0362</dCodRes><dMsgRes>Fecha de emisi&#243;n fuera de rango</dMsgRes></gResProc>` +
  `</rRetEnviLoteDe>`;
const msg2 = construirMensajeRechazoLote({
  dCodRes: "0301",
  dMsgRes: "Lote no encolado para procesamiento",
  cuerpoSoapCrudo: soapLoteRechazoReal,
  protocolo: null,
  consultaLoteHint: HINT,
});
check("Caso 2a: muestra el código real por-DE [0362]", msg2.includes("[0362]"), `msg=${msg2}`);
check("Caso 2b: decodifica el mensaje (emisión)", /emisi[oó]n/i.test(msg2), `msg=${msg2}`);
check("Caso 2c: sin protocolo, no agrega la pista de consulta", !msg2.includes(HINT.trim()), `msg=${msg2}`);

// ---------------------------------------------------------------------------
// Caso 3: 0301 sin gResProc por-DE. Mensaje limpio, sin 1264 ni "undefined".
// ---------------------------------------------------------------------------
const soapLoteSinDetalle =
  `<rRetEnviLoteDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<dCodRes>0301</dCodRes><dMsgRes>Lote no encolado para procesamiento</dMsgRes>` +
  `<dProtConsLote>${PROT}</dProtConsLote></rRetEnviLoteDe>`;
const msg3 = construirMensajeRechazoLote({
  dCodRes: "0301",
  dMsgRes: "Lote no encolado para procesamiento",
  cuerpoSoapCrudo: soapLoteSinDetalle,
  protocolo: PROT,
  consultaLoteHint: HINT,
});
check("Caso 3a: mensaje limpio sin 1264", !msg3.includes("1264"), `msg=${msg3}`);
check("Caso 3b: sin 'undefined' ni corchetes vacíos", !msg3.includes("undefined") && !msg3.includes("[]"), `msg=${msg3}`);
check("Caso 3c: incluye 0301 y la pista con protocolo", msg3.includes("0301") && msg3.includes(PROT), `msg=${msg3}`);

// ---------------------------------------------------------------------------
// Casos 4 y 5: guardia anti-duplicación por CDC.
// ---------------------------------------------------------------------------
check("Caso 4: CDC aprobado → bloquear reenvío", debeBloquearReenvioPorDteAprobado({ aprobado: true }) === true);
check("Caso 5a: CDC no encontrado → NO bloquear", debeBloquearReenvioPorDteAprobado({ aprobado: false }) === false);
check("Caso 5b: sin veredicto (aprobado falso) → NO bloquear", debeBloquearReenvioPorDteAprobado({ aprobado: false }) === false);

// ---------------------------------------------------------------------------
// Casos 6-8: guardia definitiva "documento ya aprobado" (bloquea REGENERAR y
// REENVIAR). Ambos handlers (/sifen/xml y /sifen/enviar) usan este predicado.
// ---------------------------------------------------------------------------
// Reenvío bloqueado: estado fiscal 'aprobado'.
check("Caso 6a: REENVÍO bloqueado — estado 'aprobado'",
  facturaElectronicaYaAprobada({ estado_sifen: "aprobado", sifen_aprobado_at: null }) === true);
// Reenvío bloqueado: aprobado_at seteado aunque el estado sea 'firmado' (tras re-firmar).
check("Caso 6b: REENVÍO bloqueado — sifen_aprobado_at seteado, estado 'firmado'",
  facturaElectronicaYaAprobada({ estado_sifen: "firmado", sifen_aprobado_at: "2026-09-16T17:13:44.459Z" }) === true);
// Regeneración bloqueada: el caso real de FAC-000080 (estado 'rechazado' pero ya aprobada).
check("Caso 7a: REGENERACIÓN bloqueada — estado 'rechazado' con sifen_aprobado_at (caso FAC-000080)",
  facturaElectronicaYaAprobada({ estado_sifen: "rechazado", sifen_aprobado_at: "2026-09-16T17:13:44.459Z" }) === true);
// Regeneración bloqueada: estado 'error_envio' pero ya aprobada.
check("Caso 7b: REGENERACIÓN bloqueada — estado 'error_envio' con sifen_aprobado_at",
  facturaElectronicaYaAprobada({ estado_sifen: "error_envio", sifen_aprobado_at: "2026-09-16T17:13:44.459Z" }) === true);
// NO bloquear cuando nunca fue aprobada (rechazo legítimo sin aprobación previa).
check("Caso 8a: NO bloquea — 'rechazado' sin sifen_aprobado_at",
  facturaElectronicaYaAprobada({ estado_sifen: "rechazado", sifen_aprobado_at: null }) === false);
check("Caso 8b: NO bloquea — 'borrador' sin aprobación",
  facturaElectronicaYaAprobada({ estado_sifen: "borrador", sifen_aprobado_at: null }) === false);
check("Caso 8c: NO bloquea — fila nula/indefinida",
  facturaElectronicaYaAprobada(null) === false);
// Mensaje exacto requerido.
check("Caso 9: el mensaje de bloqueo es el texto requerido",
  MSG_DOC_APROBADO === "Este documento ya fue aprobado por SET y no puede regenerarse ni reenviarse. Utilice el documento aprobado existente.");

console.log(`\n${fallos === 0 ? "✓ TODOS OK" : `✗ ${fallos} FALLO(S)`}`);
process.exit(fallos === 0 ? 0 : 1);
