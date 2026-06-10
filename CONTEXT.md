# Compliance Analyzer — Context

_Actualizado: 2026-06-09 — PPWR (Reg. UE 2025/40) + búsqueda dashboard + checklist etiquetado_

---

## Stack

| Capa | Tecnología |
|---|---|
| Hosting / Deploy | Vercel — `https://compliance-analyzer-pearl.vercel.app` |
| Repo | `https://github.com/Hector5olution5/compliance-analyzer` (rama: `main`) |
| Base de datos | Firebase Firestore (plan Spark) |
| Storage de archivos | Supabase Storage — bucket `evidencias` |
| IA | Claude API vía proxy Vercel (`/api/claude.js`) |
| Auth | Custom PIN (PBKDF2 + salt, sin Firebase Auth) |

---

## Archivos clave

| Archivo | Rol |
|---|---|
| `index.html` | Estructura + SDKs Firebase/Supabase + modales |
| `styles.css` | UI completa |
| `compliance-data.js` | `DOCS_MASTER`, `MARKETS`, `CHARACTERISTICS`, normativas |
| `app.js` | Lógica principal — ~4200 líneas |
| `firebase-config.js` | Config Firebase (pública) |
| `api/claude.js` | Proxy → Claude API |
| `api/upload-evidencia.js` | Proxy → Supabase Storage (POST upload, DELETE) |
| `vercel.json` | `maxDuration: 60s` |
| `Docs.md` | Spec de negocio del módulo de documentos (no es código) |

---

## Firestore — colecciones

| Colección | Uso |
|---|---|
| `users` | Usuarios y PINs |
| `expedientes` | Historial cross-device + formData |
| `expedientes/{id}/evidencias` | Archivos adjuntos libres |
| `expedientes/{id}/documentos` | Documentos de compliance (Ruta) |
| `errors` | Monitoreo de errores globales |
| `lockouts` | Bloqueos por intentos fallidos de PIN |

**Reglas Firestore:** `users`, `expedientes`, `evidencias`, `documentos`, `errors`, `lockouts` — `allow read, write: if true`.

---

## Supabase Storage

- **Bucket:** `evidencias` (público)
- **Policy:** `allow_all_evidencias` — SELECT, INSERT, UPDATE, DELETE
- **Paths:**
  - Evidencias: `{expId}/{fileId}_{safeName}`
  - Documentos de compliance: `{expId}/docs/{code}_{fileId}_{safeName}`
- **Variables en Vercel:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- **Tipos aceptados:** `application/pdf` + cualquier `image/*` (incluye .heic, .avif, .tiff, etc.)

---

## Módulos implementados

### Módulo principal — Análisis de expediente
- Formulario multi-tab (producto, componentes, características, empresa)
- Generación de expediente con Claude (Sonnet)
- Exportar a Word / PDF
- Historial local + sync Firestore cross-device
- Badge ☁ y regeneración desde historial

### Módulo Evidencias (tab 📎)
- Upload a Supabase vía proxy server-side (base64, hasta 20 MB)
- PDFs >3 MB → compresión client-side con PDF.js + jsPDF
- Lista con icono tipo, nombre, quién subió, fecha
- Botón Revisar / ✓ Revisado · Ver → URL pública · ✕ Eliminar (admin)

### Módulo Ruta de Compliance (tab 📋) — COMPLETO (Fases 1–4)

**Fase 1 — CRUD básico**
- `DOCS_MASTER`: 35 documentos en 5 categorías
- Documentos requeridos, condicionales y opcionales por mercado (UE / USA / Australia)
- "Internacional" se expande a UE + USA + Australia
- Barras de progreso por mercado · Upload → Supabase + Firestore · Aprobar · Banner siguiente paso

**Fase 2 — Metadatos y ciclo de vida**
- Modal de upload con campos contextuales (lab, acreditación, norma para test reports)
- Metadatos visibles inline · Badges vencimiento 🟢🟡🔴 (UE 180d / USA-AU 90d)
- Botón ✕ Eliminar (admin + coord_compliance)

**Fase 3 — Semáforo de compliance**
- `docProgress` guardado en localStorage al abrir pestaña de documentos
- Badges por mercado en tarjeta de historial: 🟢 `UE ✓` / 🟡 `USA 5/11` / 🔴 `AU 0/10`
- Gate en "Aprobado": avisa si hay docs faltantes antes de permitir el cambio

**Fase 4 — Atributos condicionales + hints**
- Nuevas características: `conectividad` → FCC+RED · `internet` → Cybersecurity · `kit_quimico` → EN71-9+SDS
- `STANDARDS_EQUIVALENCE`: hints en tiempo real al escribir norma (ASTM F963, EN/IEC 62115, etc.)
- Hint estático en `REG_US_CPC`: "El CPC lo genera el importador, no el laboratorio"
- Prompt Claude actualizado con nuevos IDs

---

## Dashboard (implementado 2026-06-02)

- Al hacer login, el usuario ve el **Dashboard** en lugar del formulario vacío
- Grilla de tarjetas con: badge de estado, nombre, categoría, fecha, mercados, badges de progreso de docs, aviso de docs pendientes
- Filtros: Todos / Borrador / En revisión / Aprobado
- Botón "← Dashboard" en header de resultados para volver
- Botón "+ Nuevo expediente" abre formulario limpio
- Botón 🏠 en header ya apunta a `showDashboard()`
- Funciones nuevas: `showDashboard()`, `hideDashboard()`, `renderDashboard()`, `renderDashGrid()`, `setDashFilter()`, `openNewExpediente()`, `openDashboardItem()`, `regenerateFromDash()`, `loadAsTemplateFromDash()`

---

## PPWR — Reglamento (UE) 2025/40 (implementado 2026-06-09)

Envases y residuos de envases para el mercado UE. Reflejado en las 4 áreas:

| Área | Cambio |
|---|---|
| Normativas | `MARKETS.UE.envases` (nuevo array, 7 bullets) → subsección **§3.5 "Envases y residuos de envases (PPWR)"** en expediente HTML y Word, solo UE. Labels `s3_5` en EN/ES/PT |
| Etiquetado | 2 líneas en `etiquetado_base` (etiqueta composición material + pictograma recogida selectiva) + 3 ítems en `LABEL_REQUIREMENTS.UE`: `ppwr_material_label` (always), `ppwr_sorting_pictogram` (always), `ppwr_pfas_foodcontact` (food). Hints en `LABEL_SEARCH_HINTS` |
| DOCS_MASTER | `REG_EU_PPWR_DOC` (required, UE) + `TEST_PFAS_PACKAGING` (conditional, trigger `has_food_contact`) |
| Trigger | Nuevo `has_food_contact` en `getProductAttribs` (lee `componentes[].contacto_alimento === 'Directo'` o char `food_direct`) |
| Prompt Claude | Nota PPWR solo para UE (`isUE = cfg.nombre === 'Union Europea'`) → genera ≥1 no-conformidad de envase cuando aplica |

**Verificado contra EUR-Lex / Comisión Europea (2026-06):** Reg. (UE) 2025/40, en vigor 11-feb-2025, aplica 12-ago-2026 (deroga Dir. 94/62/CE).
- PFAS contacto alimentario: **Art. 5** (no Anexo II) — límites 25 ppb individual / 250 ppb suma / 50 ppm total — desde 12-ago-2026, sin grandfathering
- Metales pesados ≤100 mg/kg: **Art. 5(4)**
- Reciclabilidad: **Art. 6 + Anexo II** — grados A/B/C desde 1-ene-2030, solo A/B desde 2038
- Contenido reciclado: **Art. 7** desde 1-ene-2030
- Minimización: **Art. 10** (1-ene-2030) · ratio espacio vacío: **Art. 24**
- Etiquetado armonizado: **Art. 12** — mandatorio ~12-ago-2028
- DoC: **Art. 39 (modelo Anexo VIII)** · evaluación de conformidad + doc. técnica: **Art. 38 / Anexo VII**

Correcciones aplicadas (commit posterior): los refs originales citaban "Anexo II" erróneamente para PFAS/metales y mezclaban Art. 10/24 y Art. 39/Anexo VII.

---

## Auditoría normativa UE — REACH / EN 71 / Reg. 10/2011 (2026-06-10)

Verificado contra EUR-Lex / Comisión Europea / SGS / Eurofins. Correcciones aplicadas:

| Tema | Antes | Corregido |
|---|---|---|
| **BPA** | Reg. (UE) 2018/213 — SML 0.05 mg/kg | **Reg. (UE) 2024/3190** prohíbe BPA en MOCA (deroga 2018/213; en vigor 20-ene-2025, transición a 20-jul-2026). Policarbonato no permitido para contacto alimentario. Actualizado UE + Internacional + nota AU |
| **SML estireno** | Annex I — SML 0.045 mg/kg (inventado) | Estireno **sin SML**; solo límite organoléptico Art. 3 Reg. 1935/2004 |
| **EN 71-9** | citado como vigente ("EN 71-9:2021") | **Retirado**; años 2021/2022 inventados eliminados. Ftalatos → REACH Anexo XVII (51/52); métodos EN 71-11 |
| **EN 71-1** | 2014+A1:2018 | Nota: EN 71-1:2026 publicado ene-2026 (verificar listado DOUE antes de cambiar la referencia armonizada) |
| **Dir. 2009/48/CE** | — | Nota: reemplazada por Reglamento Seguridad de Juguetes (UE) 2025/2509 |
| **Dir. 84/500/CEE** | "Glass in contact with food" | Es de **cerámica**; el vidrio se evalúa bajo el marco 1935/2004 (tests Pb/Cd aplicados a vidrio decorado por analogía) |
| **REACH** | "Restriction of SVHC, Annex XVII" (mezcla) | Restricciones Anexo XVII + Lista de Candidatas SVHC (Art. 59) por separado |

**Verificado correcto (sin cambios):** OML 10 mg/dm² o 60 mg/kg (Art. 12) · acetaldehído 6 mg/kg · VCM <0.01 mg/kg · ftalatos máx. 0.1% · EN 71-2:2020 · EN 71-3:2019+A1:2021 · 1935/2004 (Art. 3/15) · 2023/2006 GMP · cilindro Ø31.7×57.1 mm · cuerdas >220 mm.

---

## Verificación contra normas oficiales adquiridas — EN 71 (2026-06-10)

El usuario (PING SOLUTIONS) colocó en `Normas/` (carpeta **git-ignored** por copyright) las normas oficiales adquiridas: UNE-EN 71-1/2/3, Reg. 10/2011 (EN+ES), Directiva 2009/48/CE, Reg. 1272/2008, Reg. 1935/2004, Guidance doc 20, Reese's Law, 16 CFR 1263, UL 4200A, + RTAC002801 (Brasil), RM517-2008-MINSA (Perú).

Verificado contra los PDF oficiales:
- **EN 71-1**: versión EU = **EN 71-1:2014+A1:2018** (UNE adopción 2015+A1:2019) → app ya correcta ✅
- **EN 71-2**: versión EU = **EN 71-2:2020** (UNE 2021) → app ya correcta ✅
- **EN 71-3**: app citaba `+A1:2021` (obsoleta). Vigente = **EN 71-3:2019+A2:2024** (A2 aprobada 2024-10-31, anula A1:2021). **Corregido** (8 ocurrencias).
- **EN 71-3 — 19 elementos** (la app listaba solo 8): Al, Sb, As, Ba, B, Cd, Cr(III), Cr(VI), Co, Cu, Pb, Mn, Hg, Ni, Se, Sr, Sn, estaño orgánico, Zn. Límites por **Categoría I (seco/quebradizo/polvo/maleable) / II (líquido/pegajoso) / III (raspado)** en mg/kg (Tabla 2). Ej. Pb: Cat I 2,0 / II 0,5 / III 23. Cr(VI): 0,02 / 0,005 / 0,053. Cd: 1,3 / 0,3 / 17.
- **Bug corregido en app.js**: describía "categoría III (secos, quebradizos, en polvo)" — eso es **Cat I**; Cat III = materiales **raspados/recubrimientos**. Límite Pb citado (2 mg/kg) era el de Cat I.
- **Importante**: las listas de **8 elementos** en contextos **ISO 8124-3 / NM 300-3 / NTC 4894-3** (Australia, LATAM, México) son **correctas** — ISO 8124-3 usa 8 elementos; solo EN 71-3 se amplió a 19. No se tocaron.

**Pendiente posible:** profundizar con los textos de Reg. 10/2011, Directiva 2009/48/CE y RTAC002801 (Brasil) si se desea más detalle.

---

## Perú — RM 517-2008-MINSA / Reglamento Ley 28376 (2026-06-10)

Leído el PDF oficial (`Normas/Perú/RM517-2008-MINSA.pdf`). Publica el proyecto de Reglamento de la **Ley N° 28376** (prohíbe juguetes y útiles de escritorio tóxicos/peligrosos). Reglamento operativo = **D.S. N° 008-2007-SA** (mod. **D.S. 012-2007-SA**), administrado por **MINSA/DIGESA**.

**Corrección clave:** la app citaba *"Decreto Supremo PRODUCE"* para juguetes Perú → **falso**. Es Ley 28376 / D.S. 008-2007-SA (MINSA-DIGESA). Corregido en `Peru.juguetes` y en LATAM consolidado.

**Datos añadidos a la app (verificados del texto):**
- **Marco**: DIGESA (autoridad nacional) + Direcciones Regionales de Salud emiten **Registro (5 años)** + **Autorización Sanitaria (2 años)**. **SUNAT** exige Autorización Sanitaria para nacionalizar (Art. 7, 17-19, 22).
- **Art. 21** — ensayos de elementos tóxicos referencian **ASTM F963-03 o EN 71 Parte 3** (informes válidos 3 años).
- **Anexo IV — LMP (mg/kg)**: As 25 · Sb 60 · Ba 1000 · Cd 75 · Cr 60 · Pb 90 · Hg 60 · Se 500 (= 8 elementos clásicos ISO 8124-3, valida que las listas de 8 elementos de Perú están correctas). Ni ≤ 0,5 µg/cm²/sem (contacto prolongado piel); benceno ≤ 5 mg/kg; tolueno ≤ 170 ppm; ftalatos DEHP/DBP/BBP/DINP/DIDP/DNOP restringidos; creosota/alquitrán de hulla prohibidos.
- **Art. 34 — rotulado** (castellano): importador+RUC, país origen, uso/montaje, advertencias, **leyenda de edad objetivo**, **N° Registro + Autorización Sanitaria**. Añadido `LABEL_REQUIREMENTS.Peru` id `toy_auth` (cond:toy) + hint OCR.
- Anexo I = juguetes (por partida 9503...), Anexo II = excluidos, Anexo III = útiles escolares.

**Nota:** la **NTP 399.163** (que corregimos antes) es la de MOCA (envases plásticos alimentos) — distinta de este régimen de juguetes. Ambas coexisten correctamente.

---

## Auditoría normativa USA / Australia (2026-06-10)

Verificado contra eCFR / Cornell LII / CPSC. Correcciones:

| Mercado | Antes | Corregido |
|---|---|---|
| **USA** | "CPSC Recess Act 2022" (pilas botón) | **Reese's Law 2022** (16 CFR 1263 / UL 4200A) — nombre correcto. 7 ocurrencias (app.js + data) |
| **USA** | `21 CFR 177.2800` para acero inox/metal | 177.2800 es **"Textiles and textile fibers"** — incorrecto. FDA no tiene reg. específica de migración para acero; ref. NSF/ANSI 51, AISI 304/316 |

**Verificado correcto USA:** ASTM F963-23 (**16 CFR Part 1250** ✓) · 16 CFR 1303 (plomo pintura 90 ppm) / 1307 (ftalatos) / 1501 (partes pequeñas) · CPSIA Sec. 101 (plomo 100 ppm) / Sec. 103 (tracking) · 21 CFR 177.1010/1520/1640/2600/1630/1210/1580 · ASTM C738/C927 (vidrio Pb/Cd) · 19 CFR 134 · Prop 65.

**Australia:** referencias OK (AS/NZS ISO 8124.1:2019/.2:2015/.3:2020, AS/NZS 62368.1:2018, EESS, RCM, ACMA, AICIS, Country of Origin Standard 2016). **Nuance:** Australia no tiene una norma MOCA dedicada; "FSANZ Standard 1.4.1" (Contaminants) + uso de EU/FDA como referencia es la práctica real (la app ya lo anota).

---

## Auditoría normativa LATAM / México / CAM (2026-06-10)

Verificado contra fuentes oficiales (ANVISA/gov.br, INACAL/Perú, argentina.gob.ar/ANMAT, COFEPRIS/DOF, inventario oficial RTCA osartec/ARSA, MINSALUD Colombia). Correcciones aplicadas en `compliance-data.js` y `app.js`:

| Mercado | Antes (incorrecto) | Corregido |
|---|---|---|
| **Perú** | `NTP 399.165` (no es MOCA) | **NTP 399.163** (Envases y accesorios plásticos en contacto con alimentos, partes 1-16). 19 ocurrencias |
| **Argentina** | `Resolución 909/2005 (IRAM)`, `Disposición ANMAT 4980/2005` (juguetes), `IRAM-ISO 8124` | **IRAM-NM 300** (partes 1-6) vía **Res. SCT 163/2005**; **Res. MS 583/2008 y 2/2011** (ftalatos). ANMAT 4980/2005 era de **publicidad** (¡no MOCA ni juguetes!) y fue **derogada jun-2025** por Disp. 4059/2025. Contacto alimentos AR → **CAA Cap. IV / MERCOSUR GMC RES 32/2011** |
| **México** | `NOM-004-SSA1-2013` descrita como "envases de plástico para alimentos" | NOM-004-SSA1-2013 = **"Limitaciones y especificaciones sanitarias para el uso de los compuestos de plomo"** (¡no envases!). México **no tiene NOM específica de plásticos MOCA**; marco real = Ley General de Salud + Reglamento Control Sanitario; COFEPRIS acepta FDA 21 CFR 177 / EU 10/2011 |
| **México** | `NOM-019-ANCE-2016 — electrodomésticos` (no existe) | **NOM-001-SCFI-2018** (Aparatos electrónicos: requisitos de seguridad). NOM-019 real = SCFI-1998, equipo de cómputo |
| **CAM** | `RTCA 67.01.33:06` para MOCA (todo el bloque) | 67.01.33:06 = **Buenas Prácticas de Manufactura** (alimentos), no MOCA. **CAM no tiene RTCA armonizado de MOCA** → Codex / FDA 21 CFR 177 / EU 10/2011 |
| **CAM** | `RTCA 65.01.53:08` y `RTCA 71.03.47:07` (juguetes) | **No existen** (serie 71.03 = higiénicos/cosméticos). **CAM no tiene RTCA armonizado de juguetes** → ISO 8124 / regulación nacional |
| **CAM** | `RTCA 23.01.33:06` (país de origen) | No aplica (serie 23.xx = eficiencia energética) → Ley de Protección al Consumidor nacional |
| **Colombia** | `Res. 834/2013` descrita como general + usada para ABS (plástico) | 834/2013 = **materiales celulósicos** (≤8 mg/dm²). Plásticos/ABS → **Res. 683/2012** |

**Verificado correcto:** 🇧🇷 ANVISA **RDC 589/2021** (LMT 10 mg/dm² / 60 mg/kg ✓), RDC 105/1999, RDC 91/2001, RDC 56/2012, Portaria INMETRO 563/2016, ABNT NBR NM 300, CONAMA 401/2008 · 🇨🇴 NTC 4894, RETIE Res. 90708/2013 · 🇲🇽 NOM-015-SCFI-2007 (juguetes), NOM-050-SCFI-2004 (etiquetado), NOM-003-SCFI-2014, NOM-051/161-SEMARNAT/018-STPS · CAM RTCA 67.04.54 (contaminantes), 67.01.07:10 (etiquetado alimentos).

**Nota:** se corrigió un bug de duplicación ("EU Reg. 10/2011 / EU Reg. 10/2011") introducido por el reemplazo global en CAM. Ambos archivos pasan `node --check`.

---

## Bugs corregidos en esta sesión (2026-06-01)

| Commit | Bug | Causa | Fix |
|---|---|---|---|
| `5f0f22b` | "Path inválido" al subir docs | Regex de 1 nivel — docs usan 2 niveles (`expId/docs/file`) | Regex `+` en lugar de `$` |
| `a124a9a` | "Missing or insufficient permissions" | Subcolección `documentos` no estaba en reglas Firestore | Agregar `match /documentos/{docCode}` en Firebase Console |
| `c6a4c1f` | No se podían subir imágenes | Servidor solo aceptaba 4 MIME types explícitos | Cambiar a `contentType.startsWith('image/')` |
| `a002574` | "Path inválido" con capturas de pantalla | Filename `p.m..png` tiene `..` → bloqueado como path traversal | Servidor: check `..` como segmento completo; cliente: colapsar `..` en safeName |

---

## Decisiones técnicas

| Decisión | Razón |
|---|---|
| Upload vía proxy server-side (base64) | Evita CORS; permite usar service key sin exponerla |
| PDFs >3 MB → compresión client-side | Evita error 413 en Vercel |
| Subcolección `documentos` separada | Evidencias = adjuntos libres; documentos = ruta estructurada |
| `DOCS_MASTER` en `compliance-data.js` | Separación datos/lógica |
| `docProgress` en localStorage | Render historial síncrono; Firestore sería lento para N tarjetas |
| Gate "Aprobado" como confirm | Permite casos excepcionales sin bloquear el flujo |
| Path traversal: check segmento completo | `..` en nombre de archivo es legítimo; solo `/../` es un ataque |

---

## Roles (7)

| Key | Label |
|---|---|
| `admin` | Administrador |
| `coord_compliance` | Coord. Compliance |
| `coord_desarrollo` | Coord. Desarrollo de Producto |
| `gerente_nd` | Gerente Nuevos Desarrollos |
| `coord_supply` | Coord. Supply Chain |
| `analyst` | Analista |
| `viewer` | Visor (solo lectura) |

---

## Todos los commits de esta sesión

| Commit | Descripción |
|---|---|
| `5f0f22b` | Fix path validation (1→N niveles) |
| `a124a9a` | Fase 2: modal metadatos, vencimientos, eliminar |
| `b7a3c15` | Fase 3: semáforo historial, gate Aprobado |
| `b1b0cc2` | Fase 4: atributos condicionales, hints normas, hint CPC |
| `c6a4c1f` | Permitir todos los `image/*` en upload proxy |
| `a002574` | Fix path validation con `..` en nombre de archivo |
| `cd5e45e` | Dashboard home screen — vista global de proyectos |

---

## Pendiente técnico

- Rotar API key de Anthropic (fue expuesta en screenshot anterior)
- Integración Synology (diseñada, pendiente credenciales del usuario)

---

## Próximos pasos posibles

- ~~Módulo de etiquetado — checklist editable~~ ✅ (`0d1e0dd`)
- ~~Dashboard: búsqueda/filtro por texto~~ ✅ (`5ce6f08`)
- ~~Dashboard: sincronizar expedientes desde Firestore~~ ✅ (`5ce8488`)
- Integración Synology — explorador de archivos del NAS para adjuntar a expedientes
- Notificaciones de vencimiento — email/push cuando un doc está por vencer
- Dashboard: ordenamiento por fecha/estado
- PPWR: verificar fechas regulatorias contra el texto oficial publicado; añadir grados de reciclabilidad como metadato de envase
