import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ============================================================
   Modelo de riesgo
   ============================================================ */
const BANDS = [ null,
  { n:1, label:"Conservador",          cvar:"--risk-1", mu:.045, sigma:.05, alloc:{cash:15, fixed_income:65, equity:18, crypto:2} },
  { n:2, label:"Moderado-Conservador", cvar:"--risk-2", mu:.060, sigma:.08, alloc:{cash:10, fixed_income:55, equity:30, crypto:5} },
  { n:3, label:"Moderado",             cvar:"--risk-3", mu:.075, sigma:.11, alloc:{cash:8,  fixed_income:40, equity:45, crypto:7} },
  { n:4, label:"Moderado-Agresivo",    cvar:"--risk-4", mu:.090, sigma:.15, alloc:{cash:5,  fixed_income:25, equity:60, crypto:10} },
  { n:5, label:"Agresivo",             cvar:"--risk-5", mu:.105, sigma:.19, alloc:{cash:5,  fixed_income:10, equity:70, crypto:15} },
];
const CLASSES = {
  cash:         { label:"Liquidez",       color:"#38BDF8" },
  fixed_income: { label:"Renta fija",     color:"#4F86F7" },
  equity:       { label:"Renta variable", color:"#2E7DF6" },
  crypto:       { label:"Cripto",         color:"#2DD4BF" },
  alt:          { label:"Alternativos",   color:"#F59E0B" },
};
const HORIZON_CAP = {1:2, 2:3, 3:4, 4:5, 5:5};

const GOALS = {
  jubilacion: "Jubilación",
  vivienda:   "Compra de vivienda o bien material",
  educacion:  "Educación",
  emergencia: "Fondo de emergencia",
  patrimonio: "Crecimiento de patrimonio",
  otro:       "Otro",
};

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
                answers:{}, goal:{}, cache:{} };

const $  = (s,r=document)=>r.querySelector(s);
const el = (h)=>{ const t=document.createElement("template"); t.innerHTML=h.trim(); return t.content.firstChild; };
const esc=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const cssv=(v)=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const initials=(n)=>(n||"?").split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
const fmtDate=(d)=>new Date(d).toLocaleDateString("es-BO",{day:"2-digit",month:"short",year:"numeric"});
const fmtTime=(d)=>new Date(d).toLocaleString("es-BO",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
const money=(v,c="USD")=>(v==null||!isFinite(v))?"—":new Intl.NumberFormat("es-BO",{style:"currency",currency:c,maximumFractionDigits:2}).format(v);
const pct=(v)=>(v==null||!isFinite(v))?"—":(v>=0?"+":"")+v.toFixed(2)+"%";
const num=(v)=>{const n=parseFloat(v);return isFinite(n)?n:null;};
const sgn=(v)=>v>0?"pos":(v<0?"neg":"");

function scoreToBand(score,q){ return Math.min(5, Math.floor(((score-q)/(q*5-q))*5)+1); }
function computeProfile(ans){
  const ws=WILLINGNESS.reduce((a,x)=>a+(ans[x.id]||0),0);
  const cs=CAPACITY.reduce((a,x)=>a+(ans[x.id]||0),0);
  const wb=scoreToBand(ws,WILLINGNESS.length), cb=scoreToBand(cs,CAPACITY.length);
  const hb=ans["C1"]||3;
  const final=Math.min(wb,cb,HORIZON_CAP[hb]);
  return { willingness_score:ws, willingness_band:wb, capacity_score:cs,
           capacity_band:cb, horizon_band:hb, final_band:final, band_label:BANDS[final].label };
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
    $("#fieldPhone").classList.toggle("hidden",login);
    $("#authTitle").textContent = login?"Bienvenido":"Crea tu cuenta";
    $("#authLead").textContent  = login?"Ingresa a tu cuenta para continuar."
                                       :"Regístrate para descubrir tu perfil de inversor.";
    $("#authBtn").textContent   = login?"Iniciar sesión":"Crear cuenta";
    $("#inPass").autocomplete   = login?"current-password":"new-password";
    auth.mode=m; $("#authMsg").textContent="";
  },
  toggleSidebar(){ $("#sidebar").classList.toggle("open"); },
  toast(msg,kind=""){ const t=$("#toast"); t.textContent=msg; t.className="toast show "+kind;
    setTimeout(()=>t.className="toast",2800); },
};
window.ui = ui;

/* ============================================================
   Autenticación
   ============================================================ */
const auth = {
  mode:"login",
  async submit(){
    const email=$("#inEmail").value.trim(), pass=$("#inPass").value;
    const name=$("#inName").value.trim(), phone=$("#inPhone").value.trim();
    const box=$("#authMsg"); box.className="msg-line";
    if(!email||!pass){ box.textContent="Completa correo y contraseña."; box.classList.add("err"); return; }
    if(this.mode==="register" && !name){ box.textContent="Ingresa tu nombre completo."; box.classList.add("err"); return; }
    const btn=$("#authBtn"); btn.disabled=true; const prev=btn.textContent;
    btn.innerHTML='<span class="spinner"></span>';
    try{
      if(this.mode==="register"){
        const { error } = await sb.auth.signUp({ email, password:pass,
          options:{ data:{ full_name:name, phone } } });
        if(error) throw error;
        box.textContent="Cuenta creada. Iniciando sesión…"; box.classList.add("ok");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password:pass });
        if(error) throw error;
      }
    }catch(e){ box.textContent=translateErr(e.message); box.classList.add("err"); }
    finally{ btn.disabled=false; btn.textContent=prev; }
  },
  async logout(){ await sb.auth.signOut(); location.hash=""; },
};
window.auth = auth;

function translateErr(m=""){
  if(/Invalid login/i.test(m)) return "Correo o contraseña incorrectos.";
  if(/already registered/i.test(m)) return "Ese correo ya tiene una cuenta.";
  if(/at least 6/i.test(m)) return "La contraseña debe tener al menos 6 caracteres.";
  if(/rate limit/i.test(m)) return "Demasiados intentos. Espera un momento.";
  if(/fetch|path/i.test(m)) return "No se pudo conectar. Revisa config.js (URL y llave).";
  return m;
}

/* ============================================================
   Sesión
   ============================================================ */
sb.auth.onAuthStateChange(async (_e,session)=>{
  state.session=session;
  if(session){ await loadProfile(); enterApp(); } else showAuth();
});
async function loadProfile(){
  const { data } = await sb.from("profiles").select("*").eq("id",state.session.user.id).single();
  state.profile = data || { id:state.session.user.id, full_name:state.session.user.email, role:"client" };
  // guardar teléfono del signUp si el trigger no lo copió
  const metaPhone = state.session.user.user_metadata?.phone;
  if(metaPhone && !state.profile.phone){
    await sb.from("profiles").update({phone:metaPhone}).eq("id",state.profile.id);
    state.profile.phone=metaPhone;
  }
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
  ["simulador","Simulador",icon("chart")],
  ["mercado","Mercado e ideas",icon("news")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
];
const NAV_ADMIN=[
  ["clientes","Clientes",icon("users")],
  ["publicaciones","Noticias e ideas",icon("news")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
];
function buildNav(admin){
  const nav=$("#nav"); nav.innerHTML="";
  nav.append(el(`<div class="nav-label">${admin?"Administración":"Mi cuenta"}</div>`));
  (admin?NAV_ADMIN:NAV_CLIENT).forEach(([id,label,ic])=>{
    const a=el(`<a data-v="${id}">${ic}<span>${label}</span></a>`);
    a.onclick=()=>{ location.hash="#/"+id; $("#sidebar").classList.remove("open"); };
    nav.append(a);
  });
}
window.addEventListener("hashchange",route);
function route(){
  if(!state.session) return;
  const parts=(location.hash.replace(/^#\//,"")||"").split("/");
  state.view=parts[0]||(state.profile.role==="admin"?"clientes":"inicio");
  state.param=parts[1]||null;
  document.querySelectorAll(".nav a").forEach(a=>a.classList.toggle("on",a.dataset.v===state.view));
  render();
}

/* ============================================================
   Render
   ============================================================ */
async function render(){
  const m=$("#main"); m.innerHTML=loading();
  const admin=state.profile.role==="admin";
  try{
    if(admin){
      if(state.view==="clientes"&&state.param) return void await viewAdminClient(state.param);
      if(state.view==="clientes")      return void await viewAdminClients();
      if(state.view==="publicaciones") return void await viewPostsAdmin();
      if(state.view==="cursos")        return void await viewCoursesAdmin();
      if(state.view==="calendario")    return void await viewCalendarAdmin();
      if(state.view==="mensajes")      return void await viewAdminInbox();
    } else {
      if(state.view==="inicio")     return void await viewClientHome();
      if(state.view==="riesgo")     return void await viewRisk();
      if(state.view==="cartera")    return void await viewPortfolio();
      if(state.view==="simulador")  return void await viewSimulator();
      if(state.view==="mercado")    return void await viewFeed();
      if(state.view==="cursos")     return void await viewCoursesClient();
      if(state.view==="calendario") return void await viewCalendarClient();
      if(state.view==="mensajes")   return void await viewClientMessages();
    }
    m.innerHTML=`<div class="empty">Sección no encontrada.</div>`;
  }catch(e){ m.innerHTML=`<div class="empty">Error al cargar: ${esc(e.message)}</div>`; console.error(e); }
}
const loading=()=>`<div class="empty"><span class="spinner" style="border-color:rgba(120,150,200,.3);border-top-color:var(--blue-400)"></span><div style="margin-top:.6rem">Cargando…</div></div>`;
const head=(eyebrow,title,sub="")=>`<div class="page-head no-print"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub?`<p>${sub}</p>`:""}</div><div id="headExtra" class="flex"></div></div>`;

/* ============================================================
   CLIENTE · Inicio
   ============================================================ */
async function viewClientHome(){
  const [ra,pf]=await Promise.all([latestAssessment(state.profile.id), publishedPortfolio(state.profile.id)]);
  const step=!ra?1:(!pf?2:3);
  const m=$("#main");
  m.innerHTML=head("Panel","Hola, "+(state.profile.full_name||"").split(" ")[0])
   +`<div class="steps">
      ${stepBox(1,"Perfil de riesgo",step)}
      ${stepBox(2,"Diseño de cartera",step)}
      ${stepBox(3,"Seguimiento",step)}
     </div>`;
  const wrap=el(`<div class="grid grid-2"></div>`);
  if(step===1){
    wrap.append(el(`<div class="card"><h3>Empecemos por tu perfil</h3>
      <p class="card-sub">Cuéntanos tu objetivo, cuánto puedes aportar y responde ~10 preguntas. Toma 4 minutos.</p>
      <button class="btn btn-primary" style="width:auto" onclick="location.hash='#/riesgo'">Responder cuestionario</button></div>`));
  } else if(step===2){
    wrap.append(el(`<div class="card"><h3>Perfil listo · <span style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</span></h3>
      <p class="card-sub">Tu asesor está diseñando tu cartera. Mientras tanto, puedes proyectar tus aportes en el simulador.</p>
      <div class="flex"><span class="pill dot pill-warn">En diseño</span>
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/simulador'">Abrir simulador</button></div></div>`));
  } else {
    wrap.append(el(`<div class="card"><h3>Tu cartera está lista</h3>
      <p class="card-sub">Perfil <b style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</b>. Revisa composición y rendimiento.</p>
      <button class="btn btn-primary" style="width:auto" onclick="location.hash='#/cartera'">Ver mi cartera</button></div>`));
  }
  wrap.append(el(`<div class="card"><h3>Mis datos de contacto</h3>
    <p class="card-sub">Tu asesor te contactará por estos medios.</p>
    <div class="field"><label>Correo</label><input class="input" value="${esc(state.profile.email||"")}" disabled></div>
    <div class="field"><label>Celular (con código de país)</label>
      <input id="phIn" class="input" placeholder="+591 7xxxxxxx" value="${esc(state.profile.phone||"")}"></div>
    <button class="btn btn-ghost btn-sm" onclick="app.savePhone()">Guardar celular</button></div>`));
  m.append(wrap);
}
function stepBox(n,title,cur){
  const cls=cur>n?"done":(cur===n?"active":"");
  return `<div class="step ${cls}"><div class="si">Paso ${n}${cur>n?" · ✓":""}</div><div class="st">${title}</div></div>`;
}

/* ============================================================
   CLIENTE · Cuestionario (objetivos + aportes + dos ejes)
   ============================================================ */
async function viewRisk(){
  const ra=await latestAssessment(state.profile.id);
  const m=$("#main");
  if(ra && !state.cache.retake){
    m.innerHTML=head("Perfil de inversor","Tu perfil de riesgo","Calculado el "+fmtDate(ra.created_at)+".");
    m.append(renderResult(ra));
    $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="app.retake()">Volver a responder</button>`));
    return;
  }
  state.answers={}; state.goal={};
  m.innerHTML=head("Perfil de inversor","Cuestionario","Tres bloques: tu objetivo, tu plan de aportes, y los dos ejes de riesgo.");

  const form=el(`<div class="card"></div>`);

  // --- Bloque 0: objetivo ---
  form.append(el(`<div class="nav-label" style="padding-left:0">Bloque 1 · Tu objetivo</div>`));
  const goalOpts=Object.entries(GOALS).map(([k,v])=>`<option value="${k}">${v}</option>`).join("");
  form.append(el(`<div class="field"><label>¿Para qué inviertes?</label>
    <select id="gType" class="input" onchange="app.goalTypeChange()"><option value="">Elige un objetivo…</option>${goalOpts}</select></div>`));
  form.append(el(`<div id="gOtherWrap" class="field hidden"><label>Describe tu objetivo</label>
    <input id="gOther" class="input" placeholder="Ej. abrir un negocio"></div>`));
  form.append(el(`<div class="flex" style="gap:.8rem;flex-wrap:wrap">
    <div class="field" style="flex:1;min-width:150px"><label>Monto meta (opcional)</label><input id="gTarget" class="input mono" type="number" placeholder="50000"></div>
    <div class="field" style="flex:1;min-width:150px"><label>Fecha meta (opcional)</label><input id="gDate" class="input" type="date"></div>
    <div class="field" style="flex:0 0 110px"><label>Moneda</label><select id="gCur" class="input"><option>USD</option><option>BOB</option><option>USDT</option></select></div>
  </div>`));

  // --- Bloque 1: aportes ---
  form.append(el(`<div class="divide"></div><div class="nav-label" style="padding-left:0">Bloque 2 · Tu plan de aportes</div>`));
  form.append(el(`<div class="flex" style="gap:.8rem;flex-wrap:wrap">
    <div class="field" style="flex:1;min-width:170px"><label>Monto inicial a invertir</label><input id="gInit" class="input mono" type="number" placeholder="5000"></div>
    <div class="field" style="flex:1;min-width:170px"><label>¿Cuánto podrías aportar cada mes?</label><input id="gMonthly" class="input mono" type="number" placeholder="300"></div>
  </div>`));

  // --- Bloque 2: ejes ---
  form.append(el(`<div class="divide"></div><div class="nav-label" style="padding-left:0">Bloque 3 · Disposición al riesgo</div>`));
  WILLINGNESS.forEach((q,i)=>form.append(question(q,i+1)));
  form.append(el(`<div class="divide"></div><div class="nav-label" style="padding-left:0">Bloque 4 · Capacidad de riesgo</div>`));
  CAPACITY.forEach((q,i)=>form.append(question(q,WILLINGNESS.length+i+1)));

  const bar=el(`<div class="flex between mt2"><span class="card-sub" id="prog" style="margin:0">0 de ${WILLINGNESS.length+CAPACITY.length} respondidas</span></div>`);
  bar.append(el(`<button id="subBtn" class="btn btn-primary" style="width:auto" disabled onclick="app.saveProfiler()">Ver mi perfil</button>`));
  form.append(bar);
  m.append(form);
}
function question(q,n){
  const node=el(`<div class="q" data-id="${q.id}">
    <div class="qn">Pregunta ${String(n).padStart(2,"0")}</div>
    <h4>${esc(q.q)}</h4><div class="opts"></div></div>`);
  const opts=$(".opts",node);
  q.o.forEach((txt,i)=>{
    const o=el(`<div class="opt" data-v="${i+1}"><div class="rk"></div><div class="ot">${esc(txt)}</div></div>`);
    o.onclick=()=>{ opts.querySelectorAll(".opt").forEach(x=>x.classList.remove("sel"));
      o.classList.add("sel"); state.answers[q.id]=i+1; updateProgress(); };
    opts.append(o);
  });
  return node;
}
function updateProgress(){
  const total=WILLINGNESS.length+CAPACITY.length, done=Object.keys(state.answers).length;
  $("#prog").textContent=`${done} de ${total} respondidas`;
  const b=$("#subBtn"); if(b) b.disabled=done<total;
}

/* ============================================================
   CLIENTE · Resultado
   ============================================================ */
function renderResult(ra){
  const b=BANDS[ra.final_band], col=cssv(b.cvar);
  const goal = ra.goal_type ? (ra.goal_type==="otro" ? (ra.goal_other||"Otro") : GOALS[ra.goal_type]) : null;
  const cur = ra.currency||"USD";
  return el(`<div>
    <div class="quad-wrap">
      <div class="card">
        <h3>Mapa disposición × capacidad</h3>
        <p class="card-sub">Tu perfil final es el más prudente entre ambos ejes, acotado por tu horizonte.</p>
        <div class="quad">${quadrant(ra)}</div>
      </div>
      <div class="card">
        <div class="eyebrow" style="color:var(--blue-400);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600">Perfil final</div>
        <div class="band-chip mono" style="color:${col};margin-top:.5rem">Nivel ${b.n} · ${esc(b.label)}</div>
        ${goal?`<div class="divide"></div>
          <div class="nav-label" style="padding:0 0 .5rem">Tu objetivo</div>
          <div class="kv"><span>Objetivo</span><b>${esc(goal)}</b></div>
          ${ra.target_amount?`<div class="kv"><span>Monto meta</span><b class="mono">${money(ra.target_amount,cur)}</b></div>`:""}
          ${ra.target_date?`<div class="kv"><span>Fecha meta</span><b class="mono">${fmtDate(ra.target_date)}</b></div>`:""}
          ${ra.monthly_contribution?`<div class="kv"><span>Aporte mensual</span><b class="mono">${money(ra.monthly_contribution,cur)}</b></div>`:""}`:""}
        <div class="divide"></div>
        <div class="grid">
          ${axisRow("Disposición",ra.willingness_band)}
          ${axisRow("Capacidad",ra.capacity_band)}
          ${axisRow("Horizonte",ra.horizon_band)}
        </div>
        <div class="divide"></div>
        <div class="nav-label" style="padding:0 0 .5rem">Asignación sugerida</div>
        ${allocBars(b.alloc)}
        <p class="card-sub" style="margin-top:1rem">Rangos de referencia. Tu asesor define la cartera final e instrumentos.</p>
      </div>
    </div>
    <div class="flex mt2 no-print">
      <button class="btn btn-ghost btn-sm" onclick="app.exportPDF()">Descargar / imprimir (PDF)</button>
      <button class="btn btn-ghost btn-sm" onclick="app.exportJSON()">Exportar datos (JSON)</button>
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/simulador'">Proyectar mis aportes →</button>
    </div>
  </div>`);
}
function axisRow(label,band){
  const col=cssv(BANDS[band].cvar);
  return `<div class="alloc-row"><span class="lbl">${label}</span>
    <div class="bar"><i style="width:${band*20}%;background:${col}"></i></div>
    <span class="pct" style="color:${col}">${band}/5</span></div>`;
}
function allocBars(a){
  return Object.entries(a).filter(([k])=>CLASSES[k]).map(([k,v])=>
    `<div class="alloc-row"><span class="lbl">${CLASSES[k].label}</span>
     <div class="bar"><i style="width:${v}%;background:${CLASSES[k].color}"></i></div>
     <span class="pct">${v}%</span></div>`).join("");
}
function quadrant(ra){
  const x=(ra.capacity_band-.5)*20, y=100-(ra.willingness_band-.5)*20;
  const cells=[];
  for(let cap=1;cap<=5;cap++) for(let wil=1;wil<=5;wil++){
    const band=Math.min(wil,cap,HORIZON_CAP[ra.horizon_band]);
    cells.push(`<rect x="${(cap-1)*20}" y="${100-wil*20}" width="20" height="20"
      fill="${cssv(BANDS[band].cvar)}" opacity="${band===ra.final_band?.34:.12}"/>`);
  }
  return `<svg viewBox="-16 -6 128 128" width="100%" style="display:block">${cells.join("")}
    <line x1="0" y1="0" x2="0" y2="100" stroke="var(--line-strong)" stroke-width=".6"/>
    <line x1="0" y1="100" x2="100" y2="100" stroke="var(--line-strong)" stroke-width=".6"/>
    <text x="50" y="118" fill="var(--faint)" font-size="5" text-anchor="middle" font-family="Inter">Capacidad de riesgo →</text>
    <text x="-11" y="50" fill="var(--faint)" font-size="5" text-anchor="middle" font-family="Inter" transform="rotate(-90 -11 50)">Disposición al riesgo →</text>
    <circle cx="${x}" cy="${y}" r="4.4" fill="#fff" stroke="var(--blue-500)" stroke-width="1.6"/>
    <circle cx="${x}" cy="${y}" r="9" fill="none" stroke="#fff" stroke-width=".6" opacity=".5"/></svg>`;
}

/* ============================================================
   Cotizaciones (vía /api/quotes)
   ============================================================ */
async function fetchQuotes(symbols){
  if(!symbols.length) return { ok:true, quotes:{} };
  try{
    const r=await fetch("/api/quotes?symbols="+encodeURIComponent(symbols.join(",")));
    if(r.status===404) return { ok:false, error:"no_api",
      message:"La función /api/quotes no está desplegada. ¿Subiste la carpeta api/ a GitHub?" };
    const ct=r.headers.get("content-type")||"";
    if(!ct.includes("application/json")) return { ok:false, error:"no_api",
      message:"El servidor no devolvió datos. En local usa 'npx vercel dev'." };
    return await r.json();
  }catch(e){ return { ok:false, error:"offline", message:"Sin conexión con el servidor de precios." }; }
}
// Precio efectivo de una posición: mercado > manual > costo
// OJO: usar Number.isFinite, NO isFinite (isFinite(null)===true).
function priceOf(h,quotes){
  const q = h.ticker ? quotes?.[h.ticker] : null;
  if(q && Number.isFinite(q.price)) return { price:q.price, src:"mercado", percent:q.percent };
  const man = num(h.manual_price);
  if(Number.isFinite(man)) return { price:man, src:"manual" };
  const cost = num(h.avg_cost);
  if(Number.isFinite(cost)) return { price:cost, src:"costo" };
  return { price:null, src:"—" };
}
function perfOf(holds,quotes){
  let value=0, cost=0, executed=false;
  const rows=holds.map(h=>{
    const q=num(h.quantity), c=num(h.avg_cost);
    const { price,src,percent }=priceOf(h,quotes);
    const hasPos = Number.isFinite(q) && q>0 && Number.isFinite(c) && c>0;
    if(hasPos) executed=true;
    const v = (hasPos && Number.isFinite(price)) ? q*price : null;
    const k = hasPos ? q*c : null;
    if(v!=null) value+=v;
    if(k!=null) cost+=k;
    return { ...h, price, src, dayPct:percent, value:v, cost:k,
             pnl: (v!=null&&k!=null)?v-k:null,
             pnlPct: (v!=null&&k>0)?((v/k)-1)*100:null };
  });
  return { rows, value, cost, executed,
           pnl: executed?value-cost:null,
           pnlPct: (executed&&cost>0)?((value/cost)-1)*100:null };
}

/* ============================================================
   CLIENTE · Mi cartera (objetivo + ejecutada con rendimiento)
   ============================================================ */
async function viewPortfolio(){
  const pf=await publishedPortfolio(state.profile.id);
  const m=$("#main");
  m.innerHTML=head("Inversión","Mi cartera");
  if(!pf){
    const ra=await latestAssessment(state.profile.id);
    m.append(el(`<div class="card empty">${icon("pie")}
      <h3 style="margin-top:.4rem">${ra?"Tu cartera está en diseño":"Aún no tienes cartera"}</h3>
      <p>${ra?"Tu asesor la publicará pronto.":"Primero completa tu perfil de riesgo."}</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.6rem"
        onclick="location.hash='${ra?"#/mensajes":"#/riesgo"}'">${ra?"Escribir a mi asesor":"Ir al cuestionario"}</button></div>`));
    return;
  }
  const holds=await sb.from("holdings").select("*").eq("portfolio_id",pf.id).then(r=>r.data||[]);
  await renderPortfolioBody(m,pf,holds,false);
}

async function renderPortfolioBody(m,pf,holds,isAdmin){
  const cur=pf.currency||"USD";
  const tickers=[...new Set(holds.filter(h=>h.ticker && num(h.quantity)>0).map(h=>h.ticker))];
  const qr=await fetchQuotes(tickers);
  const quotes=qr.quotes||{};
  const P=perfOf(holds,quotes);

  $("#headExtra")?.append(el(`<button class="btn btn-ghost btn-sm" onclick="render()">Actualizar precios</button>`));

  // ---- resumen de rendimiento ----
  if(P.executed){
    const cls=sgn(P.pnl);
    m.append(el(`<div class="grid grid-3" style="margin-bottom:1.2rem">
      <div class="stat"><div class="k">Valor actual</div><div class="v">${money(P.value,cur)}</div><div class="d">a precios de mercado</div></div>
      <div class="stat"><div class="k">Capital invertido</div><div class="v">${money(P.cost,cur)}</div><div class="d">base de costo</div></div>
      <div class="stat"><div class="k">Rendimiento global</div><div class="v ${cls}">${pct(P.pnlPct)}</div><div class="d ${cls}">${money(P.pnl,cur)}</div></div>
    </div>`));
  } else {
    m.append(el(`<div class="notice">Cartera <b>objetivo</b>: aún no hay posiciones ejecutadas.
      El rendimiento aparecerá cuando ${isAdmin?"registres":"tu asesor registre"} cantidades y precios de entrada.</div>`));
  }
  if(qr.ok===false && tickers.length){
    m.append(el(`<div class="notice warn">Precios de mercado no disponibles: ${esc(qr.message||qr.error||"error")}
      <br>Se muestran precios manuales o el precio de entrada.</div>`));
  }

  const wrap=el(`<div class="pf-grid"></div>`);
  // composición
  const actual = P.executed ? actualWeights(P.rows,P.value) : null;
  wrap.append(el(`<div class="card">
    <div class="flex between"><h3>${esc(pf.name)}</h3><span class="pill pill-blue mono">${esc(cur)}</span></div>
    <p class="card-sub">${P.executed?"Objetivo vs. real por clase de activo.":"Composición objetivo."}</p>
    <div class="flex" style="gap:1.6rem;align-items:center;flex-wrap:wrap">
      <div style="width:170px">${donut(P.executed?actual:(pf.allocation||{}))}</div>
      <div style="flex:1;min-width:220px">${P.executed?driftBars(pf.allocation||{},actual):allocBars(pf.allocation||{})}</div>
    </div>
    ${pf.notes?`<div class="divide"></div><div class="nav-label" style="padding:0 0 .4rem">Nota de tu asesor</div>
      <p style="color:var(--muted);font-size:.92rem;margin:0">${esc(pf.notes)}</p>`:""}
  </div>`));

  // posiciones
  const side=el(`<div class="card"><div class="flex between"><h3>Posiciones</h3>
    ${qr.ts?`<span class="mono" style="color:var(--faint);font-size:.7rem">${fmtTime(qr.ts)}</span>`:""}</div>
    <p class="card-sub">${holds.length} instrumento(s).</p></div>`);
  if(holds.length){
    const tw=el(`<div class="tbl-wrap"></div>`);
    const t=el(`<table class="tbl"><thead><tr><th>Instrumento</th><th style="text-align:right">Precio</th>
      <th style="text-align:right">${P.executed?"Valor":"Peso"}</th><th style="text-align:right">P&L</th></tr></thead><tbody></tbody></table>`);
    P.rows.forEach(h=>{
      const c=CLASSES[h.asset_class]||{label:h.asset_class,color:"#888"};
      $("tbody",t).append(el(`<tr>
        <td><b>${esc(h.name)}</b>${h.ticker?` <span class="mono" style="color:var(--faint)">${esc(h.ticker)}</span>`:""}
          <br><span class="pill" style="color:${c.color};font-size:.66rem">${c.label}</span></td>
        <td style="text-align:right" class="mono">${h.price!=null?money(h.price,cur):"—"}
          ${h.src==="mercado"&&Number.isFinite(h.dayPct)?`<br><span class="mono ${sgn(h.dayPct)}" style="font-size:.72rem">${pct(h.dayPct)}</span>`
            :`<br><span style="font-size:.66rem;color:var(--faint)">${h.src}</span>`}</td>
        <td style="text-align:right" class="mono">${P.executed&&h.value!=null?money(h.value,cur):(h.target_weight??"—")+(P.executed?"":"%")}</td>
        <td style="text-align:right" class="mono ${sgn(h.pnlPct)}">${h.pnlPct!=null?pct(h.pnlPct):"—"}</td></tr>`));
    });
    tw.append(t); side.append(tw);
  } else side.append(el(`<p class="empty" style="padding:1rem">Aún no hay instrumentos detallados.</p>`));
  wrap.append(side);
  m.append(wrap);
}
function actualWeights(rows,total){
  const a={};
  rows.forEach(h=>{ if(h.value!=null) a[h.asset_class]=(a[h.asset_class]||0)+h.value; });
  Object.keys(a).forEach(k=>a[k]=total>0?Math.round(a[k]/total*1000)/10:0);
  return a;
}
function driftBars(target,actual){
  const keys=[...new Set([...Object.keys(target),...Object.keys(actual)])].filter(k=>CLASSES[k]);
  return keys.map(k=>{
    const t=Number(target[k]||0), a=Number(actual[k]||0), d=a-t;
    return `<div class="alloc-row"><span class="lbl">${CLASSES[k].label}</span>
      <div class="bar" style="position:relative">
        <i style="width:${a}%;background:${CLASSES[k].color}"></i>
        <u style="position:absolute;left:${t}%;top:-3px;bottom:-3px;width:2px;background:#fff;opacity:.65"></u>
      </div>
      <span class="pct">${a.toFixed(1)}%</span>
      <span class="pct ${sgn(d)}" style="width:52px;font-size:.72rem">${d>=0?"+":""}${d.toFixed(1)}</span></div>`;
  }).join("") + `<p class="card-sub" style="margin:.6rem 0 0;font-size:.76rem">La barra blanca marca el objetivo; la cifra gris, la desviación.</p>`;
}
function donut(alloc){
  const entries=Object.entries(alloc).filter(([k,v])=>CLASSES[k]&&v>0);
  const total=entries.reduce((a,[,v])=>a+Number(v),0)||1;
  const R=54,C=2*Math.PI*R; let off=0;
  const segs=entries.map(([k,v])=>{
    const len=C*(v/total);
    const s=`<circle cx="60" cy="60" r="${R}" fill="none" stroke="${CLASSES[k].color}" stroke-width="14"
      stroke-dasharray="${len} ${C-len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"/>`;
    off+=len; return s;
  }).join("");
  return `<svg viewBox="0 0 120 120" width="100%">${segs}
    <text x="60" y="57" text-anchor="middle" fill="var(--text)" font-size="15" font-family="JetBrains Mono">100%</text>
    <text x="60" y="72" text-anchor="middle" fill="var(--faint)" font-size="8" font-family="Inter">cartera</text></svg>`;
}

/* ============================================================
   CLIENTE · Simulador de aportes (determinista + Monte Carlo)
   ============================================================ */
async function viewSimulator(){
  const ra=await latestAssessment(state.profile.id);
  const m=$("#main");
  m.innerHTML=head("Proyección","Simulador de aportes",
    "Proyecta cómo crecería tu inversión con aportes mensuales, usando los supuestos de tu perfil de riesgo.");
  if(!ra){
    m.append(el(`<div class="card empty">${icon("chart")}<p style="margin-top:.4rem">Completa tu perfil de riesgo para calibrar el simulador.</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.6rem" onclick="location.hash='#/riesgo'">Ir al cuestionario</button></div>`));
    return;
  }
  const b=BANDS[ra.final_band];
  const years = ra.target_date ? Math.max(1, Math.round((new Date(ra.target_date)-new Date())/(365.25*864e5))) : 10;
  state.cache.sim = {
    init: num(ra.initial_amount)||1000, monthly: num(ra.monthly_contribution)||100,
    years, mu:b.mu, sigma:b.sigma, cur:ra.currency||"USD", goal:num(ra.target_amount)||0, band:ra.final_band,
  };
  const s=state.cache.sim;
  m.append(el(`<div class="card">
    <div class="flex between" style="flex-wrap:wrap;gap:.6rem">
      <div><h3>Parámetros</h3><p class="card-sub" style="margin:0">Calibrado a tu perfil <b style="color:${cssv(b.cvar)}">${esc(b.label)}</b>.</p></div>
      <div class="tabs"><button class="tab on" data-t="det" onclick="app.simTab('det')">Determinista</button>
        <button class="tab" data-t="mc" onclick="app.simTab('mc')">Monte Carlo</button></div>
    </div>
    <div class="flex mt" style="gap:.8rem;flex-wrap:wrap">
      ${simField("init","Monto inicial",s.init,s.cur)}
      ${simField("monthly","Aporte mensual",s.monthly,s.cur)}
      ${simField("years","Años",s.years,"")}
    </div>
    <div class="flex" style="gap:.8rem;flex-wrap:wrap">
      ${simSlider("mu","Retorno esperado anual",(s.mu*100).toFixed(1),0,15,.5,"%")}
      ${simSlider("sigma","Volatilidad anual",(s.sigma*100).toFixed(1),1,35,.5,"%")}
    </div>
    <div id="simOut" class="mt2"></div>
    <p class="card-sub" style="margin-top:1rem;font-size:.78rem">Los supuestos de retorno y volatilidad son referenciales, no una promesa. Rentabilidades pasadas no garantizan resultados futuros.</p>
  </div>`));
  app.simTab("det");
}
const simField=(id,label,val,cur)=>`<div class="field" style="flex:1;min-width:130px"><label>${label}${cur?` (${cur})`:""}</label>
  <input id="s_${id}" class="input mono" type="number" value="${val}" oninput="app.simRun()"></div>`;
const simSlider=(id,label,val,min,max,step,suf)=>`<div class="field" style="flex:1;min-width:200px">
  <label>${label} · <span class="mono" id="o_${id}">${val}${suf}</span></label>
  <input id="s_${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}"
    oninput="document.getElementById('o_${id}').textContent=this.value+'${suf}';app.simRun()" style="width:100%"></div>`;

function simParams(){
  const g=(id)=>parseFloat(document.getElementById("s_"+id).value);
  return { init:g("init"), monthly:g("monthly"), years:Math.max(1,Math.round(g("years"))),
           mu:g("mu")/100, sigma:g("sigma")/100, cur:state.cache.sim.cur, goal:state.cache.sim.goal };
}
// Determinista: capitalización mensual con aportes al final de cada mes
function projDeterministic(p){
  const r=p.mu/12, N=p.years*12, pts=[{y:0,v:p.init,c:p.init}];
  let v=p.init, c=p.init;
  for(let m=1;m<=N;m++){ v=v*(1+r)+p.monthly; c+=p.monthly;
    if(m%12===0) pts.push({y:m/12,v,c}); }
  return pts;
}
// Monte Carlo: GBM mensual + aportes
function projMonteCarlo(p,paths=1000){
  const N=p.years*12, dt=1/12;
  const drift=(p.mu-p.sigma*p.sigma/2)*dt, vol=p.sigma*Math.sqrt(dt);
  const snaps=Array.from({length:p.years+1},()=>[]);
  const finals=[];
  for(let i=0;i<paths;i++){
    let v=p.init; snaps[0].push(v);
    for(let m=1;m<=N;m++){
      const z=gauss();
      v=v*Math.exp(drift+vol*z)+p.monthly;
      if(m%12===0) snaps[m/12].push(v);
    }
    finals.push(v);
  }
  const q=(arr,pp)=>{ const a=[...arr].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.floor(pp*a.length))]; };
  const bands=snaps.map((s,y)=>({ y, p10:q(s,.10), p25:q(s,.25), p50:q(s,.50), p75:q(s,.75), p90:q(s,.90) }));
  const contributed=p.init+p.monthly*N;
  const probGoal = p.goal>0 ? finals.filter(v=>v>=p.goal).length/paths : null;
  return { bands, finals, contributed, probGoal };
}
let _spare=null;
function gauss(){ // Box-Muller
  if(_spare!=null){ const s=_spare; _spare=null; return s; }
  let u,v,s2; do{ u=Math.random()*2-1; v=Math.random()*2-1; s2=u*u+v*v; }while(s2>=1||s2===0);
  const f=Math.sqrt(-2*Math.log(s2)/s2); _spare=v*f; return u*f;
}

function simRenderDet(p){
  const pts=projDeterministic(p), last=pts[pts.length-1];
  const gain=last.v-last.c;
  const box=$("#simOut");
  box.innerHTML=`<div class="grid grid-3" style="margin-bottom:1rem">
    <div class="stat"><div class="k">Valor final</div><div class="v">${money(last.v,p.cur)}</div><div class="d">en ${p.years} año(s)</div></div>
    <div class="stat"><div class="k">Total aportado</div><div class="v">${money(last.c,p.cur)}</div><div class="d">inicial + aportes</div></div>
    <div class="stat"><div class="k">Interés generado</div><div class="v pos">${money(gain,p.cur)}</div><div class="d">${pct(last.c>0?(gain/last.c)*100:0)} sobre lo aportado</div></div>
  </div><div class="chart">${lineChart(pts,p)}</div>`;
}
function simRenderMC(p){
  const r=projMonteCarlo(p);
  const last=r.bands[r.bands.length-1];
  const box=$("#simOut");
  box.innerHTML=`<div class="grid grid-3" style="margin-bottom:1rem">
    <div class="stat"><div class="k">Escenario medio (p50)</div><div class="v">${money(last.p50,p.cur)}</div><div class="d">mediana de 1 000 trayectorias</div></div>
    <div class="stat"><div class="k">Rango probable</div><div class="v" style="font-size:1.05rem">${money(last.p10,p.cur)} – ${money(last.p90,p.cur)}</div><div class="d">80% de los escenarios</div></div>
    <div class="stat"><div class="k">${p.goal>0?"Probabilidad de meta":"Total aportado"}</div>
      <div class="v ${p.goal>0?(r.probGoal>=.5?"pos":"neg"):""}">${p.goal>0?(r.probGoal*100).toFixed(0)+"%":money(r.contributed,p.cur)}</div>
      <div class="d">${p.goal>0?"alcanzar "+money(p.goal,p.cur):"inicial + aportes"}</div></div>
  </div><div class="chart">${fanChart(r.bands,p)}</div>
  <div class="legend"><span><i style="background:var(--blue-500);opacity:.18"></i>p10–p90</span>
    <span><i style="background:var(--blue-500);opacity:.35"></i>p25–p75</span>
    <span><i style="background:var(--blue-300)"></i>mediana</span>
    ${p.goal>0?`<span><i style="background:var(--warn)"></i>meta</span>`:""}</div>`;
}
// --- gráficos SVG ---
function chartScale(pts,p,maxV){
  const W=680,H=280,PL=64,PR=14,PT=14,PB=30;
  const x=(y)=>PL+(y/p.years)*(W-PL-PR);
  const yv=(v)=>PT+(1-v/maxV)*(H-PT-PB);
  return {W,H,PL,PR,PT,PB,x,yv};
}
function axes(s,p,maxV,cur){
  const ticks=4, out=[];
  for(let i=0;i<=ticks;i++){
    const v=maxV*i/ticks, y=s.yv(v);
    out.push(`<line x1="${s.PL}" y1="${y}" x2="${s.W-s.PR}" y2="${y}" stroke="var(--line)" stroke-width=".8"/>
      <text x="${s.PL-8}" y="${y+3.5}" text-anchor="end" fill="var(--faint)" font-size="9" font-family="JetBrains Mono">${compact(v)}</text>`);
  }
  const step=Math.max(1,Math.round(p.years/6));
  for(let y=0;y<=p.years;y+=step)
    out.push(`<text x="${s.x(y)}" y="${s.H-10}" text-anchor="middle" fill="var(--faint)" font-size="9" font-family="Inter">${y}a</text>`);
  return out.join("");
}
const compact=(v)=>v>=1e6?(v/1e6).toFixed(1)+"M":v>=1e3?(v/1e3).toFixed(0)+"k":v.toFixed(0);
function lineChart(pts,p){
  const maxV=Math.max(...pts.map(o=>o.v))*1.08||1;
  const s=chartScale(pts,p,maxV);
  const path=(key)=>pts.map((o,i)=>`${i?"L":"M"}${s.x(o.y)},${s.yv(o[key])}`).join("");
  return `<svg viewBox="0 0 ${s.W} ${s.H}" width="100%">${axes(s,p,maxV,p.cur)}
    <path d="${path("v")}L${s.x(p.years)},${s.yv(0)}L${s.PL},${s.yv(0)}Z" fill="var(--blue-500)" opacity=".12"/>
    <path d="${path("c")}" fill="none" stroke="var(--faint)" stroke-width="1.6" stroke-dasharray="4 3"/>
    <path d="${path("v")}" fill="none" stroke="var(--blue-400)" stroke-width="2.2"/>
    <text x="${s.W-s.PR}" y="${s.yv(pts[pts.length-1].v)-6}" text-anchor="end" fill="var(--blue-300)" font-size="10" font-family="JetBrains Mono">valor</text>
    <text x="${s.W-s.PR}" y="${s.yv(pts[pts.length-1].c)+13}" text-anchor="end" fill="var(--faint)" font-size="10" font-family="JetBrains Mono">aportado</text></svg>`;
}
function fanChart(bands,p){
  const maxV=Math.max(...bands.map(b=>b.p90))*1.06||1;
  const s=chartScale(bands,p,maxV);
  const area=(lo,hi)=>bands.map((b,i)=>`${i?"L":"M"}${s.x(b.y)},${s.yv(b[hi])}`).join("")+
    bands.slice().reverse().map(b=>`L${s.x(b.y)},${s.yv(b[lo])}`).join("")+"Z";
  const line=(k)=>bands.map((b,i)=>`${i?"L":"M"}${s.x(b.y)},${s.yv(b[k])}`).join("");
  const goalLine = p.goal>0 && p.goal<maxV
    ? `<line x1="${s.PL}" y1="${s.yv(p.goal)}" x2="${s.W-s.PR}" y2="${s.yv(p.goal)}" stroke="var(--warn)" stroke-width="1.4" stroke-dasharray="5 4"/>
       <text x="${s.PL+6}" y="${s.yv(p.goal)-5}" fill="var(--warn)" font-size="9" font-family="JetBrains Mono">meta ${compact(p.goal)}</text>` : "";
  return `<svg viewBox="0 0 ${s.W} ${s.H}" width="100%">${axes(s,p,maxV,p.cur)}
    <path d="${area("p10","p90")}" fill="var(--blue-500)" opacity=".18"/>
    <path d="${area("p25","p75")}" fill="var(--blue-500)" opacity=".35"/>
    <path d="${line("p50")}" fill="none" stroke="var(--blue-300)" stroke-width="2.2"/>
    ${goalLine}</svg>`;
}

/* ============================================================
   CLIENTE · Mercado e ideas
   ============================================================ */
async function viewFeed(){
  const posts=await sb.from("posts").select("*").eq("published",true).order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Research","Mercado e ideas","Noticias relevantes e ideas de inversión publicadas por InveXia.");
  if(!posts.length){ m.append(el(`<div class="card empty">${icon("news")}<p style="margin-top:.4rem">Aún no hay publicaciones.</p></div>`)); return; }
  const ideas=posts.filter(p=>p.kind==="idea"), news=posts.filter(p=>p.kind==="noticia");
  if(ideas.length){
    m.append(el(`<div class="nav-label" style="padding-left:0">Ideas de inversión</div>`));
    const g=el(`<div class="grid grid-2" style="margin-bottom:1.6rem"></div>`);
    ideas.forEach(p=>g.append(ideaCard(p))); m.append(g);
  }
  if(news.length){
    m.append(el(`<div class="nav-label" style="padding-left:0">Noticias del mercado</div>`));
    news.forEach(p=>m.append(newsCard(p)));
  }
}
function ideaCard(p){
  const dirColor={compra:"var(--ok)",venta:"var(--bad)",mantener:"var(--warn)"}[p.direction]||"var(--muted)";
  return el(`<div class="card idea">
    <div class="flex between">
      <div class="flex" style="gap:.5rem">
        <span class="mono ticker">${esc(p.ticker||"—")}</span>
        <span class="pill" style="color:${dirColor};text-transform:capitalize">${esc(p.direction||"idea")}</span>
      </div>
      <span class="pill ${p.status==="abierta"?"pill-ok":""} dot" style="${p.status!=="abierta"?"color:var(--faint)":""}">${esc(p.status||"abierta")}</span>
    </div>
    <h3 style="margin:.7rem 0 .3rem">${esc(p.title)}</h3>
    <p class="card-sub" style="margin-bottom:.8rem">${esc(p.body||"")}</p>
    <div class="flex" style="gap:1.4rem;font-size:.82rem">
      ${p.target_price?`<div><div class="k-mini">Precio objetivo</div><b class="mono">${money(p.target_price,"USD")}</b></div>`:""}
      ${p.horizon?`<div><div class="k-mini">Horizonte</div><b>${esc(p.horizon)}</b></div>`:""}
      <div><div class="k-mini">Publicada</div><b class="mono">${fmtDate(p.created_at)}</b></div>
    </div>
    ${p.source_url?`<a class="btn btn-ghost btn-sm mt" href="${esc(p.source_url)}" target="_blank" rel="noopener">Ver fuente</a>`:""}
  </div>`);
}
function newsCard(p){
  return el(`<div class="list-item" style="align-items:flex-start">
    <div class="li-main"><b>${esc(p.title)}</b>
      <span style="display:block;margin-top:.25rem">${esc(p.body||"")}</span>
      ${p.source_url?`<a href="${esc(p.source_url)}" target="_blank" rel="noopener" style="font-size:.82rem">Leer fuente →</a>`:""}</div>
    <span class="mono" style="color:var(--faint);font-size:.75rem;white-space:nowrap">${fmtDate(p.created_at)}</span></div>`);
}

/* ============================================================
   CLIENTE · Cursos / Calendario / Mensajes
   ============================================================ */
async function viewCoursesClient(){
  const cs=await sb.from("courses").select("*").eq("published",true).order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Formación","Cursos","Contenido publicado por InveXia.");
  if(!cs.length){ m.append(el(`<div class="card empty">${icon("book")}<p style="margin-top:.4rem">Aún no hay cursos publicados.</p></div>`)); return; }
  const g=el(`<div class="grid grid-3"></div>`);
  cs.forEach(c=>g.append(el(`<div class="card"><span class="pill pill-blue">${esc(c.level||"Curso")}</span>
    <h3 style="margin:.6rem 0 .3rem">${esc(c.title)}</h3><p class="card-sub">${esc(c.description||"")}</p>
    ${c.url?`<a class="btn btn-ghost btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener">Abrir curso</a>`:""}</div>`)));
  m.append(g);
}
async function viewCalendarClient(){
  const ev=await sb.from("events").select("*").order("event_date",{ascending:true}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Agenda","Calendario","Próximos eventos y fechas clave.");
  m.append(eventList(ev,false));
}
async function viewClientMessages(){
  const m=$("#main"); m.innerHTML=head("Contacto","Mensajes","Conversa directamente con tu asesor.");
  m.append(el(`<div class="card"><div id="chat" class="chat"></div>
    <div class="composer"><input id="msgIn" class="input" placeholder="Escribe un mensaje…" onkeydown="if(event.key==='Enter')app.sendMsg('${state.profile.id}')">
    <button class="btn btn-primary" style="width:auto" onclick="app.sendMsg('${state.profile.id}')">Enviar</button></div></div>`));
  await loadThread(state.profile.id);
}

/* ============================================================
   ADMIN · Clientes
   ============================================================ */
async function viewAdminClients(){
  const m=$("#main");
  const clients=await sb.from("profiles").select("*").eq("role","client").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const ras=await sb.from("risk_assessments").select("user_id,final_band,band_label,goal_type,monthly_contribution,currency,created_at").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const pfs=await sb.from("portfolios").select("user_id,status").then(r=>r.data||[]);
  const raBy={},pfBy={};
  ras.forEach(r=>{ if(!raBy[r.user_id]) raBy[r.user_id]=r; });
  pfs.forEach(p=>{ if(pfBy[p.user_id]!=="published") pfBy[p.user_id]=p.status; });

  m.innerHTML=head("Administración","Clientes",`${clients.length} registrado(s).`);
  const aum=ras.reduce((a,r)=>a+(num(r.monthly_contribution)||0),0);
  m.append(el(`<div class="grid grid-3" style="margin-bottom:1.4rem">
    ${stat("Clientes",clients.length,"registrados")}
    ${stat("Con perfil",Object.keys(raBy).length,"cuestionario completo")}
    ${stat("Aportes mensuales",money(aum,"USD"),"comprometidos")}
  </div>`));
  if(!clients.length){ m.append(el(`<div class="card empty">${icon("users")}<p style="margin-top:.4rem">Aún no hay clientes registrados.</p></div>`)); return; }
  const card=el(`<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr>
    <th>Cliente</th><th>Objetivo</th><th>Perfil</th><th>Cartera</th><th>Contacto</th></tr></thead><tbody></tbody></table></div></div>`);
  clients.forEach(c=>{
    const ra=raBy[c.id], st=pfBy[c.id];
    const band=ra?`<span class="mono" style="color:${cssv(BANDS[ra.final_band].cvar)}">●</span> ${esc(ra.band_label)}`:`<span style="color:var(--faint)">Pendiente</span>`;
    const pill=st==="published"?`<span class="pill pill-ok dot">Publicada</span>`
             :st==="draft"?`<span class="pill pill-warn dot">Borrador</span>`
             :`<span class="pill dot" style="color:var(--faint)">Sin cartera</span>`;
    const wa=c.phone?`<a href="https://wa.me/${esc(c.phone.replace(/[^0-9]/g,""))}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="pill pill-ok">WhatsApp</a>`:"";
    const tr=el(`<tr class="row-click">
      <td><div class="flex"><div class="avatar" style="width:30px;height:30px">${initials(c.full_name)}</div>
        <div><b>${esc(c.full_name||"—")}</b><br><span class="mono" style="color:var(--faint);font-size:.76rem">${esc(c.email||"")}</span></div></div></td>
      <td>${ra?.goal_type?esc(ra.goal_type==="otro"?"Otro":GOALS[ra.goal_type]):"—"}</td>
      <td>${band}</td><td>${pill}</td>
      <td><div class="flex">${wa}<span class="mono" style="color:var(--faint);font-size:.76rem">${esc(c.phone||"sin celular")}</span></div></td></tr>`);
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
  const pf=await anyPortfolio(uid);
  const holds= pf ? await sb.from("holdings").select("*").eq("portfolio_id",pf.id).then(r=>r.data||[]) : [];

  m.innerHTML=head("Cliente","x","");
  const ph=$(".page-head > div:first-child");
  ph.innerHTML=`<div class="eyebrow">Cliente</div><h1>${esc(client.full_name||client.email)}</h1>
    <p><span class="mono">${esc(client.email||"")}</span>${client.phone?` · <span class="mono">${esc(client.phone)}</span>`:""}</p>`;
  $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/clientes'">← Clientes</button>`));

  const grid=el(`<div class="quad-wrap"></div>`);
  if(ra){
    const cur=ra.currency||"USD";
    const goal=ra.goal_type?(ra.goal_type==="otro"?(ra.goal_other||"Otro"):GOALS[ra.goal_type]):null;
    grid.append(el(`<div class="card"><h3>Perfil de riesgo</h3>
      <div class="band-chip mono" style="color:${cssv(BANDS[ra.final_band].cvar)};margin:.6rem 0 1rem">Nivel ${ra.final_band} · ${esc(ra.band_label)}</div>
      ${goal?`<div class="kv"><span>Objetivo</span><b>${esc(goal)}</b></div>`:""}
      ${ra.target_amount?`<div class="kv"><span>Monto meta</span><b class="mono">${money(ra.target_amount,cur)}</b></div>`:""}
      ${ra.target_date?`<div class="kv"><span>Fecha meta</span><b class="mono">${fmtDate(ra.target_date)}</b></div>`:""}
      ${ra.initial_amount?`<div class="kv"><span>Monto inicial</span><b class="mono">${money(ra.initial_amount,cur)}</b></div>`:""}
      ${ra.monthly_contribution?`<div class="kv"><span>Aporte mensual</span><b class="mono">${money(ra.monthly_contribution,cur)}</b></div>`:""}
      <div class="divide"></div>
      <div class="grid">${axisRow("Disposición",ra.willingness_band)}${axisRow("Capacidad",ra.capacity_band)}${axisRow("Horizonte",ra.horizon_band)}</div>
      <div class="divide"></div><div class="quad">${quadrant(ra)}</div></div>`));
  } else {
    grid.append(el(`<div class="card empty">${icon("gauge")}<p style="margin-top:.4rem">Este cliente aún no completó su perfil de riesgo.</p></div>`));
  }

  const sugg = ra?BANDS[ra.final_band].alloc:{cash:10,fixed_income:40,equity:45,crypto:5};
  const a = pf?.allocation && Object.keys(pf.allocation).length ? pf.allocation : sugg;
  grid.append(el(`<div class="card">
    <div class="flex between"><h3>Cartera</h3>${pf?`<span class="pill dot ${pf.status==='published'?'pill-ok':'pill-warn'}">${pf.status==='published'?'Publicada':'Borrador'}</span>`:""}</div>
    <p class="card-sub">Asignación objetivo por clase (suma 100%). Las cantidades y precios de entrada son opcionales: regístralos cuando el cliente invierta de verdad.</p>
    <div class="field"><label>Nombre de la cartera</label><input id="pfName" class="input" value="${esc(pf?.name||'Cartera principal')}"></div>
    <div class="field" style="max-width:160px"><label>Moneda</label>
      <select id="pfCur" class="input"><option ${pf?.currency==='USD'?'selected':''}>USD</option><option ${pf?.currency==='USDT'?'selected':''}>USDT</option><option ${pf?.currency==='BOB'?'selected':''}>BOB</option></select></div>
    <div id="allocEditor"></div>
    <div id="allocSum" class="flex between" style="font-size:.85rem;color:var(--muted);margin:.4rem 0 1rem"></div>
    <div class="field"><label>Nota para el cliente</label><textarea id="pfNotes" class="input" placeholder="Racional de la cartera…">${esc(pf?.notes||'')}</textarea></div>
    <div class="divide"></div>
    <div class="flex between"><div class="nav-label" style="padding:0">Posiciones</div>
      <button class="btn btn-ghost btn-sm" onclick="app.addHolding()">+ Añadir instrumento</button></div>
    <div id="holdList" class="mt"></div>
    <div class="flex mt2"><button class="btn btn-ghost btn-sm" onclick="app.savePortfolio('${uid}','draft')">Guardar borrador</button>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.savePortfolio('${uid}','published')">Publicar para el cliente</button></div>
  </div>`));
  m.append(grid);

  // vista previa de rendimiento (lo que verá el cliente)
  if(pf && holds.some(h=>num(h.quantity)>0)){
    const prev=el(`<div class="mt2"><div class="nav-label" style="padding-left:0">Vista previa del rendimiento</div></div>`);
    m.append(prev);
    await renderPortfolioBody(m,pf,holds,true);
  }

  state.cache.edit={ uid, pf, alloc:{...a}, holds:holds.map(h=>({...h})) };
  renderAllocEditor(); renderHoldList();
}
function renderAllocEditor(){
  const e=state.cache.edit, box=$("#allocEditor"); if(!box) return; box.innerHTML="";
  ["cash","fixed_income","equity","crypto","alt"].forEach(k=>{
    if(e.alloc[k]===undefined && k==="alt") return;
    const c=CLASSES[k], v=e.alloc[k]??0;
    const row=el(`<div class="alloc-row"><span class="lbl" style="color:${c.color}">${c.label}</span>
      <input type="range" min="0" max="100" value="${v}" style="flex:1" data-k="${k}">
      <span class="pct" data-out="${k}">${v}%</span></div>`);
    $("input",row).oninput=(ev)=>{ e.alloc[k]=Number(ev.target.value);
      $(`[data-out="${k}"]`).textContent=e.alloc[k]+"%"; allocSum(); };
    box.append(row);
  });
  if(e.alloc.alt===undefined) box.append(el(`<button class="btn btn-ghost btn-sm" onclick="app.addAlt()">+ Alternativos</button>`));
  allocSum();
}
function allocSum(){
  const s=Object.values(state.cache.edit.alloc).reduce((a,b)=>a+Number(b||0),0);
  const box=$("#allocSum"); if(box) box.innerHTML=`<span>Suma objetivo</span><span class="mono" style="color:${s===100?'var(--ok)':'var(--warn)'}">${s}%</span>`;
}
function renderHoldList(){
  const e=state.cache.edit, box=$("#holdList"); if(!box) return; box.innerHTML="";
  if(!e.holds.length){ box.append(el(`<p class="card-sub" style="margin:0">Sin posiciones. Añade ETFs, acciones, bonos, DPF o cripto.</p>`)); return; }
  e.holds.forEach((h,i)=>{
    const row=el(`<div class="hold">
      <div class="hold-r1">
        <input class="input" placeholder="Nombre del instrumento" value="${esc(h.name||'')}" data-f="name" data-i="${i}">
        <input class="input mono" placeholder="Ticker (VOO, BTC/USD)" value="${esc(h.ticker||'')}" data-f="ticker" data-i="${i}">
        <select class="input" data-f="asset_class" data-i="${i}">
          ${Object.entries(CLASSES).map(([k,c])=>`<option value="${k}" ${h.asset_class===k?'selected':''}>${c.label}</option>`).join("")}</select>
        <input class="input mono" type="number" placeholder="% obj." value="${h.target_weight??''}" data-f="target_weight" data-i="${i}">
        <button class="btn btn-ghost btn-sm" data-del="${i}">✕</button>
      </div>
      <div class="hold-r2">
        <label>Cantidad<input class="input mono" type="number" step="any" placeholder="opcional" value="${h.quantity??''}" data-f="quantity" data-i="${i}"></label>
        <label>Precio de entrada<input class="input mono" type="number" step="any" placeholder="opcional" value="${h.avg_cost??''}" data-f="avg_cost" data-i="${i}"></label>
        <label>Fecha de compra<input class="input" type="date" value="${h.purchase_date??''}" data-f="purchase_date" data-i="${i}"></label>
        <label>Precio manual<input class="input mono" type="number" step="any" placeholder="sin ticker" value="${h.manual_price??''}" data-f="manual_price" data-i="${i}"></label>
      </div></div>`);
    box.append(row);
  });
  box.querySelectorAll("[data-f]").forEach(inp=>inp.oninput=(ev)=>{
    const i=+ev.target.dataset.i, f=ev.target.dataset.f;
    e.holds[i][f]= ev.target.value===""?null:ev.target.value; });
  box.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{ e.holds.splice(+b.dataset.del,1); renderHoldList(); });
}

/* ============================================================
   ADMIN · Publicaciones (noticias e ideas)
   ============================================================ */
async function viewPostsAdmin(){
  const posts=await sb.from("posts").select("*").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Research","Noticias e ideas","Publica análisis de mercado e ideas de inversión.");
  $("#headExtra").append(el(`<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.postForm()">+ Nueva publicación</button>`));
  m.append(el(`<div id="postForm"></div>`));
  if(!posts.length){ m.append(el(`<div class="card empty">${icon("news")}<p style="margin-top:.4rem">Aún no has publicado nada.</p></div>`)); return; }
  const list=el(`<div class="mt"></div>`);
  posts.forEach(p=>list.append(el(`<div class="list-item">
    <div class="li-main"><div class="flex" style="gap:.5rem">
      <span class="pill ${p.kind==='idea'?'pill-blue':''}" style="${p.kind!=='idea'?'color:var(--faint)':''}">${p.kind==="idea"?"Idea":"Noticia"}</span>
      ${p.ticker?`<span class="mono ticker" style="font-size:.8rem">${esc(p.ticker)}</span>`:""}</div>
      <b style="margin-top:.3rem">${esc(p.title)}</b>
      <span>${p.published?"Publicada":"Borrador"} · ${fmtDate(p.created_at)}</span></div>
    <div class="flex">
      <button class="btn btn-ghost btn-sm" onclick="app.togglePost('${p.id}',${!p.published})">${p.published?"Ocultar":"Publicar"}</button>
      ${p.kind==="idea"?`<button class="btn btn-ghost btn-sm" onclick="app.closeIdea('${p.id}','${p.status==="abierta"?"cerrada":"abierta"}')">${p.status==="abierta"?"Cerrar idea":"Reabrir"}</button>`:""}
      <button class="btn btn-ghost btn-sm" onclick="app.delPost('${p.id}')">Eliminar</button></div></div>`)));
  m.append(list);
}

/* ============================================================
   ADMIN · Cursos / Calendario / Inbox
   ============================================================ */
async function viewCoursesAdmin(){
  const cs=await sb.from("courses").select("*").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const m=$("#main"); m.innerHTML=head("Contenido","Cursos","Crea y publica material para tus clientes.");
  $("#headExtra").append(el(`<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.courseForm()">+ Nuevo curso</button>`));
  m.append(el(`<div id="courseForm"></div>`));
  if(!cs.length){ m.append(el(`<div class="card empty">${icon("book")}<p style="margin-top:.4rem">Aún no has creado cursos.</p></div>`)); return; }
  const list=el(`<div class="mt"></div>`);
  cs.forEach(c=>list.append(el(`<div class="list-item">
    <div class="li-main"><b>${esc(c.title)}</b><span>${esc(c.level||"")} · ${c.published?"Publicado":"Borrador"}</span></div>
    <div class="flex"><button class="btn btn-ghost btn-sm" onclick="app.togglePub('${c.id}',${!c.published})">${c.published?"Ocultar":"Publicar"}</button>
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
  if(state.param) return void await adminThread(state.param,pmap[state.param]);
  const list=el(`<div></div>`);
  ids.forEach(id=>{
    const last=msgs.find(x=>x.client_id===id), p=pmap[id]||{};
    const unread=msgs.some(x=>x.client_id===id&&x.sender_role==="client"&&!x.read);
    const it=el(`<div class="list-item row-click">
      <div class="flex"><div class="avatar">${initials(p.full_name)}</div>
        <div class="li-main"><b>${esc(p.full_name||p.email||"Cliente")}</b><span>${esc((last?.body||"").slice(0,60))}</span></div></div>
      <div class="flex">${unread?'<span class="pill pill-blue dot">Nuevo</span>':''}
        <span class="mono" style="color:var(--faint);font-size:.75rem">${fmtTime(last.created_at)}</span></div></div>`);
    it.onclick=()=>location.hash="#/mensajes/"+id; list.append(it);
  });
  m.append(list);
}
async function adminThread(uid,prof){
  const m=$("#main");
  $("#headExtra").innerHTML="";
  $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/mensajes'">← Bandeja</button>`));
  $(".page-head h1").textContent=prof?.full_name||prof?.email||"Cliente";
  m.append(el(`<div class="card"><div id="chat" class="chat"></div>
    <div class="composer"><input id="msgIn" class="input" placeholder="Responder…" onkeydown="if(event.key==='Enter')app.sendMsg('${uid}')">
    <button class="btn btn-primary" style="width:auto" onclick="app.sendMsg('${uid}')">Enviar</button></div></div>`));
  await loadThread(uid);
  await sb.from("messages").update({read:true}).eq("client_id",uid).eq("sender_role","client").eq("read",false);
}

/* ============================================================
   Compartidos
   ============================================================ */
async function loadThread(clientId){
  const box=$("#chat"); if(!box) return;
  const msgs=await sb.from("messages").select("*").eq("client_id",clientId).order("created_at",{ascending:true}).then(r=>r.data||[]);
  box.innerHTML="";
  if(!msgs.length) box.append(el(`<div class="empty" style="padding:1.4rem">Aún no hay mensajes. Escribe el primero.</div>`));
  msgs.forEach(x=>box.append(el(`<div class="bubble ${x.sender_role===state.profile.role?"me":"them"}">${esc(x.body)}<span class="t">${fmtTime(x.created_at)}</span></div>`)));
  box.scrollTop=box.scrollHeight;
}
function eventList(ev,admin){
  if(!ev.length) return el(`<div class="card empty">${icon("cal")}<p style="margin-top:.4rem">No hay eventos programados.</p></div>`);
  const box=el(`<div class="mt"></div>`);
  ev.forEach(e=>{
    const d=new Date(e.event_date+"T12:00:00");
    box.append(el(`<div class="list-item">
      <div class="flex"><div class="avatar" style="flex-direction:column;line-height:1">
        <span class="mono" style="font-size:.9rem;color:var(--blue-300)">${d.getDate()}</span>
        <span style="font-size:.6rem;color:var(--faint);text-transform:uppercase">${d.toLocaleDateString("es-BO",{month:"short"})}</span></div>
        <div class="li-main"><b>${esc(e.title)}</b><span>${esc(e.description||"")}</span></div></div>
      ${admin?`<button class="btn btn-ghost btn-sm" onclick="app.delEvent('${e.id}')">Eliminar</button>`
             :`<span class="pill pill-blue">${fmtDate(e.event_date)}</span>`}</div>`));
  });
  return box;
}

/* ============================================================
   Acciones
   ============================================================ */
const app = {
  retake(){ state.cache.retake=true; render(); },
  goalTypeChange(){ $("#gOtherWrap").classList.toggle("hidden", $("#gType").value!=="otro"); },

  async savePhone(){
    const phone=$("#phIn").value.trim();
    const {error}=await sb.from("profiles").update({phone}).eq("id",state.profile.id);
    if(error) return ui.toast(error.message,"err");
    state.profile.phone=phone; ui.toast("Celular guardado","ok");
  },

  async saveProfiler(){
    const p=computeProfile(state.answers);
    const gType=$("#gType").value||null;
    const row={ user_id:state.profile.id, answers:state.answers, ...p,
      goal_type:gType, goal_other:gType==="otro"?($("#gOther").value.trim()||null):null,
      target_amount:num($("#gTarget").value), target_date:$("#gDate").value||null,
      initial_amount:num($("#gInit").value), monthly_contribution:num($("#gMonthly").value),
      currency:$("#gCur").value };
    const { data,error }=await sb.from("risk_assessments").insert(row).select().single();
    if(error) return ui.toast("No se pudo guardar: "+error.message,"err");
    state.cache.retake=false; state.cache.lastRa=data;
    const m=$("#main"); m.innerHTML=head("Perfil de inversor","Tu perfil de riesgo","Guardado el "+fmtDate(new Date())+".");
    m.append(renderResult(data));
    ui.toast("Perfil calculado y guardado","ok");
  },
  exportPDF(){ window.print(); },
  exportJSON(){
    const data=state.cache.lastRa||{answers:state.answers,...computeProfile(state.answers)};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download="perfil-invexia.json"; a.click();
  },

  // simulador
  simTab(t){
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("on",b.dataset.t===t));
    state.cache.simTab=t; app.simRun();
  },
  simRun(){
    const p=simParams();
    if(state.cache.simTab==="mc") simRenderMC(p); else simRenderDet(p);
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
    const hs=e.holds.filter(h=>h.name).map(h=>({ portfolio_id:pfId, name:h.name, ticker:h.ticker||null,
      asset_class:h.asset_class, target_weight:num(h.target_weight), quantity:num(h.quantity),
      avg_cost:num(h.avg_cost), purchase_date:h.purchase_date||null, manual_price:num(h.manual_price) }));
    if(hs.length){ const {error}=await sb.from("holdings").insert(hs); if(error) return ui.toast(error.message,"err"); }
    ui.toast(status==="published"?"Cartera publicada para el cliente":"Borrador guardado","ok");
    render();
  },

  // mensajes
  async sendMsg(clientId){
    const inp=$("#msgIn"), body=inp.value.trim(); if(!body) return;
    inp.value="";
    const {error}=await sb.from("messages").insert({ client_id:clientId, sender_id:state.profile.id,
      sender_role:state.profile.role, body });
    if(error) return ui.toast(error.message,"err");
    await loadThread(clientId);
  },

  // publicaciones
  postForm(){
    const box=$("#postForm"); if(box.dataset.open){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    box.innerHTML=`<div class="card">
      <div class="field" style="max-width:200px"><label>Tipo</label>
        <select id="pKind" class="input" onchange="app.postKindChange()"><option value="noticia">Noticia</option><option value="idea">Idea de inversión</option></select></div>
      <div class="field"><label>Título</label><input id="pTitle" class="input"></div>
      <div class="field"><label>Contenido / tesis</label><textarea id="pBody" class="input"></textarea></div>
      <div class="field"><label>Enlace a la fuente (opcional)</label><input id="pUrl" class="input" placeholder="https://…"></div>
      <div id="ideaFields" class="hidden">
        <div class="divide"></div>
        <div class="flex" style="gap:.8rem;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:110px"><label>Ticker</label><input id="pTicker" class="input mono" placeholder="AAPL"></div>
          <div class="field" style="flex:1;min-width:120px"><label>Dirección</label>
            <select id="pDir" class="input"><option value="compra">Compra</option><option value="venta">Venta</option><option value="mantener">Mantener</option></select></div>
          <div class="field" style="flex:1;min-width:120px"><label>Precio objetivo</label><input id="pTarget" class="input mono" type="number" step="any"></div>
          <div class="field" style="flex:1;min-width:120px"><label>Horizonte</label><input id="pHor" class="input" placeholder="6–12 meses"></div>
        </div></div>
      <div class="flex mt"><label class="flex" style="gap:.4rem;color:var(--muted);font-size:.85rem"><input type="checkbox" id="pPub" checked> Publicar de inmediato</label>
        <button class="btn btn-primary btn-sm" style="width:auto;margin-left:auto" onclick="app.savePost()">Guardar publicación</button></div></div>`;
  },
  postKindChange(){ $("#ideaFields").classList.toggle("hidden", $("#pKind").value!=="idea"); },
  async savePost(){
    const t=$("#pTitle").value.trim(); if(!t) return ui.toast("Ponle un título","err");
    const kind=$("#pKind").value;
    const row={ kind, title:t, body:$("#pBody").value.trim(), source_url:$("#pUrl").value.trim()||null,
      published:$("#pPub").checked, created_by:state.profile.id };
    if(kind==="idea"){
      row.ticker=$("#pTicker").value.trim().toUpperCase()||null;
      row.direction=$("#pDir").value; row.target_price=num($("#pTarget").value);
      row.horizon=$("#pHor").value.trim()||null; row.status="abierta";
    }
    const {error}=await sb.from("posts").insert(row);
    if(error) return ui.toast(error.message,"err");
    ui.toast("Publicación creada","ok"); render();
  },
  async togglePost(id,pub){ await sb.from("posts").update({published:pub}).eq("id",id); render(); },
  async closeIdea(id,status){ await sb.from("posts").update({status}).eq("id",id); render(); },
  async delPost(id){ if(!confirm("¿Eliminar esta publicación?"))return; await sb.from("posts").delete().eq("id",id); render(); },

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
    const {error}=await sb.from("courses").insert({ title:t, level:$("#cL").value,
      url:$("#cU").value.trim()||null, description:$("#cD").value.trim(), published:$("#cP").checked });
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
    const t=$("#eT").value.trim(), d=$("#eD").value;
    if(!t||!d) return ui.toast("Título y fecha requeridos","err");
    const {error}=await sb.from("events").insert({ title:t, event_date:d, description:$("#eDesc").value.trim() });
    if(error) return ui.toast(error.message,"err"); ui.toast("Evento creado","ok"); render();
  },
  async delEvent(id){ if(!confirm("¿Eliminar evento?"))return; await sb.from("events").delete().eq("id",id); render(); },
};
window.app = app;
window.render = render;

/* ============================================================
   Consultas
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
   Íconos
   ============================================================ */
function icon(n){
  const p={
    home:'<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    gauge:'<path d="M12 13l4-4"/><path d="M4 18a8 8 0 1 1 16 0"/>',
    pie:'<path d="M12 3v9l7 4"/><circle cx="12" cy="12" r="9"/>',
    chart:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    news:'<path d="M4 6h11v14H5a1 1 0 0 1-1-1z"/><path d="M15 9h4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4"/><path d="M7 10h5M7 14h5"/>',
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
