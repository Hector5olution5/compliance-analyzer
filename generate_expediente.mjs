// Script de generación standalone — Hello Kitty Backpack AMC
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Browser shims ─────────────────────────────────────────────────────────────
const localStorage = { _d: {}, getItem: k => null, setItem: () => {} };
const document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
const window = { _validationTimer: null };
const alert = () => {};
const console_orig = console;

// ── Load compliance-data.js into global context ───────────────────────────────
let cdCode = fs.readFileSync(path.join(__dirname, 'compliance-data.js'), 'utf8');
cdCode = cdCode.replace(/function getApiKey[\s\S]*?^}/m, '');
vm.runInThisContext(cdCode);

// ── Load pure functions from app.js into global context ──────────────────────
let appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const startIdx = appCode.indexOf('\nfunction getRisks(');
const endIdx   = appCode.indexOf('\nfunction renderResults(');
vm.runInThisContext(appCode.slice(startIdx, endIdx));

// Groq helpers
const groqStart = appCode.indexOf('\nasync function callGroq(');
const groqEnd   = appCode.indexOf('\n// ── Risk Assessment');
vm.runInThisContext(appCode.slice(groqStart, groqEnd));

// ── Formdata — Hello Kitty Backpack AMC ──────────────────────────────────────
const formData = {
  nombre:       'Hello Kitty 3D Backpack',
  categoria:    'Contenedor de alimentos',
  descripcion:  'Mochila 3D con figura Hello Kitty de 85 oz (2.5 L) de capacidad. Cuerpo fabricado en silicona con partes estructurales en ABS. Incluye cremalleras metálicas y charm decorativo de PVC. Producto promocional para AMC Theaters, apto para adultos y niños.',
  componentes: [
    { componente: 'Cuerpo / back panel (partes 4-10)', material: 'Silicona',  contacto_alimento: 'Directo'       },
    { componente: 'Marco estructural / face (partes 1-3)', material: 'ABS',   contacto_alimento: 'Indirecto'     },
    { componente: 'Cremalleras frontales y laterales',  material: 'Metal',    contacto_alimento: 'Sin contacto'  },
    { componente: 'Charm decorativo Hello Kitty',       material: 'PVC',      contacto_alimento: 'Sin contacto'  },
    { componente: 'Correas ajustables',                 material: 'Silicona', contacto_alimento: 'Sin contacto'  },
  ],
  caracteristicas: ['food_direct', 'plastico', 'ninos', 'disenio_3d', 'partes_pequenas', 'multicolor', 'piezas_moviles'],
  edad_minima: '',
  capacidad:   '85 oz / 2.5 L',
  empresa:     'Golden Link International Ltd.',
  responsable: 'AMC Theaters — Compliance & Quality',
  cargo:       'Quality Manager',
  contacto:    'compliance@amctheatres.com',
  canal:       'Food service — AMC Theaters (USA)',
  publico:     'Adultos y niños',
  referencia:  '3BP-379-KIT',
  version:     '1.0',
  fecha:       '18/05/2026',
};

// ── Override callGroq to use direct fetch ─────────────────────────────────────
async function callGroqDirect(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEFAULT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1200,
    }),
  });
  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ── Generate for each market ──────────────────────────────────────────────────
async function generateMarket(mercadoKey) {
  const cfg = MARKETS[mercadoKey];
  const L   = LABELS[cfg.idioma];
  console.log(`  [${mercadoKey}] Llamando Groq...`);

  const matDirecto = formData.componentes.filter(c => c.contacto_alimento === 'Directo').map(c => `${c.componente} (${c.material})`).join(', ') || 'ninguno';
  const matAll     = [...new Set(formData.componentes.map(c => c.material))].join(', ');
  const lang       = cfg.idioma === 'en' ? 'English' : cfg.idioma === 'pt' ? 'Portuguese (Brazil)' : 'Spanish';
  const prio       = cfg.idioma === 'en' ? 'HIGH/MEDIUM/LOW' : cfg.idioma === 'pt' ? 'ALTO/MEDIO/BAIXO' : 'ALTO/MEDIO/BAJO';

  const prompt = `You are a compliance expert for food-contact promotional products. Market: ${cfg.nombre}.

PRODUCT: ${formData.nombre} | ${formData.categoria}
PROVIDED DESCRIPTION: ${formData.descripcion}
MATERIALS: ${matAll}
DIRECT FOOD CONTACT: ${matDirecto}
CHARACTERISTICS: ${formData.caracteristicas.join(', ')}
CAPACITY: ${formData.capacidad}

Generate ONLY valid JSON (no markdown):
{"descripcion_general":"1 concise paragraph about the product using only declared materials — improve the provided description","uso_previsto":"1 clear sentence","usos_indebidos":["misuse 1","misuse 2","misuse 3"],"advertencias_adicionales":["product-specific warning derived from materials/characteristics — NOT generic microwave/dishwasher/sharp-edge warnings — only include if truly applicable to this specific product"],"no_conformidades":[{"situacion":"specific non-conformity situation for this product","criticidad":"${prio.split('/')[0]}","accion":"specific corrective action","responsable":"responsible department","plazo":"deadline"}],"acciones_recomendadas":[{"prioridad":"${prio.split('/')[0]}","accion":"specific action","responsable":"responsible department","plazo":"30 days"}]}

IMPORTANT for advertencias_adicionales: generate 1-3 warnings that are SPECIFIC to this product's materials and use (food-contact silicone container, ABS structural parts, PVC charm, metallic zippers, children's promotional item at food service venue). Focus on: silicone food-grade requirements, ABS styrene migration, PVC phthalates in charm.

Response language: ${lang}. JSON only, no extra text.`;

  let aiData;
  try {
    const text = await callGroqDirect(prompt);
    let clean = text;
    if (clean.includes('```')) { const parts = clean.split('```'); clean = parts[1] || parts[0]; if (clean.startsWith('json')) clean = clean.slice(4); }
    aiData = JSON.parse(clean.trim());
    console.log(`  [${mercadoKey}] ✓ Groq OK — ${aiData.advertencias_adicionales?.length || 0} advertencias IA`);
  } catch (e) {
    console.warn(`  [${mercadoKey}] ⚠ Groq fallback: ${e.message}`);
    aiData = {
      descripcion_general: formData.descripcion,
      uso_previsto: cfg.idioma === 'en' ? 'Intended as a food-safe promotional backpack container for AMC Theaters.' : 'Destinado como mochila-contenedor inocua para alimentos en AMC Theaters.',
      usos_indebidos: cfg.idioma === 'en'
        ? ['Do not use for hot liquids above 60°C', 'Do not use in microwave', 'Do not use as toy for children under 3']
        : ['No usar para líquidos calientes por encima de 60°C', 'No usar en microondas', 'No usar como juguete para menores de 3 años'],
      advertencias_adicionales: [],
      no_conformidades: [{ situacion: cfg.idioma === 'en' ? 'Migration test failure' : 'Fallo en ensayo de migración', criticidad: cfg.idioma === 'en' ? 'CRITICAL' : 'CRÍTICO', accion: cfg.idioma === 'en' ? 'Quarantine batch and commission retest at ISO 17025 lab' : 'Cuarentenar lote y encargar re-ensayo en laboratorio ISO 17025', responsable: cfg.idioma === 'en' ? 'Quality' : 'Calidad', plazo: cfg.idioma === 'en' ? '30 days' : '30 días' }],
      acciones_recomendadas: [{ prioridad: L.prio_alto, accion: cfg.idioma === 'en' ? 'Obtain FDA 21 CFR 177.2600 compliance statement for silicone' : 'Obtener declaración de conformidad FDA 21 CFR 177.2600 para silicona', responsable: cfg.idioma === 'en' ? 'Procurement / Quality' : 'Compras / Calidad', plazo: cfg.idioma === 'en' ? 'Within 15 days' : 'En los próximos 15 días' }],
    };
  }

  const html = buildHTMLPreview(formData, mercadoKey, cfg, L, aiData);
  return { mercadoKey, html, cfg };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'Producto', 'Expedientes_HK_Backpack');
fs.mkdirSync(outDir, { recursive: true });

const CSS = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const wrap = (body, title) => `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${title}</title><style>${CSS}</style></head><body><div style="max-width:900px;margin:0 auto;padding:24px">${body}</div></body></html>`;

console.log('\n🚀 Generando expedientes — Hello Kitty Backpack AMC\n');

const markets = ['Internacional', 'LATAM', 'CAM'];
const results = [];

for (const key of markets) {
  const r = await generateMarket(key);
  results.push(r);
  const filename = `Expediente_${key}_Hello_Kitty_Backpack.html`;
  const fullHTML = wrap(r.html, `Expediente ${key} — Hello Kitty Backpack`);
  fs.writeFileSync(path.join(outDir, filename), fullHTML, 'utf8');
  console.log(`  ✓ Guardado: ${filename}`);
}

console.log(`\n✅ 3 expedientes generados en:\n   ${outDir}\n`);
