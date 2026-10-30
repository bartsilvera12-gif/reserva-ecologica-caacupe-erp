/**
 * QA unitario (sin red, sin BD) del clasificador de la consulta DE por CDC
 * (`clasificarEstadoConsultaDe`).
 *
 * Contexto: `siConsDE` NO devuelve `dEstRes` (ese campo es de la respuesta de
 * ENVÍO/lote). La lógica vieja decidía solo por `dEstRes`, así que todo DE
 * encontrado quedaba "sin veredicto" y nunca se marcaba aprobado ni se limpiaba
 * el error stale. La señal real es `dCodRes` = 0422 (CDC encontrado = aprobado).
 *
 * Uso: npx tsx scripts/qa-sifen-consulta-de-0422.ts
 */
import { clasificarEstadoConsultaDe } from "../src/lib/sifen/consulta-de-por-cdc";

let fallos = 0;
function check(nombre: string, cond: boolean, extra?: string) {
  const ok = cond === true;
  if (!ok) fallos++;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${nombre}${!ok && extra ? `\n        ${extra}` : ""}`);
}

// --- Caso 1: 0422 sin dEstRes (respuesta típica de un DE aprobado) ----------
// SET devuelve xContenDE con el rDE firmado; NO trae dEstRes.
const xml0422 =
  `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>` +
  `<ns2:rEnviConsDeResponse xmlns:ns2="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<ns2:dFecProc>2026-10-27T18:00:00</ns2:dFecProc>` +
  `<ns2:dCodRes>0422</ns2:dCodRes>` +
  `<ns2:dMsgRes>CDC encontrado</ns2:dMsgRes>` +
  `<ns2:xContenDE><rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<DE Id="01801315620001001000097422026102711230903225"></DE></rDE></ns2:xContenDE>` +
  `</ns2:rEnviConsDeResponse></env:Body></env:Envelope>`;
const r1 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0422", dEstRes: null, xml: xml0422 });
check("1a: 0422 sin dEstRes → aprobado", r1.aprobado === true, JSON.stringify(r1));
check("1b: 0422 → encontrado", r1.encontrado === true, JSON.stringify(r1));
check("1c: 0422 → no rechazado", r1.rechazado === false, JSON.stringify(r1));
check("1d: 0422 → no noEncontrado", r1.noEncontrado === false, JSON.stringify(r1));

// --- Caso 2: 0420 (CDC no encontrado) ---------------------------------------
const xml0420 =
  `<ns2:rEnviConsDeResponse xmlns:ns2="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<ns2:dCodRes>0420</ns2:dCodRes><ns2:dMsgRes>CDC no encontrado</ns2:dMsgRes>` +
  `</ns2:rEnviConsDeResponse>`;
const r2 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0420", dEstRes: null, xml: xml0420 });
check("2a: 0420 → noEncontrado", r2.noEncontrado === true, JSON.stringify(r2));
check("2b: 0420 → no aprobado", r2.aprobado === false, JSON.stringify(r2));

// --- Caso 3: 0422 con evento de cancelación registrado ----------------------
// El DE existe (0422) pero trae un evento de cancelación → no vigente.
const xmlCancel =
  `<ns2:rEnviConsDeResponse xmlns:ns2="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<ns2:dCodRes>0422</ns2:dCodRes><ns2:dMsgRes>CDC encontrado</ns2:dMsgRes>` +
  `<ns2:xContEv><rEve Id="1"><gGroupTiEvt><iTipEve>1</iTipEve>` +
  `<mOtEve>Cancelacion del comprobante</mOtEve></gGroupTiEvt></rEve></ns2:xContEv>` +
  `</ns2:rEnviConsDeResponse>`;
const r3 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0422", dEstRes: null, xml: xmlCancel });
check("3a: 0422 + evento cancelación → rechazado", r3.rechazado === true, JSON.stringify(r3));
check("3b: 0422 + evento cancelación → no aprobado", r3.aprobado === false, JSON.stringify(r3));

// --- Caso 4: dEstRes explícito "Aprobado" (compatibilidad) ------------------
const xmlEst =
  `<ns2:rEnviConsDeResponse xmlns:ns2="http://ekuatia.set.gov.py/sifen/xsd">` +
  `<ns2:dCodRes>0422</ns2:dCodRes><ns2:dEstRes>Aprobado</ns2:dEstRes>` +
  `</ns2:rEnviConsDeResponse>`;
const r4 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0422", dEstRes: "Aprobado", xml: xmlEst });
check("4: dEstRes=Aprobado → aprobado", r4.aprobado === true && r4.rechazado === false, JSON.stringify(r4));

// --- Caso 5: dEstRes explícito "Cancelado" gana aunque sea 0422 -------------
const r5 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0422", dEstRes: "Cancelado", xml: "" });
check("5: dEstRes=Cancelado → rechazado, no aprobado", r5.rechazado === true && r5.aprobado === false, JSON.stringify(r5));

// --- Caso 6: SOAP Fault → sin veredicto (todo false) ------------------------
const r6 = clasificarEstadoConsultaDe({ soapFault: true, dCodRes: "0422", dEstRes: null, xml: "<Fault/>" });
check("6: soapFault → nada true", !r6.aprobado && !r6.rechazado && !r6.noEncontrado && !r6.encontrado, JSON.stringify(r6));

// --- Caso 7: 0421 (RUC sin permiso) → no concluyente ------------------------
const r7 = clasificarEstadoConsultaDe({ soapFault: false, dCodRes: "0421", dEstRes: null, xml: "<x/>" });
check("7: 0421 → no aprobado y no noEncontrado", r7.aprobado === false && r7.noEncontrado === false, JSON.stringify(r7));

console.log(`\n${fallos === 0 ? "TODO OK" : `${fallos} FALLO(S)`}`);
process.exit(fallos === 0 ? 0 : 1);
