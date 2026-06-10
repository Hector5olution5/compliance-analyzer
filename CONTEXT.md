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
