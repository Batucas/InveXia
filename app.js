import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   Datos del modelo de riesgo
   ============================================================ */
const BANDS = [ null,
  { n:1, label:"Conservador",          cvar:"--risk-1", alloc:{cash:15, fixed_income:65, equity:18, crypto:2} },
  { n:2, label:"Moderado-Conservador", cvar:"--risk-2", alloc:{cash:10, fixed_income:55, equity:30, crypto:5} },
  { n:3, label:"Moderado",             cvar:"--risk-3", alloc:{cash:8,  fixed_income:40, equity:45, crypto:7} },
  { n:4, label:"Moderado-Agresivo",    cvar:"--risk-4", alloc:{cash:5,  fixed_income:25, equity:60, crypto:10} },
  { n:5, label:"Agresivo",             cvar:"--risk-5", alloc:{cash:5,  fixed_income:10, equity:70, crypto:15} },
];
const CLASSES = {
  cash:         { label:"Liquidez",        color:"#38BDF8" },
  fixed_income: { label:"Renta fija",      color:"#4F86F7" },
  equity:       { label:"Renta variable",  color:"#2E7DF6" },
  crypto:       { label:"Cripto",          color:"#2DD4BF" },
  alt:          { label:"Alternativos",    color:"#F59E0B" },
};
const HORIZON_CAP = {1:2, 2:3, 3:4, 4:5, 5:5};

const WILLINGNESS = [
  { id:"W1", q:"El mercado cae y tu inversión pierde 20% en un mes. ¿Qué haces?",
    o:["Vendo todo para no perder más","Vendo una parte","Espero sin hacer nada","Mantengo, es parte del juego","Compro más aprovechando el precio"] },
  { id:"W2", q:"¿Con qué frase te identificas más?",
    o:["Proteger mi capital aunque gane poco","Priorizo estabilidad sobre crecimiento","Busco equilibrio entre ambos","Priorizo crecimiento aunque haya vaivenes","Quiero el máximo crecimiento posible"] },
  { id:"W3", q:"Tu experiencia invirtiendo es:",
    o:["Ninguna","Solo ahorro / DPF","Algo de bonos y fondos","Acciones y ETFs","Amplia, incluye activos volátiles"] },
  { id:"W4", q:"¿Cuánta variación anual de tu cartera tolerarías?",
    o:["± 2 %","± 5 %","± 10 %","± 20 %","± 30 % o más"] },
  { id:"W5", q:"Una inversión sube 40 % y luego vuelve a tu precio de entrada. Sientes:",
    o:["Frustración, habría vendido","Incomodidad","Es normal","Tranquilidad, es de largo plazo","Oportunidad de comprar más"] },
];
const CAPACITY = [
  { id:"C1", horizon:true, q:"¿En cuánto tiempo podrías necesitar este dinero?",
    o:["Menos de 1 año","1 a 3 años","3 a 5 años","5 a 10 años","Más de 10 años"] },
  { id:"C2", q:"Tus ingresos son:",
    o:["Muy inestables","Variables","Estables","Estables y crecientes","Altos y diversificados"] },
  { id:"C3", q:"Esta inversión representa aproximadamente qué parte de tu patrimonio:",
    o:["Más del 75 %","50 – 75 %","25 – 50 %","10 – 25 %","Menos del 10 %"] },
  { id:"C4", q:"Fondo de emergencia (meses de gastos cubiertos):",
    o:["No tengo","Menos de 1 mes","1 – 3 meses","3 – 6 meses","Más de 6 meses"] },
  { id:"C5", q:"Obligaciones o dependientes económicos:",
    o:["Muchas, presupuesto ajustado","Varias","Algunas","Pocas","Ninguna, holgado"] },
];

/* ============================================================
   Estado + utilidades
   ============================================================ */
const state = { session:null, profile:null, view:null, param:null,
                answers:{}, cache:{} };

const $  = (s,r=document)=>r.querySelector(s);
const el = (h)=>{ const t=document.createElement("template"); t.innerHTML=h.trim(); return t.content.firstChild; };
const esc=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const cssv=(v)=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const initials=(n)=> (n||"?").split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
const fmtDate=(d)=> new Date(d).toLocaleDateString("es-BO",{day:"2-digit",month:"short",year:"numeric"});
const fmtTime=(d)=> new Date(d).toLocaleString("es-BO",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});

function scoreToBand(score, qCount){
  const t=(score - qCount)/(qCount*5 - qCount);      // 0..1
  return Math.min(5, Math.floor(t*5)+1);
}
function computeProfile(ans){
  const wq=WILLINGNESS.map(x=>x.id), cq=CAPACITY.map(x=>x.id);
  const ws=wq.reduce((a,k)=>a+(ans[k]||0),0);
  const cs=cq.reduce((a,k)=>a+(ans[k]||0),0);
  const wb=scoreToBand(ws, wq.length), cb=scoreToBand(cs, cq.length);
  const hb=ans["C1"]||3;
  const final=Math.min(wb, cb, HORIZON_CAP[hb]);
  return { willingness_score:ws, willingness_band:wb, capacity_score:cs,
           capacity_band:cb, horizon_band:hb, final_band:final,
           band_label:BANDS[final].label };
}

/* ============================================================
   UI helpers
   ============================================================ */
const ui = {
  authMode(m){
    const login=m==="login";
    $("#tabLogin").classList.toggle("on",login);
    $("#tabReg").classList.toggle("on",!login);
    $("#fieldName").classList.toggle("hidden",login);
    $("#authTitle").textContent = login?"Bienvenido":"Crea tu cuenta";
    $("#authLead").textContent  = login?"Ingresa a tu cuenta para continuar."
                                        :"Regístrate para descubrir tu perfil de inversor.";
    $("#authBtn").textContent   = login?"Iniciar sesión":"Crear cuenta";
    $("#inPass").autocomplete   = login?"current-password":"new-password";
    auth.mode=m; $("#authMsg").textContent="";
  },
  toggleSidebar(){ $("#sidebar").classList.toggle("open"); },
  toast(msg, kind=""){
    const t=$("#toast"); t.textContent=msg; t.className="toast show "+kind;
    setTimeout(()=>t.className="toast",2600);
  },
};
window.ui = ui;

/* ============================================================
   Autenticación
   ============================================================ */
const auth = {
  mode:"login",
  async submit(){
    const email=$("#inEmail").value.trim(), pass=$("#inPass").value;
    const name=$("#inName").value.trim();
    const box=$("#authMsg"); box.className="msg-line";
    if(!email||!pass){ box.textContent="Completa correo y contraseña."; box.classList.add("err"); return; }
    const btn=$("#authBtn"); btn.disabled=true; const prev=btn.textContent;
    btn.innerHTML='<span class="spinner"></span>';
    try{
      if(this.mode==="register"){
        const { error } = await sb.auth.signUp({ email, password:pass,
          options:{ data:{ full_name:name||email } } });
        if(error) throw error;
        box.textContent="Cuenta creada. Iniciando sesión…"; box.classList.add("ok");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password:pass });
        if(error) throw error;
      }
    }catch(e){
      box.textContent = translateErr(e.message); box.classList.add("err");
    }finally{ btn.disabled=false; btn.textContent=prev; }
  },
  async logout(){ await sb.auth.signOut(); location.hash=""; },
};
window.auth = auth;

function translateErr(m=""){
  if(/Invalid login/i.test(m)) return "Correo o contraseña incorrectos.";
  if(/already registered/i.test(m)) return "Ese correo ya tiene una cuenta.";
  if(/at least 6/i.test(m)) return "La contraseña debe tener al menos 6 caracteres.";
  if(/rate limit/i.test(m)) return "Demasiados intentos. Espera un momento.";
  if(/fetch/i.test(m)) return "No se pudo conectar. Revisa config.js (URL y anon key).";
  return m;
}

/* ============================================================
   Sesión / arranque
   ============================================================ */
sb.auth.onAuthStateChange(async (_e, session)=>{
  state.session = session;
  if(session){ await loadProfile(); enterApp(); }
  else { showAuth(); }
});

async function loadProfile(){
  const { data } = await sb.from("profiles").select("*").eq("id",state.session.user.id).single();
  state.profile = data || { id:state.session.user.id, full_name:state.session.user.email, role:"client" };
}

function showAuth(){ $("#app").classList.add("hidden"); $("#auth").classList.remove("hidden"); }

function enterApp(){
  $("#auth").classList.add("hidden"); $("#app").classList.remove("hidden");
  const p=state.profile, admin=p.role==="admin";
  $("#uName").textContent=p.full_name||"—";
  $("#uRole").textContent=admin?"Administrador":"Cliente";
  $("#uAvatar").textContent=initials(p.full_name);
  buildNav(admin);
  if(!location.hash) location.hash = admin?"#/clientes":"#/inicio";
  else route();
}

/* ============================================================
   Navegación
   ============================================================ */
const NAV_CLIENT=[
  ["inicio","Inicio",icon("home")],
  ["riesgo","Perfil de riesgo",icon("gauge")],
  ["cartera","Mi cartera",icon("pie")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
];
const NAV_ADMIN=[
  ["clientes","Clientes",icon("users")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
];
function buildNav(admin){
  const items = admin?NAV_ADMIN:NAV_CLIENT;
  const nav=$("#nav"); nav.innerHTML="";
  nav.append(el(`<div class="nav-label">${admin?"Administración":"Mi cuenta"}</div>`));
  items.forEach(([id,label,ic])=>{
    const a=el(`<a data-v="${id}">${ic}<span>${label}</span></a>`);
    a.onclick=()=>{ location.hash="#/"+id; $("#sidebar").classList.remove("open"); };
    nav.append(a);
  });
}
window.addEventListener("hashchange", route);
function route(){
  if(!state.session) return;
  const parts=(location.hash.replace(/^#\//,"")||"").split("/");
  state.view=parts[0]||(state.profile.role==="admin"?"clientes":"inicio");
  state.param=parts[1]||null;
  document.querySelectorAll(".nav a").forEach(a=>a.classList.toggle("on",a.dataset.v===state.view));
  render();
}

/* ============================================================
   Render principal
   ============================================================ */
async function render(){
  const m=$("#main"); m.innerHTML=loading();
  const admin=state.profile.role==="admin";
  try{
    if(admin){
      if(state.view==="clientes" && state.param) return void await viewAdminClient(state.param);
      if(state.view==="clientes") return void await viewAdminClients();
      if(state.view==="cursos")   return void await viewCoursesAdmin();
      if(state.view==="calendario") return void await viewCalendarAdmin();
      if(state.view==="mensajes") return void await viewAdminInbox();
    } else {
      if(state.view==="inicio")   return void await viewClientHome();
      if(state.view==="riesgo")   return void await viewRisk();
      if(state.view==="cartera")  return void await viewPortfolio();
      if(state.view==="cursos")   return void await viewCoursesClient();
      if(state.view==="calendario") return void await viewCalendarClient();
      if(state.view==="mensajes") return void await viewClientMessages();
    }
    m.innerHTML=`<div class="empty">Sección no encontrada.</div>`;
  }catch(e){ m.innerHTML=`<div class="empty">Error al cargar: ${esc(e.message)}</div>`; }
}
const loading=()=>`<div class="empty"><span class="spinner" style="border-color:rgba(120,150,200,.3);border-top-color:var(--blue-400)"></span><div style="margin-top:.6rem">Cargando…</div></div>`;
const head=(eyebrow,title,sub="")=>`<div class="page-head no-print"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub?`<p>${sub}</p>`:""}</div><div id="headExtra" class="flex"></div></div>`;

/* ============================================================
   CLIENTE · Inicio
   ============================================================ */
async function viewClientHome(){
  const [ra, pf] = await Promise.all([ latestAssessment(state.profile.id), publishedPortfolio(state.profile.id) ]);
  const step = !ra ? 1 : (!pf ? 2 : 3);
  const m=$("#main");
  m.innerHTML = head("Panel","Hola, "+(state.profile.full_name||"").split(" ")[0])
  + `<div class="steps">
      ${stepBox(1,"Perfil de riesgo","Responde tu cuestionario",step)}
      ${stepBox(2,"Diseño de cartera","Tu asesor la construye",step)}
      ${stepBox(3,"Seguimiento","Consulta y conversa",step)}
    </div>`;

  const wrap=el(`<div class="grid grid-2"></div>`);
  // Tarjeta de estado
  if(step===1){
    wrap.append(el(`<div class="card">
      <h3>Empecemos por tu perfil</h3>
      <p class="card-sub">Un cuestionario de ~10 preguntas para conocer tu disposición y tu capacidad de asumir riesgo. Toma 3 minutos.</p>
      <button class="btn btn-primary" style="width:auto" onclick="location.hash='#/riesgo'">Responder cuestionario</button>
    </div>`));
  } else if(step===2){
    wrap.append(el(`<div class="card">
      <h3>Perfil listo · <span style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</span></h3>
      <p class="card-sub">Tu asesor está diseñando una cartera acorde a tu perfil. Te avisaremos aquí cuando esté publicada.</p>
      <span class="pill dot pill-warn">En diseño</span>
    </div>`));
  } else {
    wrap.append(el(`<div class="card">
      <h3>Tu cartera está lista</h3>
      <p class="card-sub">Perfil <b style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</b>. Revisa la composición y el detalle de posiciones.</p>
      <button class="btn btn-primary" style="width:auto" onclick="location.hash='#/cartera'">Ver mi cartera</button>
    </div>`));
  }
  // Accesos
  wrap.append(el(`<div class="card">
    <h3>Accesos rápidos</h3>
    <p class="card-sub">Herramientas disponibles para ti.</p>
    <div class="flex" style="flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/cursos'">Cursos</button>
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/calendario'">Calendario</button>
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/mensajes'">Escribir a mi asesor</button>
    </div>
  </div>`));
  m.append(wrap);
}
function stepBox(n,title,sub,cur){
  const cls = cur>n?"done":(cur===n?"active":"");
  return `<div class="step ${cls}"><div class="si">Paso ${n}${cur>n?" · ✓":""}</div><div class="st">${title}</div></div>`;
}

/* ============================================================
   CLIENTE · Perfil de riesgo (cuestionario)
   ============================================================ */
async function viewRisk(){
  const ra=await latestAssessment(state.profile.id);
  const m=$("#main");
  if(ra && !state.cache.retake){
    m.innerHTML=head("Perfil de inversor","Tu perfil de riesgo",
      "Calculado el "+fmtDate(ra.created_at)+".");
    m.append(renderResult(ra, true));
    $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="app.retake()">Volver a responder</button>`));
    return;
  }
  state.answers={};
  m.innerHTML=head("Perfil de inversor","Cuestionario de riesgo",
    "Elige la opción que mejor te describa. Medimos dos ejes: tu disposición (actitud) y tu capacidad (situación) frente al riesgo.");
  const form=el(`<div class="card"></div>`);
  form.append(el(`<div class="nav-label" style="padding-left:0">Eje 1 · Disposición al riesgo</div>`));
  WILLINGNESS.forEach((q,i)=>form.append(question(q,i+1)));
  form.append(el(`<div class="divide"></div>`));
  form.append(el(`<div class="nav-label" style="padding-left:0">Eje 2 · Capacidad de riesgo</div>`));
  CAPACITY.forEach((q,i)=>form.append(question(q,WILLINGNESS.length+i+1)));
  const bar=el(`<div class="flex between mt2"><span class="card-sub" id="prog" style="margin:0">0 de ${WILLINGNESS.length+CAPACITY.length} respondidas</span></div>`);
  const btn=el(`<button class="btn btn-primary" style="width:auto" disabled onclick="app.saveProfiler()">Ver mi perfil</button>`);
  bar.append(btn); form.append(bar);
  m.append(form);
}
function question(q,num){
  const node=el(`<div class="q" data-id="${q.id}">
    <div class="qn">Pregunta ${String(num).padStart(2,"0")}</div>
    <h4>${esc(q.q)}</h4><div class="opts"></div></div>`);
  const opts=$(".opts",node);
  q.o.forEach((txt,i)=>{
    const val=i+1;
    const o=el(`<div class="opt" data-v="${val}"><div class="rk"></div><div class="ot">${esc(txt)}</div></div>`);
    o.onclick=()=>{ opts.querySelectorAll(".opt").forEach(x=>x.classList.remove("sel"));
      o.classList.add("sel"); state.answers[q.id]=val; updateProgress(); };
    opts.append(o);
  });
  return node;
}
function updateProgress(){
  const total=WILLINGNESS.length+CAPACITY.length, done=Object.keys(state.answers).length;
  $("#prog").textContent=`${done} de ${total} respondidas`;
  const btn=$(".card .btn-primary"); if(btn) btn.disabled = done<total;
}

/* ============================================================
   CLIENTE · Resultado del perfil (con cuadrante = firma visual)
   ============================================================ */
function renderResult(ra, saved){
  const b=BANDS[ra.final_band], col=cssv(b.cvar);
  const node=el(`<div>
    <div class="quad-wrap">
      <div class="card">
        <h3>Mapa disposición × capacidad</h3>
        <p class="card-sub">Tu perfil final es el más prudente entre ambos ejes, ajustado por tu horizonte.</p>
        <div class="quad">${quadrant(ra)}</div>
      </div>
      <div class="card">
        <div class="eyebrow" style="color:var(--blue-400);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600">Perfil final</div>
        <div class="band-chip mono" style="color:${col};margin-top:.5rem">Nivel ${b.n} · ${esc(b.label)}</div>
        <div class="grid" style="margin-top:1.1rem">
          ${axisRow("Disposición",ra.willingness_band)}
          ${axisRow("Capacidad",ra.capacity_band)}
          ${axisRow("Horizonte",ra.horizon_band)}
        </div>
        <div class="divide"></div>
        <div class="nav-label" style="padding:0 0 .5rem">Asignación sugerida</div>
        ${allocBars(b.alloc)}
        <p class="card-sub" style="margin-top:1rem">Rangos de referencia. Tu asesor ajustará la cartera final e instrumentos concretos.</p>
      </div>
    </div>
    <div class="flex mt2 no-print">
      <button class="btn btn-ghost btn-sm" onclick="app.exportPDF()">Descargar / imprimir (PDF)</button>
      <button class="btn btn-ghost btn-sm" onclick="app.exportJSON('${ra.id||"local"}')">Exportar datos (JSON)</button>
    </div>
  </div>`);
  node._ra=ra;
  return node;
}
function axisRow(label,band){
  const col=cssv(BANDS[band].cvar);
  return `<div class="alloc-row"><span class="lbl">${label}</span>
    <div class="bar"><i style="width:${band*20}%;background:${col}"></i></div>
    <span class="pct" style="color:${col}">${band}/5</span></div>`;
}
function allocBars(a){
  return Object.entries(a).map(([k,v])=>{
    const c=CLASSES[k]; if(!c) return "";
    return `<div class="alloc-row"><span class="lbl">${c.label}</span>
      <div class="bar"><i style="width:${v}%;background:${c.color}"></i></div>
      <span class="pct">${v}%</span></div>`;
  }).join("");
}
// Cuadrante SVG: x=capacidad, y=disposición, punto=cliente
function quadrant(ra){
  const W=100,H=100, x=(ra.capacity_band-.5)*20, y=100-(ra.willingness_band-.5)*20;
  const cells=[];
  for(let cap=1;cap<=5;cap++) for(let wil=1;wil<=5;wil++){
    const band=Math.min(wil,cap,HORIZON_CAP[ra.horizon_band]);
    cells.push(`<rect x="${(cap-1)*20}" y="${100-wil*20}" width="20" height="20"
      fill="${cssv(BANDS[band].cvar)}" opacity="${band===ra.final_band?.34:.12}"/>`);
  }
  return `<svg viewBox="-16 -6 128 128" width="100%" style="display:block">
    ${cells.join("")}
    <line x1="0" y1="0" x2="0" y2="100" stroke="var(--line-strong)" stroke-width=".6"/>
    <line x1="0" y1="100" x2="100" y2="100" stroke="var(--line-strong)" stroke-width=".6"/>
    <text x="50" y="118" fill="var(--faint)" font-size="5" text-anchor="middle" font-family="Inter">Capacidad de riesgo →</text>
    <text x="-11" y="50" fill="var(--faint)" font-size="5" text-anchor="middle" font-family="Inter" transform="rotate(-90 -11 50)">Disposición al riesgo →</text>
    <circle cx="${x}" cy="${y}" r="4.4" fill="#fff" stroke="var(--blue-500)" stroke-width="1.6"/>
    <circle cx="${x}" cy="${y}" r="9" fill="none" stroke="#fff" stroke-width=".6" opacity=".5"/>
  </svg>`;
}

/* ============================================================
   CLIENTE · Mi cartera
   ============================================================ */
async function viewPortfolio(){
  const pf=await publishedPortfolio(state.profile.id);
  const m=$("#main");
  m.innerHTML=head("Inversión","Mi cartera");
  if(!pf){
    const ra=await latestAssessment(state.profile.id);
    m.append(el(`<div class="card empty">
      ${icon("pie")}
      <h3 style="margin-top:.4rem">${ra?"Tu cartera está en diseño":"Aún no tienes cartera"}</h3>
      <p>${ra?"Tu asesor la publicará pronto. Te avisaremos en tu panel.":"Primero completa tu perfil de riesgo."}</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.6rem"
        onclick="location.hash='${ra?"#/mensajes":"#/riesgo"}'">${ra?"Escribir a mi asesor":"Ir al cuestionario"}</button>
    </div>`));
    return;
  }
  const holds=await sb.from("holdings").select("*").eq("portfolio_id",pf.id).then(r=>r.data||[]);
  const alloc=pf.allocation||{};
  const wrap=el(`<div class="quad-wrap"></div>`);
  wrap.append(el(`<div class="card">
    <div class="flex between"><h3>${esc(pf.name)}</h3><span class="pill pill-blue mono">${esc(pf.currency)}</span></div>
    <p class="card-sub">Composición objetivo de tu cartera.</p>
    <div class="flex" style="gap:1.6rem;align-items:center;flex-wrap:wrap">
      <div style="width:180px">${donut(alloc)}</div>
      <div style="flex:1;min-width:200px">${allocBars(alloc)}</div>
    </div>
    ${pf.notes?`<div class="divide"></div><div class="nav-label" style="padding:0 0 .4rem">Nota de tu asesor</div><p style="color:var(--muted);font-size:.92rem;margin:0">${esc(pf.notes)}</p>`:""}
  </div>`));
  const side=el(`<div class="card"><h3>Posiciones</h3><p class="card-sub">${holds.length} instrumento(s).</p></div>`);
  if(holds.length){
    const t=el(`<table class="tbl"><thead><tr><th>Instrumento</th><th>Clase</th><th style="text-align:right">Peso</th></tr></thead><tbody></tbody></table>`);
    holds.forEach(h=>$("tbody",t).append(el(`<tr>
      <td><b>${esc(h.name)}</b>${h.ticker?` <span class="mono" style="color:var(--faint)">${esc(h.ticker)}</span>`:""}</td>
      <td><span class="pill" style="color:${CLASSES[h.asset_class]?.color||"var(--muted)"}">${CLASSES[h.asset_class]?.label||h.asset_class}</span></td>
      <td class="mono" style="text-align:right">${h.target_weight??"—"}%</td></tr>`)));
    side.append(t);
  } else side.append(el(`<p class="empty" style="padding:1rem">Tu asesor aún no detalló instrumentos.</p>`));
  wrap.append(side);
  m.append(wrap);
}
function donut(alloc){
  const entries=Object.entries(alloc).filter(([,v])=>v>0);
  const total=entries.reduce((a,[,v])=>a+Number(v),0)||1;
  const R=54, C=2*Math.PI*R; let off=0;
  const segs=entries.map(([k,v])=>{
    const len=C*(v/total), s=`<circle cx="60" cy="60" r="${R}" fill="none"
      stroke="${CLASSES[k]?.color||"#888"}" stroke-width="14"
      stroke-dasharray="${len} ${C-len}" stroke-dashoffset="${-off}"
      transform="rotate(-90 60 60)"/>`; off+=len; return s;
  }).join("");
  return `<svg viewBox="0 0 120 120" width="100%">${segs}
    <text x="60" y="57" text-anchor="middle" fill="var(--text)" font-size="15" font-family="JetBrains Mono">${Math.round(total)}%</text>
    <text x="60" y="72" text-anchor="middle" fill="var(--faint)" font-size="8" font-family="Inter">objetivo</text></svg>`;
}

/* ============================================================
   CLIENTE · Cursos / Calendario / Mensajes
   ============================================================ */
async function viewCoursesClient(){
  const cs=await sb.from("courses").select("*").eq("published",true).order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Formación","Cursos","Contenido publicado por InveXia.");
  if(!cs.length){ m.append(el(`<div class="card empty">${icon("book")}<p style="margin-top:.4rem">Aún no hay cursos publicados.</p></div>`)); return; }
  const g=el(`<div class="grid grid-3"></div>`);
  cs.forEach(c=>g.append(el(`<div class="card">
    <span class="pill pill-blue">${esc(c.level||"Curso")}</span>
    <h3 style="margin:.6rem 0 .3rem">${esc(c.title)}</h3>
    <p class="card-sub">${esc(c.description||"")}</p>
    ${c.url?`<a class="btn btn-ghost btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener">Abrir curso</a>`:""}
  </div>`)));
  m.append(g);
}
async function viewCalendarClient(){
  const ev=await sb.from("events").select("*").order("event_date",{ascending:true}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Agenda","Calendario","Próximos eventos y fechas clave.");
  m.append(eventList(ev,false));
}
async function viewClientMessages(){
  const m=$("#main"); m.innerHTML=head("Contacto","Mensajes","Conversa directamente con tu asesor.");
  const card=el(`<div class="card"><div id="chat" class="chat"></div>
    <div class="composer"><input id="msgIn" class="input" placeholder="Escribe un mensaje…" onkeydown="if(event.key==='Enter')app.sendMsg('${state.profile.id}')">
    <button class="btn btn-primary" style="width:auto" onclick="app.sendMsg('${state.profile.id}')">Enviar</button></div></div>`);
  m.append(card);
  await loadThread(state.profile.id);
}

/* ============================================================
   ADMIN · Lista de clientes
   ============================================================ */
async function viewAdminClients(){
  const m=$("#main");
  const clients=await sb.from("profiles").select("*").eq("role","client").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const ras=await sb.from("risk_assessments").select("user_id,final_band,band_label,created_at").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const pfs=await sb.from("portfolios").select("user_id,status").then(r=>r.data||[]);
  const raBy={}, pfBy={};
  ras.forEach(r=>{ if(!raBy[r.user_id]) raBy[r.user_id]=r; });
  pfs.forEach(p=>{ pfBy[p.user_id]=pfBy[p.user_id]||p.status; if(p.status==="published") pfBy[p.user_id]="published"; });

  m.innerHTML=head("Administración","Clientes",`${clients.length} registrado(s).`);
  m.append(el(`<div class="grid grid-3" style="margin-bottom:1.4rem">
    ${stat("Clientes",clients.length,"registrados")}
    ${stat("Con perfil",Object.keys(raBy).length,"cuestionario completo")}
    ${stat("Carteras activas",pfs.filter(p=>p.status==="published").length,"publicadas")}
  </div>`));
  if(!clients.length){ m.append(el(`<div class="card empty">${icon("users")}<p style="margin-top:.4rem">Aún no hay clientes registrados.</p></div>`)); return; }
  const card=el(`<div class="card"><table class="tbl"><thead><tr>
    <th>Cliente</th><th>Perfil de riesgo</th><th>Cartera</th><th>Alta</th></tr></thead><tbody></tbody></table></div>`);
  clients.forEach(c=>{
    const ra=raBy[c.id], st=pfBy[c.id];
    const band = ra?`<span class="mono" style="color:${cssv(BANDS[ra.final_band].cvar)}">●</span> ${esc(ra.band_label)}`:`<span style="color:var(--faint)">Pendiente</span>`;
    const pill = st==="published"?`<span class="pill pill-ok dot">Publicada</span>`
               : st==="draft"?`<span class="pill pill-warn dot">Borrador</span>`
               : `<span class="pill dot" style="color:var(--faint)">Sin cartera</span>`;
    const tr=el(`<tr class="row-click"><td><div class="flex"><div class="avatar" style="width:30px;height:30px">${initials(c.full_name)}</div>
      <div><b>${esc(c.full_name||"—")}</b><br><span class="mono" style="color:var(--faint);font-size:.78rem">${esc(c.email||"")}</span></div></div></td>
      <td>${band}</td><td>${pill}</td><td class="mono" style="color:var(--muted)">${fmtDate(c.created_at)}</td></tr>`);
    tr.onclick=()=>location.hash="#/clientes/"+c.id;
    $("tbody",card).append(tr);
  });
  m.append(card);
}
const stat=(k,v,d)=>`<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;

/* ============================================================
   ADMIN · Detalle de cliente + constructor de cartera
   ============================================================ */
async function viewAdminClient(uid){
  const m=$("#main");
  const client=await sb.from("profiles").select("*").eq("id",uid).single().then(r=>r.data);
  if(!client){ m.innerHTML=`<div class="empty">Cliente no encontrado.</div>`; return; }
  const ra=await latestAssessment(uid);
  let pf=await anyPortfolio(uid);
  const holds= pf ? await sb.from("holdings").select("*").eq("portfolio_id",pf.id).then(r=>r.data||[]) : [];

  m.innerHTML=head("Cliente","","");
  $(".page-head h1")?.remove();
  const ph=$(".page-head > div:first-child");
  ph.innerHTML=`<div class="eyebrow">Cliente</div><h1>${esc(client.full_name||client.email)}</h1>
    <p><span class="mono">${esc(client.email||"")}</span>${client.phone?" · "+esc(client.phone):""}</p>`;
  $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/clientes'">← Clientes</button>`));

  const grid=el(`<div class="quad-wrap"></div>`);
  // Perfil de riesgo
  if(ra){
    const r=renderResult(ra,true); r.classList.add("no-quadwrap");
    const c=el(`<div class="card"><h3>Perfil de riesgo</h3>
      <div class="band-chip mono" style="color:${cssv(BANDS[ra.final_band].cvar)};margin:.6rem 0 1rem">Nivel ${ra.final_band} · ${esc(ra.band_label)}</div>
      <div class="grid">${axisRow("Disposición",ra.willingness_band)}${axisRow("Capacidad",ra.capacity_band)}${axisRow("Horizonte",ra.horizon_band)}</div>
      <div class="divide"></div><div class="quad">${quadrant(ra)}</div></div>`);
    grid.append(c);
  } else {
    grid.append(el(`<div class="card empty">${icon("gauge")}<p style="margin-top:.4rem">Este cliente aún no completó su perfil de riesgo.</p></div>`));
  }

  // Constructor de cartera
  const sugg = ra?BANDS[ra.final_band].alloc:{cash:10,fixed_income:40,equity:45,crypto:5};
  const a = pf?.allocation && Object.keys(pf.allocation).length ? pf.allocation : sugg;
  const builder=el(`<div class="card">
    <div class="flex between"><h3>Cartera</h3>${pf?`<span class="pill dot ${pf.status==='published'?'pill-ok':'pill-warn'}">${pf.status==='published'?'Publicada':'Borrador'}</span>`:""}</div>
    <p class="card-sub">Ajusta la asignación por clase de activo (suma objetivo 100%).</p>
    <div class="field"><label>Nombre de la cartera</label><input id="pfName" class="input" value="${esc(pf?.name||'Cartera principal')}"></div>
    <div class="flex" style="gap:.8rem"><div class="field" style="flex:1"><label>Moneda</label>
      <select id="pfCur" class="input"><option ${pf?.currency==='USD'?'selected':''}>USD</option><option ${pf?.currency==='USDT'?'selected':''}>USDT</option><option ${pf?.currency==='BOB'?'selected':''}>BOB</option></select></div></div>
    <div id="allocEditor"></div>
    <div id="allocSum" class="flex between" style="font-size:.85rem;color:var(--muted);margin:.4rem 0 1rem"></div>
    <div class="field"><label>Nota para el cliente</label><textarea id="pfNotes" class="input" placeholder="Racional de la cartera, recomendaciones…">${esc(pf?.notes||'')}</textarea></div>
    <div class="divide"></div>
    <div class="flex between"><div class="nav-label" style="padding:0">Posiciones (instrumentos)</div>
      <button class="btn btn-ghost btn-sm" onclick="app.addHolding()">+ Añadir</button></div>
    <div id="holdList" class="mt"></div>
    <div class="flex mt2"><button class="btn btn-ghost btn-sm" onclick="app.savePortfolio('${uid}','draft')">Guardar borrador</button>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.savePortfolio('${uid}','published')">Publicar para el cliente</button></div>
  </div>`);
  grid.append(builder); m.append(grid);

  // estado de edición
  state.cache.edit={ uid, pf, alloc:{...a}, holds:holds.map(h=>({...h})) };
  renderAllocEditor(); renderHoldList();
}
function renderAllocEditor(){
  const e=state.cache.edit; const box=$("#allocEditor"); if(!box) return; box.innerHTML="";
  ["cash","fixed_income","equity","crypto","alt"].forEach(k=>{
    if(e.alloc[k]===undefined && k==="alt") return; // alt opcional
    const c=CLASSES[k]; const v=e.alloc[k]??0;
    const row=el(`<div class="alloc-row"><span class="lbl" style="color:${c.color}">${c.label}</span>
      <input type="range" min="0" max="100" value="${v}" style="flex:1" data-k="${k}">
      <span class="pct" data-out="${k}">${v}%</span></div>`);
    $("input",row).oninput=(ev)=>{ e.alloc[k]=Number(ev.target.value); $(`[data-out="${k}"]`).textContent=e.alloc[k]+"%"; allocSum(); };
    box.append(row);
  });
  if(e.alloc.alt===undefined) box.append(el(`<button class="btn btn-ghost btn-sm" onclick="app.addAlt()">+ Alternativos</button>`));
  allocSum();
}
function allocSum(){
  const e=state.cache.edit; const s=Object.values(e.alloc).reduce((a,b)=>a+Number(b||0),0);
  const box=$("#allocSum"); if(box) box.innerHTML=`<span>Suma objetivo</span><span class="mono" style="color:${s===100?'var(--ok)':'var(--warn)'}">${s}%</span>`;
}
function renderHoldList(){
  const e=state.cache.edit; const box=$("#holdList"); if(!box) return; box.innerHTML="";
  if(!e.holds.length){ box.append(el(`<p class="card-sub" style="margin:0">Sin posiciones. Añade instrumentos concretos (ETFs, bonos, DPF, cripto…).</p>`)); return; }
  e.holds.forEach((h,i)=>{
    const row=el(`<div class="list-item">
      <div class="flex" style="flex:1;gap:.5rem;flex-wrap:wrap">
        <input class="input" style="flex:2;min-width:120px" placeholder="Nombre" value="${esc(h.name||'')}" data-f="name" data-i="${i}">
        <input class="input" style="flex:1;min-width:80px" placeholder="Ticker" value="${esc(h.ticker||'')}" data-f="ticker" data-i="${i}">
        <select class="input" style="flex:1;min-width:110px" data-f="asset_class" data-i="${i}">
          ${Object.entries(CLASSES).map(([k,c])=>`<option value="${k}" ${h.asset_class===k?'selected':''}>${c.label}</option>`).join("")}</select>
        <input class="input mono" style="width:80px" type="number" placeholder="%" value="${h.target_weight??''}" data-f="target_weight" data-i="${i}">
      </div>
      <button class="btn btn-ghost btn-sm" data-del="${i}">✕</button></div>`);
    box.append(row);
  });
  box.querySelectorAll("[data-f]").forEach(inp=>inp.oninput=(ev)=>{
    const i=+ev.target.dataset.i, f=ev.target.dataset.f; e.holds[i][f]=ev.target.value; });
  box.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ e.holds.splice(+b.dataset.del,1); renderHoldList(); });
}

/* ============================================================
   ADMIN · Cursos / Calendario / Inbox
   ============================================================ */
async function viewCoursesAdmin(){
  const cs=await sb.from("courses").select("*").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Contenido","Cursos","Crea y publica material para tus clientes.");
  $("#headExtra").append(el(`<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.courseForm()">+ Nuevo curso</button>`));
  const box=el(`<div id="courseForm"></div>`); m.append(box);
  if(!cs.length){ m.append(el(`<div class="card empty">${icon("book")}<p style="margin-top:.4rem">Aún no has creado cursos.</p></div>`)); return; }
  const list=el(`<div class="mt"></div>`);
  cs.forEach(c=>list.append(el(`<div class="list-item">
    <div class="li-main"><b>${esc(c.title)}</b><span>${esc(c.level||"")} · ${c.published?"Publicado":"Borrador"}</span></div>
    <div class="flex">
      <button class="btn btn-ghost btn-sm" onclick="app.togglePub('${c.id}',${!c.published})">${c.published?"Ocultar":"Publicar"}</button>
      <button class="btn btn-ghost btn-sm" onclick="app.delCourse('${c.id}')">Eliminar</button></div></div>`)));
  m.append(list);
}
async function viewCalendarAdmin(){
  const ev=await sb.from("events").select("*").order("event_date",{ascending:true}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Agenda","Calendario","Publica eventos y fechas clave.");
  $("#headExtra").append(el(`<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.eventForm()">+ Nuevo evento</button>`));
  m.append(el(`<div id="eventForm"></div>`));
  m.append(eventList(ev,true));
}
async function viewAdminInbox(){
  const m=$("#main"); m.innerHTML=head("Contacto","Mensajes","Conversaciones con tus clientes.");
  const msgs=await sb.from("messages").select("*").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const ids=[...new Set(msgs.map(x=>x.client_id))];
  if(!ids.length){ m.append(el(`<div class="card empty">${icon("chat")}<p style="margin-top:.4rem">Sin mensajes todavía.</p></div>`)); return; }
  const profs=await sb.from("profiles").select("id,full_name,email").in("id",ids).then(r=>r.data||[]);
  const pmap=Object.fromEntries(profs.map(p=>[p.id,p]));
  if(state.param){ return void await adminThread(state.param, pmap[state.param]); }
  const list=el(`<div></div>`);
  ids.forEach(id=>{
    const last=msgs.find(x=>x.client_id===id);
    const p=pmap[id]||{}; const unread=msgs.some(x=>x.client_id===id && x.sender_role==="client" && !x.read);
    const it=el(`<div class="list-item row-click">
      <div class="flex"><div class="avatar">${initials(p.full_name)}</div>
        <div class="li-main"><b>${esc(p.full_name||p.email||"Cliente")}</b><span>${esc((last?.body||"").slice(0,60))}</span></div></div>
      <div class="flex">${unread?'<span class="pill pill-blue dot">Nuevo</span>':''}<span class="mono" style="color:var(--faint);font-size:.75rem">${fmtTime(last.created_at)}</span></div></div>`);
    it.onclick=()=>location.hash="#/mensajes/"+id; list.append(it);
  });
  m.append(list);
}
async function adminThread(uid,prof){
  const m=$("#main");
  $("#headExtra").innerHTML=""; $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/mensajes'">← Bandeja</button>`));
  $(".page-head h1").textContent=prof?.full_name||prof?.email||"Cliente";
  const card=el(`<div class="card"><div id="chat" class="chat"></div>
    <div class="composer"><input id="msgIn" class="input" placeholder="Responder…" onkeydown="if(event.key==='Enter')app.sendMsg('${uid}')">
    <button class="btn btn-primary" style="width:auto" onclick="app.sendMsg('${uid}')">Enviar</button></div></div>`);
  m.append(card);
  await loadThread(uid);
  await sb.from("messages").update({read:true}).eq("client_id",uid).eq("sender_role","client").eq("read",false);
}

/* ============================================================
   Mensajería (compartida)
   ============================================================ */
async function loadThread(clientId){
  const box=$("#chat"); if(!box) return;
  const msgs=await sb.from("messages").select("*").eq("client_id",clientId).order("created_at",{ascending:true}).then(r=>r.data||[]);
  box.innerHTML="";
  if(!msgs.length){ box.append(el(`<div class="empty" style="padding:1.4rem">Aún no hay mensajes. Escribe el primero.</div>`)); }
  const myRole=state.profile.role;
  msgs.forEach(x=>{
    const mine = x.sender_role===myRole;
    box.append(el(`<div class="bubble ${mine?"me":"them"}">${esc(x.body)}<span class="t">${fmtTime(x.created_at)}</span></div>`));
  });
  box.scrollTop=box.scrollHeight;
}

/* ============================================================
   Calendario / eventos (compartida)
   ============================================================ */
function eventList(ev,admin){
  if(!ev.length) return el(`<div class="card empty">${icon("cal")}<p style="margin-top:.4rem">No hay eventos programados.</p></div>`);
  const box=el(`<div class="mt"></div>`);
  ev.forEach(e=>{
    const d=new Date(e.event_date);
    box.append(el(`<div class="list-item">
      <div class="flex"><div class="avatar" style="flex-direction:column;line-height:1">
        <span class="mono" style="font-size:.9rem;color:var(--blue-300)">${d.getDate()}</span>
        <span style="font-size:.6rem;color:var(--faint);text-transform:uppercase">${d.toLocaleDateString("es-BO",{month:"short"})}</span></div>
        <div class="li-main"><b>${esc(e.title)}</b><span>${esc(e.description||"")}</span></div></div>
      ${admin?`<button class="btn btn-ghost btn-sm" onclick="app.delEvent('${e.id}')">Eliminar</button>`:`<span class="pill pill-blue">${fmtDate(e.event_date)}</span>`}</div>`));
  });
  return box;
}

/* ============================================================
   Acciones (app.*) usadas por onclick
   ============================================================ */
const app = {
  retake(){ state.cache.retake=true; render(); },
  async saveProfiler(){
    const p=computeProfile(state.answers);
    const row={ user_id:state.profile.id, answers:state.answers, ...p };
    const { data, error }=await sb.from("risk_assessments").insert(row).select().single();
    if(error){ ui.toast("No se pudo guardar: "+error.message,"err"); return; }
    state.cache.retake=false;
    const m=$("#main"); m.innerHTML=head("Perfil de inversor","Tu perfil de riesgo","Guardado el "+fmtDate(new Date())+".");
    m.append(renderResult(data,true));
    ui.toast("Perfil calculado y guardado","ok");
  },
  exportPDF(){ window.print(); },
  exportJSON(){
    const data = state.cache.lastRa || { answers:state.answers, ...computeProfile(state.answers) };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download="perfil-invexia.json"; a.click();
  },
  // cartera
  addAlt(){ state.cache.edit.alloc.alt=0; renderAllocEditor(); },
  addHolding(){ state.cache.edit.holds.push({name:"",ticker:"",asset_class:"equity",target_weight:null}); renderHoldList(); },
  async savePortfolio(uid,status){
    const e=state.cache.edit;
    const payload={ user_id:uid, name:$("#pfName").value.trim()||"Cartera principal",
      currency:$("#pfCur").value, status, allocation:e.alloc, notes:$("#pfNotes").value.trim(),
      created_by:state.profile.id, updated_at:new Date().toISOString() };
    let pfId=e.pf?.id;
    if(pfId){ const {error}=await sb.from("portfolios").update(payload).eq("id",pfId); if(error) return ui.toast(error.message,"err"); }
    else { const {data,error}=await sb.from("portfolios").insert(payload).select().single(); if(error) return ui.toast(error.message,"err"); pfId=data.id; e.pf=data; }
    await sb.from("holdings").delete().eq("portfolio_id",pfId);
    const hs=e.holds.filter(h=>h.name).map(h=>({portfolio_id:pfId,name:h.name,ticker:h.ticker||null,
      asset_class:h.asset_class,target_weight:h.target_weight?Number(h.target_weight):null}));
    if(hs.length) await sb.from("holdings").insert(hs);
    ui.toast(status==="published"?"Cartera publicada para el cliente":"Borrador guardado","ok");
    render();
  },
  // mensajes
  async sendMsg(clientId){
    const inp=$("#msgIn"); const body=inp.value.trim(); if(!body) return;
    inp.value="";
    const {error}=await sb.from("messages").insert({ client_id:clientId, sender_id:state.profile.id,
      sender_role:state.profile.role, body });
    if(error) return ui.toast(error.message,"err");
    await loadThread(clientId);
  },
  // cursos
  courseForm(){
    const box=$("#courseForm"); if(box.dataset.open){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    box.innerHTML=`<div class="card">
      <div class="field"><label>Título</label><input id="cT" class="input"></div>
      <div class="flex" style="gap:.8rem"><div class="field" style="flex:1"><label>Nivel</label>
        <select id="cL" class="input"><option>Básico</option><option>Intermedio</option><option>Avanzado</option></select></div>
        <div class="field" style="flex:2"><label>Enlace (opcional)</label><input id="cU" class="input" placeholder="https://…"></div></div>
      <div class="field"><label>Descripción</label><textarea id="cD" class="input"></textarea></div>
      <div class="flex"><label class="flex" style="gap:.4rem;color:var(--muted);font-size:.85rem"><input type="checkbox" id="cP" checked> Publicar de inmediato</label>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-left:auto" onclick="app.saveCourse()">Guardar curso</button></div></div>`;
  },
  async saveCourse(){
    const t=$("#cT").value.trim(); if(!t) return ui.toast("Ponle un título","err");
    const {error}=await sb.from("courses").insert({ title:t, level:$("#cL").value, url:$("#cU").value.trim()||null,
      description:$("#cD").value.trim(), published:$("#cP").checked });
    if(error) return ui.toast(error.message,"err");
    ui.toast("Curso creado","ok"); render();
  },
  async togglePub(id,pub){ await sb.from("courses").update({published:pub}).eq("id",id); render(); },
  async delCourse(id){ if(!confirm("¿Eliminar este curso?"))return; await sb.from("courses").delete().eq("id",id); render(); },
  // eventos
  eventForm(){
    const box=$("#eventForm"); if(box.dataset.open){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    box.innerHTML=`<div class="card"><div class="flex" style="gap:.8rem">
      <div class="field" style="flex:2"><label>Título</label><input id="eT" class="input"></div>
      <div class="field" style="flex:1"><label>Fecha</label><input id="eD" class="input" type="date"></div></div>
      <div class="field"><label>Descripción</label><input id="eDesc" class="input"></div>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.saveEvent()">Guardar evento</button></div>`;
  },
  async saveEvent(){
    const t=$("#eT").value.trim(), d=$("#eD").value; if(!t||!d) return ui.toast("Título y fecha requeridos","err");
    const {error}=await sb.from("events").insert({ title:t, event_date:d, description:$("#eDesc").value.trim() });
    if(error) return ui.toast(error.message,"err"); ui.toast("Evento creado","ok"); render();
  },
  async delEvent(id){ if(!confirm("¿Eliminar evento?"))return; await sb.from("events").delete().eq("id",id); render(); },
};
window.app = app;

/* ============================================================
   Consultas reutilizables
   ============================================================ */
async function latestAssessment(uid){
  const {data}=await sb.from("risk_assessments").select("*").eq("user_id",uid)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(data) state.cache.lastRa=data;
  return data;
}
async function publishedPortfolio(uid){
  const {data}=await sb.from("portfolios").select("*").eq("user_id",uid).eq("status","published")
    .order("updated_at",{ascending:false}).limit(1).maybeSingle();
  return data;
}
async function anyPortfolio(uid){
  const {data}=await sb.from("portfolios").select("*").eq("user_id",uid)
    .order("updated_at",{ascending:false}).limit(1).maybeSingle();
  return data;
}

/* ============================================================
   Íconos (SVG inline, trazo)
   ============================================================ */
function icon(n){
  const p={
    home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    gauge:'<path d="M12 13l4-4"/><path d="M4 18a8 8 0 1 1 16 0"/>',
    pie:'<path d="M12 3v9l7 4"/><circle cx="12" cy="12" r="9"/>',
    book:'<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/>',
    cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
    chat:'<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
    users:'<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7"/>',
  }[n]||"";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

/* ============================================================
   Init
   ============================================================ */
(async ()=>{
  ui.authMode("login");
  const { data:{ session } } = await sb.auth.getSession();
  if(session){ state.session=session; await loadProfile(); enterApp(); }
  else showAuth();
})();
