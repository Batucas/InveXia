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

// Cinco componentes del perfil (0..1), derivados de las 10 respuestas.
const RADAR_DEFS = [
  { key:"tolerancia",   label:["Tolerancia","a pérdidas"],  q:["W1","W5"] },
  { key:"crecimiento",  label:["Apetito de","crecimiento"],  q:["W2","W4"] },
  { key:"experiencia",  label:["Experiencia"],               q:["W3"] },
  { key:"horizonte",    label:["Horizonte"],                 q:["C1"] },
  { key:"capacidad",    label:["Capacidad","financiera"],    q:["C2","C3","C4","C5"] },
];
function computeRadar(ans){
  return RADAR_DEFS.map(d=>{
    const vals=d.q.map(k=>ans[k]||0).filter(v=>v>0);
    const avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:1;   // 1..5
    return { key:d.key, label:d.label, level:Math.round(avg*10)/10, v01:Math.max(0,Math.min(1,(avg-1)/4)) };
  });
}
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
  toggleSide(){ $("#app").classList.toggle("collapsed"); },
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
  async google(){
    const box=$("#authMsg"); if(box){ box.className="msg-line ok"; box.textContent="Redirigiendo a Google…"; }
    const { error } = await sb.auth.signInWithOAuth({ provider:"google", options:{ redirectTo: location.origin + "/app.html" } });
    if(error && box){ box.className="msg-line err"; box.textContent=translateErr(error.message); }
  },
  async logout(){
    // cubrir la pantalla al instante para que no asome el login (el "puente")
    const s=document.createElement("div");
    s.style.cssText="position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.1rem;background:#0A1120";
    s.innerHTML='<div style="font-family:\'Sora\',system-ui,sans-serif;font-weight:700;font-size:1.7rem;color:#EAF1FB;letter-spacing:-.02em">Inve<span style="color:#2E7DF6">X</span>ia</div><div style="width:26px;height:26px;border:3px solid rgba(255,255,255,.14);border-top-color:#2E7DF6;border-radius:50%;animation:splashSpin .7s linear infinite"></div>';
    document.body.appendChild(s);
    await sb.auth.signOut();
    location.href="/";
  },
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
   ------------------------------------------------------------
   OJO: Supabase dispara eventos también al renovar el token
   (p. ej. al volver a la pestaña). Si repintáramos la app en cada
   evento, se perdería cualquier formulario a medio llenar.
   Solo reaccionamos a un cambio REAL de usuario.
   ============================================================ */
sb.auth.onAuthStateChange(async (event,session)=>{
  const prevUser = state.session?.user?.id || null;
  const nextUser = session?.user?.id || null;
  state.session = session;

  if(event==="TOKEN_REFRESHED" || event==="USER_UPDATED" || event==="INITIAL_SESSION") return;
  if(prevUser === nextUser) return;   // mismo usuario: no repintar

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
function showAuth(){ document.getElementById("splash")?.remove(); $("#app").classList.add("hidden"); $("#auth").classList.remove("hidden"); $("#bellBtn")?.classList.add("hidden"); $("#bellPanel")?.classList.add("hidden"); $("#sideToggle")?.classList.add("hidden"); }
function enterApp(){
  document.getElementById("splash")?.remove();
  $("#auth").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#bellBtn")?.classList.remove("hidden");
  $("#sideToggle")?.classList.remove("hidden");
  const p=state.profile, admin=p.role==="admin";
  $("#uName").textContent=p.full_name||"—";
  $("#uRole").textContent=admin?"Administrador":"Cliente";
  const av=$("#uAvatar"), avm=$("#uAvatarMob");
  const avHtml = p.avatar_url
    ? `<img src="${esc(p.avatar_url)}" alt="" onerror="this.parentNode.textContent='${initials(p.full_name)}'">`
    : initials(p.full_name);
  if(p.avatar_url){ av.innerHTML=avHtml; if(avm) avm.innerHTML=avHtml; }
  else { av.textContent=initials(p.full_name); if(avm) avm.textContent=initials(p.full_name); }
  buildNav(admin);
  // Modo enfoque: cursos en pestaña nueva a pantalla completa
  const focus=new URLSearchParams(location.search).get("focus");
  if(focus==="cursos"){
    document.body.classList.add("focus-mode");
    location.hash="#/cursos"; route(); return;
  }
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
  ["operar","Operar",icon("trade")],
  ["ajuste","Ajuste de portafolio",icon("tune"),"premium"],
  ["quantnet","Red de mercado",icon("net"),"premium"],
  ["radar","Radar",icon("radar")],
  ["terminal","Terminal de opciones",icon("term")],
  ["brief","Brief macro",icon("brief")],
  ["simulador","Simulador",icon("chart")],
  ["asistente","Asistente IA",icon("bot")],
  ["mercado","Mercado e ideas",icon("news")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
  ["perfil","Mi perfil",icon("user")],
];
const NAV_ADMIN=[
  ["clientes","Clientes",icon("users")],
  ["quantnet","Red de mercado",icon("net")],
  ["publicaciones","Noticias e ideas",icon("news")],
  ["brief","Brief macro",icon("brief")],
  ["cursos","Cursos",icon("book")],
  ["calendario","Calendario",icon("cal")],
  ["mensajes","Mensajes",icon("chat")],
];
function buildNav(admin){
  const nav=$("#nav"); nav.innerHTML="";
  nav.append(el(`<div class="nav-label">${admin?"Administración":"Mi cuenta"}</div>`));
  (admin?NAV_ADMIN:NAV_CLIENT).forEach(([id,label,ic,flag])=>{
    const badge = flag==="premium" ? '<span class="pill-premium">PREMIUM</span>'
                : id==="mensajes"   ? '<span class="nav-dot hidden" id="msgDot">0</span>' : "";
    const a=el(`<a data-v="${id}">${ic}<span>${label}</span>${badge}</a>`);
    a.onclick=()=>{
      if(id==="cursos" && !document.body.classList.contains("focus-mode")){
        window.open(location.origin+location.pathname+"?focus=cursos","_blank");
        $("#sidebar").classList.remove("open"); return;
      }
      location.hash="#/"+id; $("#sidebar").classList.remove("open");
    };
    nav.append(a);
  });
  refreshBadges();
  clearInterval(state.cache.badgeTimer);
  state.cache.badgeTimer=setInterval(refreshBadges,30000);
}
async function refreshBadges(){
  if(!state.session||!state.profile) return;
  const admin = state.profile.role==="admin";

  // --- notificaciones sin leer (campana) ---
  const { count:notifCount }=await sb.from("notifications").select("id",{count:"exact",head:true})
    .eq("user_id",state.profile.id).eq("read",false);
  const bell=$("#bellBadge");
  if(bell){
    if(notifCount>0){ bell.textContent=notifCount>99?"99+":notifCount; bell.classList.remove("hidden"); }
    else bell.classList.add("hidden");
  }

  // --- mensajes sin leer (punto sobre Mensajes) ---
  let q=sb.from("messages").select("id",{count:"exact",head:true}).eq("read",false);
  q = admin ? q.eq("sender_role","client")
            : q.eq("client_id",state.profile.id).eq("sender_role","admin");
  const { count:msgCount }=await q;
  const dot=$("#msgDot");
  if(dot){
    if(msgCount>0){ dot.textContent=msgCount>9?"9+":msgCount; dot.classList.remove("hidden"); }
    else dot.classList.add("hidden");
  }
}
// alias por compatibilidad con llamadas existentes
const refreshBadge = refreshBadges;
window.addEventListener("hashchange",route);
// cerrar el buscador de activos al hacer clic fuera
document.addEventListener("click",(e)=>{
  const box=document.getElementById("symResults");
  if(box && !box.classList.contains("hidden") && !e.target.closest(".search-wrap")) box.classList.add("hidden");
  // cerrar la campana al hacer clic fuera
  const panel=document.getElementById("bellPanel");
  if(panel && !panel.classList.contains("hidden") && !e.target.closest(".bell-panel") && !e.target.closest(".bell-btn"))
    panel.classList.add("hidden");
});
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
  m.classList.remove("wide");   // por defecto ancho normal; algunas vistas lo amplían
  m.classList.remove("view-enter"); void m.offsetWidth; m.classList.add("view-enter");  // transición de entrada
  const admin=state.profile.role==="admin";
  try{
    if(admin){
      if(state.view==="clientes"&&state.param) return void await viewAdminClient(state.param);
      if(state.view==="clientes")      return void await viewAdminClients();
      if(state.view==="notificaciones") return void await viewNotifications();
      if(state.view==="publicaciones") return void await viewPostsAdmin();
      if(state.view==="brief")         return void await viewBrief();
      if(state.view==="cursos"&&state.param) return void await viewCourseSubmissions(state.param);
      if(state.view==="cursos")        return void await viewCoursesAdmin();
      if(state.view==="calendario")    return void await viewCalendarAdmin();
      if(state.view==="mensajes")      return void await viewAdminInbox();
      if(state.view==="quantnet")      return void await viewQuantNet();
    } else {
      if(state.view==="inicio")     return void await viewClientHome();
      if(state.view==="notificaciones") return void await viewNotifications();
      if(state.view==="asistente")  return void await viewAssistant();
      if(state.view==="perfil")     return void await viewProfile();
      if(state.view==="riesgo")     return void await viewRisk();
      if(state.view==="cartera")    return void await viewPortfolio();
      if(state.view==="operar")     return void await viewTrade();
      if(state.view==="ajuste")     return void await viewPortfolioAdjust();
      if(state.view==="quantnet")   return void await viewQuantNet();
      if(state.view==="radar")      return void await viewRadar();
      if(state.view==="terminal")   return void await viewTerminal();
      if(state.view==="brief")      return void await viewBrief();
      if(state.view==="simulador")  return void await viewSimulator();
      if(state.view==="mercado")    return void await viewFeed();
      if(state.view==="cursos"&&state.param) return void await viewCourseDetail(state.param);
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
  const [ra,pf,posts,courses]=await Promise.all([
    latestAssessment(state.profile.id),
    publishedPortfolio(state.profile.id),
    sb.from("posts").select("*").eq("published",true).order("created_at",{ascending:false}).limit(9).then(r=>r.data||[]),
    sb.from("courses").select("*").eq("published",true).order("created_at",{ascending:false}).limit(3).then(r=>r.data||[]),
  ]);
  const m=$("#main");
  const first=(state.profile.full_name||"").split(" ")[0];
  m.innerHTML=head("Panel","Hola, "+first,"Lo último de InveXia: ideas, mercado y formación.");

  // --- franja de progreso ---
  if(!ra){
    m.append(el(`<div class="banner">
      <div><div class="eyebrow" style="color:var(--blue-400);font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;font-weight:600">Primer paso</div>
        <h3 style="margin:.3rem 0">Descubre tu perfil de inversor</h3>
        <p class="card-sub" style="margin:0">Un cuestionario de 4 minutos. Con él diseñamos la cartera adecuada para ti.</p></div>
      <button class="btn btn-primary" style="width:auto;white-space:nowrap" onclick="location.hash='#/riesgo'">Empezar ahora</button>
    </div>`));
  } else if(!pf){
    m.append(el(`<div class="strip">
      <span class="pill dot pill-warn">En diseño</span>
      <span>Perfil <b style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</b> · tu asesor está construyendo tu cartera.</span>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="location.hash='#/simulador'">Proyectar aportes</button>
    </div>`));
  } else {
    m.append(el(`<div class="strip">
      <span class="pill dot pill-ok">Cartera activa</span>
      <span>Perfil <b style="color:${cssv(BANDS[ra.final_band].cvar)}">${esc(ra.band_label)}</b> · ${esc(pf.name)}.</span>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="location.hash='#/cartera'">Ver rendimiento</button>
    </div>`));
  }

  const ideas=posts.filter(p=>p.kind==="idea").slice(0,4);
  const news =posts.filter(p=>p.kind==="noticia").slice(0,4);

  if(ideas.length){
    m.append(sectionHead("Ideas de inversión","#/mercado"));
    const g=el(`<div class="grid grid-2" style="margin-bottom:1.8rem"></div>`);
    ideas.forEach(p=>g.append(ideaCard(p))); m.append(g);
  }
  if(news.length){
    m.append(sectionHead("Mercado","#/mercado"));
    const g=el(`<div class="grid grid-2" style="margin-bottom:1.8rem"></div>`);
    news.forEach(p=>g.append(newsCard(p))); m.append(g);
  }
  if(courses.length){
    m.append(sectionHead("Cursos","#/cursos"));
    const g=el(`<div class="grid grid-3" style="margin-bottom:1.8rem"></div>`);
    courses.forEach(c=>g.append(courseCard(c))); m.append(g);
  }
  if(!ideas.length && !news.length && !courses.length){
    m.append(el(`<div class="card empty">${icon("news")}<p style="margin-top:.4rem">Aún no hay contenido publicado. Vuelve pronto.</p></div>`));
  }

  m.append(el(`<div class="card mt2"><h3>Mis datos de contacto</h3>
    <p class="card-sub">Tu asesor te contactará por estos medios.</p>
    <div class="field"><label>Correo</label><input class="input" value="${esc(state.profile.email||"")}" disabled></div>
    <div class="field"><label>Celular (con código de país)</label>
      <input id="phIn" class="input" placeholder="+591 7xxxxxxx" value="${esc(state.profile.phone||"")}"></div>
    <button class="btn btn-ghost btn-sm" onclick="app.savePhone()">Guardar celular</button></div>`));
}
function sectionHead(title,href){
  return el(`<div class="flex between" style="margin:.4rem 0 .9rem">
    <div class="nav-label" style="padding:0">${title}</div>
    <a style="font-size:.82rem;cursor:pointer" onclick="location.hash='${href}'">Ver todo →</a></div>`);
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
    m.append(renderResult(ra)); loadSuggestion();
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
        <h3>Tu perfil en cinco dimensiones</h3>
        <p class="card-sub">Cada eje muestra un componente de tu actitud y tu situación frente al riesgo.</p>
        <div class="radar">${radarChart(computeRadar(ra.answers||{}))}</div>
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
        <div id="aiSuggest" class="ai-suggest"></div>
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
async function loadSuggestion(){
  const box=$("#aiSuggest"); if(!box) return;
  box.innerHTML=`<div class="ai-head"><span class="tag">Sugerencia de tu asesor</span></div>
    <div class="ai-box loading"><span class="spinner" style="border-color:rgba(120,150,200,.3);border-top-color:var(--blue-400)"></span> Preparando tu recomendación…</div>`;
  try{
    const { data:{ session } }=await sb.auth.getSession();
    const r=await fetch("/api/suggest-portfolio",{ method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token } });
    const ct=r.headers.get("content-type")||"";
    if(!ct.includes("application/json")) throw 0;
    const d=await r.json();
    if(!d.ok) throw 0;
    const paras=d.suggestion.split(/\n+/).filter(Boolean).map(p=>`<p>${esc(p)}</p>`).join("");
    box.innerHTML=`<div class="ai-head"><span class="tag">Sugerencia de tu asesor</span></div><div class="ai-box">${paras}</div>`;
  }catch(e){ box.innerHTML=""; }   // si falla, simplemente no se muestra
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
// Radar de 5 componentes (SVG)
function radarChart(components){
  const cx=200, cy=182, R=124, N=components.length;
  const ang=(i)=> -Math.PI/2 + i*2*Math.PI/N;
  const pt=(i,r)=>[cx+Math.cos(ang(i))*r, cy+Math.sin(ang(i))*r];

  // anillos de referencia
  let rings="";
  [0.25,0.5,0.75,1].forEach(f=>{
    const pts=components.map((_,i)=>pt(i,R*f).map(n=>n.toFixed(1)).join(",")).join(" ");
    rings+=`<polygon points="${pts}" fill="none" stroke="var(--line)" stroke-width="1"/>`;
  });
  // ejes
  let axes="";
  components.forEach((_,i)=>{ const [x,y]=pt(i,R); axes+=`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`; });

  // polígono de datos
  const dpts=components.map((c,i)=>pt(i,R*c.v01).map(n=>n.toFixed(1)).join(",")).join(" ");
  // vértices + etiquetas
  let dots="", labels="";
  components.forEach((c,i)=>{
    const [dx,dy]=pt(i,R*c.v01);
    dots+=`<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="4.2" fill="var(--blue-400)" stroke="var(--navy-950)" stroke-width="1.5"/>`;
    const [ax,ay]=pt(i,R);
    const isLeft=ax<cx-5, isRight=ax>cx+5;
    const anchor = isLeft?"end":(isRight?"start":"middle");
    const lx = ax + (isLeft?-11:(isRight?11:0));
    const ly = ay + (ay<cy-5?-8:(ay>cy+5?18:-8));
    const lines=Array.isArray(c.label)?c.label:[c.label];
    const tspans=lines.map((t,k)=>`<tspan x="${lx.toFixed(1)}" dy="${k===0?0:13}">${esc(t)}</tspan>`).join("");
    labels+=`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" fill="var(--muted)" font-size="11.5" font-family="Inter">${tspans}</text>`;
    labels+=`<text x="${lx.toFixed(1)}" y="${(ly+lines.length*13).toFixed(1)}" text-anchor="${anchor}" fill="var(--blue-300)" font-size="10.5" font-family="JetBrains Mono">${c.level}/5</text>`;
  });

  return `<svg viewBox="0 0 400 372" width="100%" style="display:block">
    ${rings}${axes}
    <polygon points="${dpts}" fill="var(--blue-500)" fill-opacity=".22" stroke="var(--blue-400)" stroke-width="2"/>
    ${dots}${labels}
  </svg>`;
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
   CLIENTE · QuantNet — Red de mercado (premium)
   ============================================================ */
async function viewQuantNet(){
  const m=$("#main");
  m.classList.add("wide");   // esta vista aprovecha todo el ancho
  m.innerHTML=head("Premium","Red de mercado","Estructura de correlaciones del mercado como una red viva.");
  const admin=state.profile.role==="admin";
  if(!admin && !state.profile.premium_quantnet){
    m.append(el(`<div class="card empty">${icon("net")}<h3 style="margin-top:.5rem">Servicio no habilitado</h3>
      <p>QuantNet es un servicio premium. Escríbele a tu asesor para activarlo.</p>
      <button class="btn btn-ghost btn-sm" style="width:auto;margin-top:.6rem" onclick="location.hash='#/mensajes'">Contactar a mi asesor</button></div>`));
    return;
  }
  const wrap=el(`<div class="card" style="padding:0;overflow:hidden">${loading()}</div>`);
  m.append(wrap);
  try{
    const { data:{ session } }=await sb.auth.getSession();
    const r=await fetch("/api/quantnet-url",{ headers:{ Authorization:"Bearer "+session.access_token } });
    const ct=r.headers.get("content-type")||"";
    if(!ct.includes("application/json")) throw new Error("La función /api/quantnet-url no está desplegada.");
    const d=await r.json();
    if(!d.ok) throw new Error(d.message||d.error||"No disponible");
    const src=`quantnet.html?role=${encodeURIComponent(d.role)}&data=${encodeURIComponent(d.url)}`;
    wrap.style.padding="0";
    wrap.innerHTML=`<iframe src="${esc(src)}" class="quantnet-frame" title="QuantNet" loading="lazy"></iframe>`;
  }catch(e){
    wrap.innerHTML=`<div class="notice warn" style="margin:1rem">${esc(e.message)}${/pipeline|datos public/i.test(e.message)?" — el pipeline aún no ha subido datos.":""}</div>`;
  }
}

/* ============================================================
   CLIENTE · Ajuste de portafolio (premium)
   ============================================================ */
async function viewPortfolioAdjust(){
  const m=$("#main");
  m.innerHTML=head("Premium","Ajuste de portafolio","Diagnostica tu cartera y descubre cómo optimizarla.");

  if(!state.profile.premium_portfolio){
    m.append(el(`<div class="card empty">${icon("tune")}<h3 style="margin-top:.5rem">Servicio no habilitado</h3>
      <p>El ajuste de portafolio es un servicio premium. Escríbele a tu asesor para activarlo.</p>
      <button class="btn btn-ghost btn-sm" style="width:auto;margin-top:.6rem" onclick="location.hash='#/mensajes'">Contactar a mi asesor</button></div>`));
    return;
  }
  // requiere perfil de riesgo
  const ra=await latestAssessment(state.profile.id);
  if(!ra){
    m.append(el(`<div class="card empty">${icon("gauge")}<h3 style="margin-top:.5rem">Primero, tu perfil de riesgo</h3>
      <p>Necesitamos conocer tu perfil para evaluar si tu cartera está alineada con tu tolerancia al riesgo.</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.6rem" onclick="location.hash='#/riesgo'">Completar perfil de riesgo</button></div>`));
    return;
  }

  state.cache.adj = state.cache.adj || [];
  m.append(el(`<div class="card">
    <h3>Tu cartera actual</h3>
    <p class="card-sub">Añade los activos que tienes hoy. El monto o peso es opcional: si no lo pones, asumimos partes iguales.</p>
    <div class="search-wrap" style="max-width:420px">
      <input id="adjSym" class="input mono" placeholder="Buscar activo: Apple, NVDA, VOO…" autocomplete="off"
        oninput="app.searchAdj(this.value)" onfocus="app.searchAdj(this.value)">
      <div id="adjResults" class="search-results hidden"></div>
    </div>
    <div class="flex" style="gap:.6rem;margin-top:.6rem;flex-wrap:wrap">
      <input id="adjVal" class="input mono" type="number" min="0" step="any" placeholder="Monto USD (opcional)" style="max-width:200px">
      <button class="btn btn-ghost btn-sm" style="width:auto" onclick="app.addAdj()">+ Añadir</button>
    </div>
    <div id="adjList" class="adj-list"></div>
    <button id="adjRun" class="btn btn-primary" style="width:auto;margin-top:1rem" onclick="app.runAnalyze()">Analizar mi cartera</button>
  </div>`));
  m.append(el(`<div id="adjOut"></div>`));
  renderAdjList();
}
function renderAdjList(){
  const box=$("#adjList"); if(!box) return;
  const list=state.cache.adj;
  if(!list.length){ box.innerHTML=`<p class="card-sub" style="margin:.6rem 0 0">Aún no has añadido activos.</p>`; return; }
  box.innerHTML="";
  list.forEach((h,i)=>box.append(el(`<div class="adj-item">
    <b class="mono">${esc(h.symbol)}</b>
    <span>${h.value?("$"+Math.round(h.value).toLocaleString("en-US")):"<i style='color:var(--faint)'>peso igual</i>"}</span>
    <button class="x" onclick="app.rmAdj(${i})">✕</button></div>`)));
}

async function runAnalyzeRender(d){
  const out=$("#adjOut"); const cur=d.current.metrics, curW=d.current.weights;
  const fmtPeso=w=>`${(w*100).toFixed(1)}%`;
  const statRow=(mm)=>`<div class="qmetrics">
    <div><span>Sharpe</span><b class="${mm.sharpe>=1?"pos":(mm.sharpe<0?"neg":"")}">${mm.sharpe.toFixed(2)}</b></div>
    <div><span>Sortino</span><b>${mm.sortino.toFixed(2)}</b></div>
    <div><span>Calmar</span><b>${mm.calmar.toFixed(2)}</b></div>
    <div><span>Volatilidad</span><b>${(mm.annVol*100).toFixed(1)}%</b></div>
    <div><span>Retorno anual*</span><b>${(mm.annReturn*100).toFixed(1)}%</b></div>
    <div><span>Máx. caída</span><b class="neg">${(mm.maxDrawdown*100).toFixed(1)}%</b></div>
  </div>`;

  out.innerHTML="";
  // 1. diagnóstico
  const diag=el(`<div class="card"><h3>Diagnóstico de tu cartera actual</h3>
    ${d.failed.length?`<div class="notice warn">No se encontró histórico de: ${d.failed.join(", ")}. Se analizó el resto.</div>`:""}
    ${statRow(cur)}
    <div class="risk-banner ${d.overRisk?"bad":"ok"}">
      ${d.overRisk
        ? `⚠ Tu cartera tiene una volatilidad de <b>${(cur.annVol*100).toFixed(1)}%</b>, por encima de lo esperado para tu perfil <b>${esc(d.bandLabel)}</b> (~${(d.bandVol*100).toFixed(0)}%). Estás asumiendo más riesgo del que tu perfil sugiere.`
        : `✓ La volatilidad de tu cartera (<b>${(cur.annVol*100).toFixed(1)}%</b>) está alineada con tu perfil <b>${esc(d.bandLabel)}</b>.`}
    </div>
    <p class="card-sub" style="margin-top:.7rem;font-size:.74rem">*Retorno anualizado histórico sobre ${d.years} años (${d.points} días). Rendimientos pasados no garantizan resultados futuros. Tasa libre de riesgo: ${(d.rf*100).toFixed(0)}%.</p>`);
  out.append(diag);

  // 2. tres carteras recomendadas
  const methods=[
    ["Markowitz — Máx. Sharpe", d.markowitz.maxSharpe, d.symbols, "Maximiza retorno por unidad de riesgo."],
    ["Markowitz — Mín. Varianza", d.markowitz.minVol, d.symbols, "La cartera más estable posible."],
    ["HRP (López de Prado)", d.hrp, d.symbols, "Diversifica por clusters de correlación; más robusta."],
    ["Core-Satellite", d.coreSatellite, d.coreSatellite.symbols, "Núcleo estable + satélites tácticos acotados."],
  ];
  const cards=el(`<div class="qcards"></div>`);
  methods.forEach(([name,pack,syms,desc])=>{
    const w=pack.weights, mm=pack.metrics;
    const rows=syms.map((s,i)=>w[i]>0.001?`<tr><td class="mono">${esc(s)}${(name==="Core-Satellite"&&s===pack.coreSym)?' <span style="color:var(--blue-300);font-size:.7rem">núcleo</span>':""}</td><td style="text-align:right" class="mono">${fmtPeso(w[i])}</td></tr>`:"").join("");
    cards.append(el(`<div class="qcard">
      <h4>${name}</h4><p class="qdesc">${desc}</p>
      <table class="qtbl"><tbody>${rows}</tbody></table>
      <div class="qmini"><span>Sharpe <b>${mm.sharpe.toFixed(2)}</b></span><span>Vol <b>${(mm.annVol*100).toFixed(0)}%</b></span></div>
    </div>`));
  });
  out.append(el(`<div class="card"><h3>Carteras recomendadas</h3>
    <p class="card-sub">Tres enfoques distintos calculados sobre tus mismos activos. ${d.coreSatellite.extraCore?`El Core-Satellite sugiere añadir <b>${esc(d.coreSatellite.coreSym)}</b> como núcleo.`:""}</p></div>`));
  out.append(cards);

  // 3. frontera de Markowitz (scatter)
  out.append(el(`<div class="card"><h3>Frontera eficiente (Markowitz)</h3>
    <p class="card-sub">Cada punto es una combinación posible de tus activos. La estrella marca la de mejor Sharpe.</p>
    ${frontierChart(d.markowitz.cloud, d.markowitz.maxSharpe.metrics, d.markowitz.minVol.metrics, cur)}</div>`));

  // 4. plan de ajuste con pestañas
  const planMethods=[
    ["hrp","HRP",d.symbols,d.hrp.weights],
    ["mk","Máx. Sharpe",d.symbols,d.markowitz.maxSharpe.weights],
    ["cs","Core-Satellite",d.coreSatellite.symbols,d.coreSatellite.weights],
  ];
  const tabs=planMethods.map((p,i)=>`<button class="tab ${i===0?"active":""}" onclick="app.planTab('${p[0]}')">${p[1]}</button>`).join("");
  const plan=el(`<div class="card"><h3>Plan de ajuste</h3>
    <p class="card-sub">Qué hacer con cada activo para pasar de tu cartera actual a la recomendada.</p>
    <div class="tabs">${tabs}</div><div id="planBody"></div></div>`);
  out.append(plan);
  // pesos actuales indexados por símbolo (para alinear con universos distintos)
  const curBySym=Object.fromEntries(d.symbols.map((s,i)=>[s,curW[i]]));
  state.cache.adjResult={ curBySym, plans:Object.fromEntries(planMethods.map(p=>[p[0],{symbols:p[2],target:p[3]}])) };
  app.planTab("hrp");
}
function planRows(symbols,current,target){
  const ACT={vender:["Vender","neg"],reducir:["Reducir","warn-t"],mantener:["Mantener",""],incrementar:["Incrementar","pos"],añadir:["Añadir","pos"]};
  return symbols.map((s,i)=>{
    const c=current[i]||0,t=target[i]||0,d=t-c;
    let a; if(t===0&&c>0)a="vender"; else if(c===0&&t>0)a="añadir"; else if(d<-0.03)a="reducir"; else if(d>0.03)a="incrementar"; else a="mantener";
    const [lbl,cls]=ACT[a];
    return `<tr><td class="mono">${esc(s)}</td>
      <td style="text-align:right" class="mono">${(c*100).toFixed(0)}%</td>
      <td style="text-align:center;color:var(--faint)">→</td>
      <td style="text-align:right" class="mono">${(t*100).toFixed(0)}%</td>
      <td style="text-align:right"><span class="act ${cls}">${lbl}</span></td></tr>`;
  }).join("");
}
// Scatter de frontera eficiente
function frontierChart(cloud,maxSh,minV,cur){
  if(!cloud||!cloud.length) return "";
  const W=520,H=300,pad=48;
  const vols=cloud.map(p=>p[0]).concat([cur.annVol]), rets=cloud.map(p=>p[1]).concat([cur.annReturn]);
  const vMin=Math.min(...vols)*0.9, vMax=Math.max(...vols)*1.05;
  const rMin=Math.min(...rets)*1.05, rMax=Math.max(...rets)*1.05;
  const X=v=>pad+(v-vMin)/(vMax-vMin)*(W-pad*1.4);
  const Y=r=>H-pad-(r-rMin)/(rMax-rMin)*(H-pad*1.6);
  const dots=cloud.map(p=>`<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="1.6" fill="var(--blue-500)" opacity=".28"/>`).join("");
  const star=(x,y,c,r=7)=>{let pts="";for(let k=0;k<10;k++){const ang=-Math.PI/2+k*Math.PI/5,rr=k%2?r*.45:r;pts+=`${(x+Math.cos(ang)*rr).toFixed(1)},${(y+Math.sin(ang)*rr).toFixed(1)} `;}return `<polygon points="${pts}" fill="${c}"/>`;};
  const gx=[vMin,(vMin+vMax)/2,vMax], gy=[rMin,(rMin+rMax)/2,rMax];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    ${gx.map(v=>`<text x="${X(v).toFixed(1)}" y="${H-pad+16}" font-size="10" fill="var(--faint)" text-anchor="middle" font-family="JetBrains Mono">${(v*100).toFixed(0)}%</text>`).join("")}
    ${gy.map(r=>`<text x="${pad-8}" y="${Y(r).toFixed(1)}" font-size="10" fill="var(--faint)" text-anchor="end" font-family="JetBrains Mono">${(r*100).toFixed(0)}%</text>`).join("")}
    <text x="${W/2}" y="${H-6}" font-size="11" fill="var(--muted)" text-anchor="middle" font-family="Inter">Volatilidad (riesgo) →</text>
    <text x="14" y="${H/2}" font-size="11" fill="var(--muted)" text-anchor="middle" font-family="Inter" transform="rotate(-90 14 ${H/2})">Retorno →</text>
    ${dots}
    ${star(X(cur.annVol),Y(cur.annReturn),"var(--faint)",6)}
    ${star(X(minV.annVol),Y(minV.annReturn),"var(--blue-300)",7)}
    ${star(X(maxSh.annVol),Y(maxSh.annReturn),"var(--gold)",9)}
    <g font-family="Inter" font-size="10">
      <rect x="${W-150}" y="16" width="10" height="10" fill="var(--gold)"/><text x="${W-135}" y="25" fill="var(--muted)">Máx. Sharpe</text>
      <rect x="${W-150}" y="32" width="10" height="10" fill="var(--blue-300)"/><text x="${W-135}" y="41" fill="var(--muted)">Mín. varianza</text>
      <rect x="${W-150}" y="48" width="10" height="10" fill="var(--faint)"/><text x="${W-135}" y="57" fill="var(--muted)">Tu cartera</text>
    </g></svg>`;
}

/* ============================================================
   CLIENTE · Operar (Alpaca sandbox)
   ============================================================ */
const TRADE_SYMBOLS = [
  ["SPY","S&P 500 (SPY)"],["VOO","Vanguard S&P 500 (VOO)"],["QQQ","Nasdaq 100 (QQQ)"],
  ["VTI","Total Market (VTI)"],["DIA","Dow Jones (DIA)"],["IWM","Russell 2000 (IWM)"],
  ["AAPL","Apple"],["MSFT","Microsoft"],["NVDA","Nvidia"],["AMZN","Amazon"],
  ["GOOGL","Alphabet"],["TSLA","Tesla"],["META","Meta"],["NFLX","Netflix"],
  ["GLD","Oro (GLD)"],["TLT","Bonos largos EE.UU. (TLT)"],
  ["BTC/USD","Bitcoin"],["ETH/USD","Ethereum"],["SOL/USD","Solana"],
];
async function viewTrade(){
  const m=$("#main");
  m.innerHTML=head("Inversión","Operar","Busca un activo, analiza su gráfico y adquiérelo con dinero ficticio para practicar.");
  m.append(el(`<div id="tradeBody">${loading()}</div>`));
  await loadSimPortfolios();
  const pfs=state.cache.portfolios||[];
  if(!state.cache.tradePf || !pfs.find(p=>p.id===state.cache.tradePf)) state.cache.tradePf=pfs[0]?.id||null;
  if(!state.cache.tradeSym) state.cache.tradeSym="AAPL";
  renderTrade();
}
function renderTrade(){
  const body=$("#tradeBody"); if(!body) return;
  const pfs=state.cache.portfolios||[];
  if(!pfs.length){
    body.innerHTML=`<div class="card empty">${icon("trade")}
      <h3 style="margin:.4rem 0 .2rem">Primero crea un portafolio</h3>
      <p style="color:var(--muted)">Necesitas un portafolio para adquirir activos. Cada uno arranca con ${money(10000,"USD")} ficticios.</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.7rem" onclick="app.createPortfolio(true)">+ Crear portafolio</button></div>`;
    return;
  }
  const pf=pfs.find(p=>p.id===state.cache.tradePf)||pfs[0];
  const cash=num(pf.cash)||0; const sym=state.cache.tradeSym;
  body.innerHTML=`
    <div class="trade-top card">
      <div class="field" style="margin:0"><label>Portafolio</label>
        <select id="tradePfSel" class="input" onchange="app.tradeSelectPf(this.value)">
          ${pfs.map(p=>`<option value="${p.id}" ${p.id===pf.id?"selected":""}>${esc(p.name)} · ${money(num(p.cash)||0,"USD")} efectivo</option>`).join("")}
        </select></div>
      <div class="field" style="margin:0"><label>Buscar activo (acciones, ETFs, renta fija vía ETFs, cripto)</label>
        <div class="search-wrap">
          <input id="buySym" class="input mono" placeholder="Escribe símbolo o nombre: Apple, NVDA, TLT…" autocomplete="off"
            value="${esc(sym)}" oninput="app.searchAssets(this.value)" onfocus="app.searchAssets(this.value)">
          <div id="symResults" class="search-results hidden"></div>
        </div>
        <div class="flex" style="gap:.35rem;flex-wrap:wrap;margin-top:.5rem">
          ${["AAPL","NVDA","SPY","QQQ","TLT","AGG","GLD","BTCUSD"].map(c=>`<button class="chip" onclick="app.pickTradeSym('${c}')">${c}</button>`).join("")}
        </div>
      </div>
    </div>
    <div class="trade-grid">
      <div class="card trade-chart-card">
        <div class="flex between"><h3 style="margin:0">${esc(sym)}</h3><span class="card-sub" style="margin:0">Gráfico con velas, línea de tendencia e indicadores</span></div>
        <div id="tvChart" class="tv-chart"></div>
      </div>
      <div class="card">
        <h3>Adquirir / Vender</h3>
        <p class="card-sub">Orden simulada a precio de mercado en <b>${esc(pf.name)}</b>.</p>
        <div class="field"><label>Símbolo</label><input id="ordSym" class="input mono" value="${esc(sym)}" readonly></div>
        <div class="field"><label>Precio actual</label><div id="ordPrice" class="ord-price mono">Consultando…</div></div>
        <div class="field"><label>Monto a invertir (USD)</label>
          <input id="ordAmt" class="input mono" type="number" min="1" step="any" placeholder="1000" oninput="app.tradeEstimate()"></div>
        <div id="ordEst" class="ord-est"></div>
        <div class="flex" style="gap:.5rem;margin-top:.3rem">
          <button class="btn btn-primary" style="width:auto" onclick="app.buyAsset()">Comprar</button>
          <button class="btn btn-ghost" style="width:auto" onclick="app.sellAsset()">Vender</button>
        </div>
        <div id="ordMsg" class="msg-line"></div>
        <div class="divide"></div>
        <div class="nav-label" style="padding:0 0 .4rem">Efectivo disponible</div>
        <div class="mono" style="font-size:1.1rem;color:var(--text)">${money(cash,"USD")}</div>
      </div>
    </div>`;
  tvWidget(sym);
  loadOrderPrice(sym);
}
function tvWidget(sym){
  const host=document.getElementById("tvChart"); if(!host) return;
  host.innerHTML="";
  const mount=()=>{ if(!window.TradingView){ host.innerHTML='<div class="term-noplot">No se pudo cargar el gráfico. Revisa el bloqueador del navegador.</div>'; return; }
    new window.TradingView.widget({ container_id:"tvChart", autosize:true, symbol:tvSymbol(sym),
      interval:"D", timezone:"Etc/UTC", theme:"dark", style:"1", locale:"es", hide_side_toolbar:false,
      allow_symbol_change:true, withdateranges:true, studies:[], backgroundColor:"rgba(10,17,32,1)" }); };
  if(window.TradingView) return mount();
  const s=document.createElement("script"); s.src="https://s3.tradingview.com/tv.js"; s.onload=mount;
  s.onerror=()=>{ host.innerHTML='<div class="term-noplot">No se pudo cargar el gráfico (CDN de TradingView bloqueado).</div>'; };
  document.head.appendChild(s);
}
function tvSymbol(sym){
  const s=(sym||"").toUpperCase().replace("/","");
  if(/BTC|ETH|SOL/.test(s)) return "CRYPTO:"+s;   // cripto
  return s;                                          // acciones/ETFs resuelven directo
}
function classOf(sym){
  const s=(sym||"").toUpperCase();
  if(/BTC|ETH|SOL|DOGE|ADA/.test(s)) return "crypto";
  if(["TLT","AGG","LQD","BND","IEF","SHY","HYG","TIP","BNDX","MUB","EMB","VCIT","VCSH"].includes(s)) return "fixed_income";
  if(["GLD","SLV","USO","UNG","DBC","GDX"].includes(s)) return "alt";
  return "equity";
}
async function loadOrderPrice(sym){
  const el2=document.getElementById("ordPrice"); if(el2) el2.textContent="Consultando…";
  const qr=await fetchQuotes([sym]); const q=qr.quotes?.[sym];
  state.cache.tradePrice = (q&&Number.isFinite(q.price))?q.price:null;
  if(el2) el2.textContent = state.cache.tradePrice!=null ? money(state.cache.tradePrice,"USD")+(q.percent!=null?` (${pct(q.percent)} hoy)`:"") : "No disponible";
  app.tradeEstimate();
}

/* ============================================================
   CLIENTE · Mi cartera (objetivo + ejecutada con rendimiento)
   ============================================================ */
async function viewPortfolio(){
  const m=$("#main");
  m.innerHTML=head("Inversión","Mi cartera","Tus portafolios simulados. Arma y sigue tus inversiones con dinero ficticio.");
  m.append(el(`<div id="pfShell">${loading()}</div>`));
  await loadSimPortfolios();
  renderPortfolioList();
}
async function loadSimPortfolios(){
  const { data }=await sb.from("sim_portfolios").select("*").eq("user_id",state.profile.id).order("created_at");
  state.cache.portfolios=data||[];
  return state.cache.portfolios;
}
async function renderPortfolioList(){
  const box=$("#pfShell"); if(!box) return;
  const pfs=state.cache.portfolios||[];
  // valuar todos con precios de mercado
  const allTk=[...new Set(pfs.flatMap(p=>(p.holdings||[]).filter(h=>num(h.quantity)>0).map(h=>h.ticker)))];
  const qr=await fetchQuotes(allTk); const quotes=qr.quotes||{};
  const canCreate=pfs.length<10;
  box.innerHTML=`
    <div class="flex between" style="margin-bottom:1rem;flex-wrap:wrap;gap:.6rem">
      <div class="card-sub" style="margin:0">${pfs.length}/10 portafolios · ${money(10000,"USD")} ficticios por portafolio</div>
      <button class="btn btn-primary btn-sm" style="width:auto" ${canCreate?"":"disabled"} onclick="app.createPortfolio()">+ Nuevo portafolio</button>
    </div>`;
  if(!pfs.length){
    box.insertAdjacentHTML("beforeend",`<div class="card empty">${icon("pie")}
      <h3 style="margin:.4rem 0 .2rem">Aún no tienes portafolios</h3>
      <p style="color:var(--muted)">Crea tu primer portafolio simulado y empieza a comprar activos desde "Operar".</p>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.7rem" onclick="app.createPortfolio()">+ Crear mi primer portafolio</button></div>`);
    return;
  }
  const grid=el(`<div class="pf-cards"></div>`);
  pfs.forEach(p=>{
    const P=perfOf(p.holdings||[],quotes); const cash=num(p.cash)||0; const total=(P.value||0)+cash;
    const cls=P.executed?sgn(P.pnl):"";
    grid.append(el(`<div class="pf-card card" onclick="app.openPortfolio('${p.id}')">
      <div class="flex between"><h3 style="margin:0">${esc(p.name)}</h3>
        <button class="mp-exp" onclick="event.stopPropagation();app.deletePortfolio('${p.id}',event)" title="Eliminar">✕</button></div>
      <div class="pf-total">${money(total,"USD")}</div>
      <div class="pf-sub">Efectivo ${money(cash,"USD")} · ${(p.holdings||[]).length} activo(s)</div>
      ${P.executed?`<div class="pf-pnl ${cls}">${pct(P.pnlPct)} · ${P.pnl>=0?"+":""}${money(P.pnl,"USD")}</div>`:`<div class="pf-pnl" style="color:var(--faint)">Sin posiciones aún</div>`}
    </div>`));
  });
  box.append(grid);
}
async function renderPortfolioDetail(id){
  const box=$("#pfShell"); if(!box) return;
  const p=(state.cache.portfolios||[]).find(x=>x.id===id); if(!p){ renderPortfolioList(); return; }
  const holds=p.holdings||[];
  const tickers=[...new Set(holds.filter(h=>num(h.quantity)>0).map(h=>h.ticker))];
  const qr=await fetchQuotes(tickers); const quotes=qr.quotes||{};
  const P=perfOf(holds,quotes); const cash=num(p.cash)||0; const total=(P.value||0)+cash;
  const cls=P.executed?sgn(P.pnl):"";
  box.innerHTML=`
    <div class="flex between" style="margin-bottom:1rem;flex-wrap:wrap;gap:.6rem">
      <button class="btn btn-ghost btn-sm" style="width:auto" onclick="app.backToPortfolios()">← Mis portafolios</button>
      <div class="flex" style="gap:.4rem">
        <button class="btn btn-ghost btn-sm" style="width:auto" onclick="app.renamePortfolio('${p.id}')">Renombrar</button>
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.tradeInPortfolio('${p.id}')">Operar en este →</button>
      </div>
    </div>
    <div class="grid grid-3" style="margin-bottom:1.2rem">
      <div class="stat"><div class="k">Valor total</div><div class="v">${money(total,"USD")}</div><div class="d">efectivo + posiciones</div></div>
      <div class="stat"><div class="k">Efectivo</div><div class="v">${money(cash,"USD")}</div><div class="d">disponible para operar</div></div>
      <div class="stat"><div class="k">Rendimiento</div><div class="v ${cls}">${P.executed?pct(P.pnlPct):"—"}</div><div class="d ${cls}">${P.executed?(P.pnl>=0?"+":"")+money(P.pnl,"USD"):"sin posiciones"}</div></div>
    </div>`;
  const wrap=el(`<div class="pf-grid"></div>`);
  const actual=P.executed?actualWeights(P.rows,P.value):null;
  wrap.append(el(`<div class="card">
    <div class="flex between"><h3>${esc(p.name)}</h3><span class="pill pill-blue mono">USD</span></div>
    <p class="card-sub">${P.executed?"Distribución por clase de activo.":"Aún sin posiciones."}</p>
    ${P.executed?`<div class="flex" style="gap:1.6rem;align-items:center;flex-wrap:wrap">
      <div style="width:170px">${donut(actual)}</div>
      <div style="flex:1;min-width:220px">${allocBars(actual)}</div></div>`:
      `<p class="empty" style="padding:1rem">Compra tu primer activo desde "Operar" para ver la distribución.</p>`}
  </div>`));
  const side=el(`<div class="card"><h3>Posiciones</h3><p class="card-sub">${holds.length} instrumento(s).</p></div>`);
  if(holds.length){
    const tw=el(`<div class="tbl-wrap"></div>`);
    const t=el(`<table class="tbl"><thead><tr><th>Instrumento</th><th style="text-align:right">Precio</th><th style="text-align:right">Valor</th><th style="text-align:right">P&L</th></tr></thead><tbody></tbody></table>`);
    P.rows.forEach(h=>{
      const c=CLASSES[h.asset_class]||{label:h.asset_class||"—",color:"#888"};
      $("tbody",t).append(el(`<tr>
        <td><b>${esc(h.name||h.ticker)}</b> <span class="mono" style="color:var(--faint)">${esc(h.ticker)}</span><br><span class="pill mono" style="font-size:.66rem;background:${c.color}22;color:${c.color}">${esc(c.label)}</span></td>
        <td style="text-align:right" class="mono">${h.price!=null?money(h.price,"USD"):"—"}<br><span style="font-size:.68rem;color:var(--faint)">${num(h.quantity)} u</span></td>
        <td style="text-align:right" class="mono">${h.value!=null?money(h.value,"USD"):"—"}</td>
        <td style="text-align:right" class="mono ${h.pnl!=null?sgn(h.pnl):""}">${h.pnlPct!=null?pct(h.pnlPct):"—"}<br><span style="font-size:.68rem">${h.pnl!=null?(h.pnl>=0?"+":"")+money(h.pnl,"USD"):""}</span></td></tr>`));
    });
    tw.append(t); side.append(tw);
  } else side.append(el(`<p class="empty" style="padding:1rem">Sin posiciones. Ve a "Operar" para comprar.</p>`));
  wrap.append(side); box.append(wrap);
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
      ${simSlider("mu","Retorno esperado anual",(s.mu*100).toFixed(1),0,30,.5,"%")}
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
    const g=el(`<div class="grid grid-2" style="margin-bottom:1.8rem"></div>`);
    ideas.forEach(p=>g.append(ideaCard(p))); m.append(g);
  }
  if(news.length){
    m.append(el(`<div class="nav-label" style="padding-left:0">Noticias del mercado</div>`));
    const g=el(`<div class="grid grid-2"></div>`);
    news.forEach(p=>g.append(newsCard(p))); m.append(g);
  }
}
/* ============================================================
   Imágenes (Supabase Storage · bucket "media")
   ============================================================ */
const MAX_IMG = 5 * 1024 * 1024;
function imagePicker(id,initUrl){
  const has=!!initUrl;
  return `<div class="imgpick" id="wrap_${id}">
    <div class="imgpick-preview ${has?"has":""}" id="prev_${id}">${has?`<img src="${esc(initUrl)}" alt="">`:'<span>Sin imagen</span>'}</div>
    <div class="imgpick-ctrl">
      <label class="btn btn-ghost btn-sm" style="cursor:pointer">Subir imagen
        <input type="file" accept="image/*" hidden onchange="app.pickImage('${id}',this)"></label>
      <button type="button" class="btn btn-ghost btn-sm" onclick="app.clearImage('${id}')">Quitar</button>
      <input class="input mono" id="url_${id}" value="${esc(initUrl||"")}" placeholder="…o pega una URL de imagen"
        oninput="app.previewImage('${id}',this.value)">
      <span class="imgpick-hint">JPG, PNG, WebP o GIF · máx. 5 MB</span>
    </div></div>`;
}
async function uploadImage(file,folder){
  if(!file.type.startsWith("image/")) throw new Error("El archivo no es una imagen.");
  if(file.size>MAX_IMG) throw new Error("La imagen supera los 5 MB.");
  const ext=(file.name.split(".").pop()||"jpg").toLowerCase();
  const path=`${folder}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error }=await sb.storage.from("media").upload(path,file,{ cacheControl:"3600", upsert:false });
  if(error) throw new Error(error.message);
  return sb.storage.from("media").getPublicUrl(path).data.publicUrl;
}

async function uploadFile(file){
  const isImg=file.type.startsWith("image/"), isPdf=file.type==="application/pdf";
  if(!isImg&&!isPdf) throw new Error("Solo se permiten PDF o imágenes.");
  if(file.size>15*1024*1024) throw new Error("El archivo supera los 15 MB.");
  const ext=(file.name.split(".").pop()||"bin").toLowerCase();
  const path=`materials/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error }=await sb.storage.from("media").upload(path,file,{ cacheControl:"3600", upsert:false });
  if(error) throw new Error(error.message);
  return { name:file.name, url:sb.storage.from("media").getPublicUrl(path).data.publicUrl, kind:isPdf?"pdf":"img" };
}

async function uploadAny(file){
  if(file.size>15*1024*1024) throw new Error("El archivo supera los 15 MB.");
  const ext=(file.name.split(".").pop()||"bin").toLowerCase();
  const path=`submissions/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error }=await sb.storage.from("media").upload(path,file,{ cacheControl:"3600", upsert:false });
  if(error) throw new Error(error.message);
  return { name:file.name, url:sb.storage.from("media").getPublicUrl(path).data.publicUrl };
}
/* ============================================================
   CLIENTE · Mercado e ideas
   ============================================================ */
function cover(url,alt,fallbackText,accent="var(--blue-500)"){
  if(url) return `<div class="cover"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy"
    onerror="this.parentNode.classList.add('ph');this.remove()"></div>`;
  return `<div class="cover ph" style="--accent:${accent}"><span>${esc(fallbackText||"")}</span></div>`;
}
function ideaCard(p){
  const dirColor={compra:"var(--ok)",venta:"var(--bad)",mantener:"var(--warn)"}[p.direction]||"var(--muted)";
  return el(`<div class="card idea media-card">
    ${cover(p.image_url,p.title,p.ticker||"IDEA",dirColor)}
    <div class="media-body">
      <div class="flex between">
        <div class="flex" style="gap:.5rem">
          <span class="mono ticker">${esc(p.ticker||"—")}</span>
          <span class="pill" style="color:${dirColor};text-transform:capitalize">${esc(p.direction||"idea")}</span>
        </div>
        <span class="pill ${p.status==="abierta"?"pill-ok":""} dot" style="${p.status!=="abierta"?"color:var(--faint)":""}">${esc(p.status||"abierta")}</span>
      </div>
      <h3 style="margin:.7rem 0 .3rem">${esc(p.title)}</h3>
      <p class="card-sub" style="margin-bottom:.8rem">${esc(p.body||"")}</p>
      <div class="flex" style="gap:1.4rem;font-size:.82rem;flex-wrap:wrap">
        ${p.target_price?`<div><div class="k-mini">Precio objetivo</div><b class="mono">${money(p.target_price,"USD")}</b></div>`:""}
        ${p.horizon?`<div><div class="k-mini">Horizonte</div><b>${esc(p.horizon)}</b></div>`:""}
        <div><div class="k-mini">Publicada</div><b class="mono">${fmtDate(p.created_at)}</b></div>
      </div>
      ${p.potential?`<div class="potential-box"><div class="k-mini" style="color:var(--gold)">Potencial de crecimiento / rentabilidad</div><p>${esc(p.potential)}</p></div>`:""}
      ${p.source_url?`<a class="btn btn-ghost btn-sm mt" href="${esc(p.source_url)}" target="_blank" rel="noopener">Ver fuente</a>`:""}
    </div></div>`);
}
function newsCard(p){
  return el(`<div class="card media-card">
    ${cover(p.image_url,p.title,"NOTICIA","var(--blue-400)")}
    <div class="media-body">
      <div class="k-mini">${fmtDate(p.created_at)}</div>
      <h3 style="margin:.35rem 0 .4rem;font-size:1rem">${esc(p.title)}</h3>
      <p class="card-sub" style="margin:0">${esc(p.body||"")}</p>
      ${p.source_url?`<a class="mt" style="display:inline-block;font-size:.82rem" href="${esc(p.source_url)}" target="_blank" rel="noopener">Leer fuente →</a>`:""}
    </div></div>`);
}
function courseCard(c){
  return el(`<div class="card media-card">
    ${cover(c.image_url,c.title,"CURSO","var(--risk-1)")}
    <div class="media-body">
      <span class="pill pill-blue">${esc(c.level||"Curso")}</span>
      <h3 style="margin:.6rem 0 .3rem;font-size:1rem">${esc(c.title)}</h3>
      <p class="card-sub">${esc(c.description||"")}</p>
      ${c.url?`<a class="btn btn-ghost btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener">Abrir curso</a>`:""}
    </div></div>`);
}

/* ============================================================
   CLIENTE · Cursos / Calendario / Mensajes
   ============================================================ */
/* Mapa de cursos tipo red neuronal: capas por nivel, cursos como neuronas */
const CMAP_LAYERS=["Básico","Intermedio","Avanzado"];
const CMAP_COL={"Básico":"#4FA3FF","Intermedio":"#F5C451","Avanzado":"#3DD6A0"};
/* ===================== Mapa tipo malla (estilo Camino Quant) ===================== */
const MCATS = {
  fund:{n:"Fundamentos & mercados",c:"#59b6a6"}, econ:{n:"Economía",c:"#7f9cc9"},
  rv:{n:"Renta variable & análisis",c:"#cba24a"}, rf:{n:"Renta fija",c:"#c8955a"},
  mp:{n:"Materias primas",c:"#c98a4a"}, alt:{n:"Alternativos & macro",c:"#9d7bc0"},
  risk:{n:"Gestión del riesgo",c:"#c96a6a"}, deriv:{n:"Derivados & opciones",c:"#e0894f"},
  hedge:{n:"Coberturas & ingeniería de precio",c:"#d76a9c"}, quant:{n:"Núcleo cuantitativo",c:"#6a86d8"}
};
const MLEVELS = ["Básico","Intermedio","Avanzado","Quant Financiero"];
function levelIdx(lv){ return ({ "Básico":0,"Intermedio":1,"Avanzado":2 })[lv] ?? 0; }
function mwrap(t,max){ const w=(t||"").split(" "),out=[]; let cur="";
  for(const word of w){ if((cur+" "+word).trim().length>max){out.push(cur.trim());cur=word;} else cur+=" "+word; }
  if(cur.trim())out.push(cur.trim()); return out.slice(0,3); }

function buildMalla(host, cs, done){
  const NS="http://www.w3.org/2000/svg";
  host.innerHTML=`
    <div class="malla-title"><h1>Malla del inversor</h1><p>De <b>Básico</b> a <span class="mgoal">Quant Financiero</span> · cada curso abre el siguiente.</p></div>
    <div class="malla-controls"><button data-z="in" title="Acercar">+</button><button data-z="out" title="Alejar">−</button><button data-z="fit" title="Reencuadrar">⤢</button></div>
    <div class="malla-legend min"><div class="mlh"><span>Áreas</span><button class="mleg-btn" title="Mostrar áreas">+</button></div><div class="mlrows"></div></div>
    <div class="malla-hint">Arrastra para mover · rueda o pellizca para zoom · toca un curso</div>
    <svg class="malla-svg"><defs>
      <marker id="mArrow" markerWidth="10" markerHeight="10" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="rgba(203,162,74,.7)"/></marker>
      <filter id="mGlow" x="-120%" y="-120%" width="340%" height="340%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs><g class="malla-vp"></g></svg>
    <aside class="malla-panel"><button class="malla-close">×</button><div class="malla-pinner"></div></aside>`;
  const svg=host.querySelector(".malla-svg"), vp=host.querySelector(".malla-vp");
  const panel=host.querySelector(".malla-panel"), pinner=host.querySelector(".malla-pinner");
  const E=(tag,attrs)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e;};

  // datos
  const nodes=cs.map(c=>({ id:c.id, lvl:levelIdx(c.level), cat:MCATS[c.category]?c.category:"fund",
    t:c.title||"Curso", d:c.description||"", modules:Array.isArray(c.modules)?c.modules:[],
    premium:!!c.premium, done:done.has(c.id), next:(Array.isArray(c.next_courses)?c.next_courses:[]) }));
  const idset=new Set(nodes.map(n=>n.id));
  const apex={id:"__apex__",lvl:3,t:"Quant Financiero",apex:true,cat:"quant"}; nodes.push(apex);
  const byId=Object.fromEntries(nodes.map(n=>[n.id,n]));
  const edges=[];
  cs.forEach(c=>{ const nx=(c.next_courses||[]).filter(t=>idset.has(t));
    if(nx.length) nx.forEach(t=>edges.push([c.id,t])); else edges.push([c.id,"__apex__"]); });
  const out={}; nodes.forEach(n=>out[n.id]=[]); edges.forEach(([a,b])=>out[a].push(b));

  // layout
  const COLX=[40,430,840,1300], NW=210, APEXW=250, GAP=26;
  nodes.forEach(n=>{ n.lines=mwrap(n.t,n.apex?18:24); n.w=n.apex?APEXW:NW; n.h=(n.apex?46:26)+n.lines.length*(n.apex?20:15); });
  let CH=0;
  for(let L=0;L<4;L++){ const col=nodes.filter(n=>n.lvl===L); const tot=col.reduce((a,n)=>a+n.h,0)+GAP*Math.max(0,col.length-1); CH=Math.max(CH,tot); }
  CH+=150;
  for(let L=0;L<4;L++){ const col=nodes.filter(n=>n.lvl===L); const tot=col.reduce((a,n)=>a+n.h,0)+GAP*Math.max(0,col.length-1); let y=(CH-tot)/2; col.forEach(n=>{ n.x=COLX[L]+(L===3?-(APEXW-NW)/2:0); n.y=y; y+=n.h+GAP; }); }
  const CW=COLX[3]+APEXW+60;

  // bandas de nivel
  MLEVELS.forEach((name,L)=>{
    const cx=COLX[L]+(L===3?APEXW:NW)/2+(L===3?-(APEXW-NW)/2:0);
    const k=E("text",{x:cx,y:40,"text-anchor":"middle",class:"mband-key"}); k.textContent=(L===3?"OBJETIVO":"NIVEL "+(L+1)); vp.appendChild(k);
    const b=E("text",{x:cx,y:70,"text-anchor":"middle",class:"mband"}); b.textContent=name; vp.appendChild(b);
  });

  // aristas + señales
  const edgeEls={};
  edges.forEach(([a,b],i)=>{
    const s=byId[a],t=byId[b]; if(!s||!t) return;
    const x1=s.x+s.w,y1=s.y+s.h/2,x2=t.x,y2=t.y+t.h/2; const dx=Math.max(40,(x2-x1)*0.5);
    const d=`M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
    const pid="me"+i;
    const p=E("path",{id:pid,class:"medge",d,"marker-end":"url(#mArrow)"}); vp.appendChild(p); edgeEls[a+">"+b]=p;
    const sig=E("circle",{r:2.6,fill:MCATS[s.cat]?MCATS[s.cat].c:"#cba24a",filter:"url(#mGlow)",class:"msignal"});
    const am=E("animateMotion",{dur:(2.6+Math.random()*1.8).toFixed(2)+"s",begin:(Math.random()*2.6).toFixed(2)+"s",repeatCount:"indefinite"});
    const mp=E("mpath",{}); mp.setAttribute("href","#"+pid); mp.setAttributeNS("http://www.w3.org/1999/xlink","href","#"+pid);
    am.appendChild(mp); sig.appendChild(am); vp.appendChild(sig);
  });

  // nodos
  const nodeEls={};
  nodes.forEach(n=>{
    const g=E("g",{class:"mnode"+(n.apex?" apex":""),transform:`translate(${n.x},${n.y})`});
    g.appendChild(E("rect",{class:"mbox",x:0,y:0,width:n.w,height:n.h,rx:12}));
    g.appendChild(E("rect",{class:"maccent",x:0,y:8,width:5,height:n.h-16,rx:2,fill:MCATS[n.cat]?MCATS[n.cat].c:"#59b6a6"}));
    if(!n.apex){ const lv=E("text",{class:"mlvl",x:18,y:18,fill:MCATS[n.cat]?MCATS[n.cat].c:"#94A8C7"}); lv.textContent=MCATS[n.cat].n; g.appendChild(lv); }
    const startY=n.apex? n.h/2-(n.lines.length-1)*11 : 34;
    n.lines.forEach((ln,i)=>{ const t=E("text",{class:"mt",x:n.apex?n.w/2:16,y:startY+i*(n.apex?20:15),"text-anchor":n.apex?"middle":"start"}); t.textContent=ln; g.appendChild(t); });
    if(n.done){ g.appendChild(E("circle",{class:"mdone-bg",cx:n.w-14,cy:14,r:8}));
      const ck=E("text",{class:"mdone-ck",x:n.w-14,y:17.5,"text-anchor":"middle"}); ck.textContent="✓"; g.appendChild(ck); }
    else if(n.premium){ const lk=E("text",{class:"mprem",x:n.w-14,y:18,"text-anchor":"middle"}); lk.textContent="🔒"; g.appendChild(lk); }
    g.addEventListener("click",e=>{ e.stopPropagation(); if(moved)return; select(n.id); });
    vp.appendChild(g); nodeEls[n.id]=g;
  });

  // interacción pan/zoom
  let tx=0,ty=0,scale=1;
  const apply=()=>vp.setAttribute("transform",`translate(${tx},${ty}) scale(${scale})`);
  function fit(){ const r=svg.getBoundingClientRect(); const s=Math.min(r.width/CW,r.height/CH)*0.97;
    scale=s; tx=(r.width-CW*s)/2; ty=(r.height-CH*s)/2; apply(); }
  let drag=false,px,py,moved=false;
  svg.addEventListener("pointerdown",e=>{drag=true;moved=false;px=e.clientX;py=e.clientY;svg.classList.add("grabbing");});
  svg.addEventListener("pointermove",e=>{if(!drag)return;const dx=e.clientX-px,dy=e.clientY-py;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;tx+=dx;ty+=dy;px=e.clientX;py=e.clientY;apply();});
  addEventListener("pointerup",()=>{drag=false;svg.classList.remove("grabbing");});
  svg.addEventListener("click",()=>{ if(!moved) deselect(); });
  svg.addEventListener("wheel",e=>{ e.preventDefault(); const r=svg.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    const f=e.deltaY<0?1.12:0.89, ns=Math.max(0.2,Math.min(3,scale*f)); tx=mx-(mx-tx)*(ns/scale); ty=my-(my-ty)*(ns/scale); scale=ns; apply(); },{passive:false});
  // pinch móvil
  let pts=new Map(), pd0=0, ps0=1;
  svg.addEventListener("pointerdown",e=>pts.set(e.pointerId,e));
  svg.addEventListener("pointermove",e=>{ if(!pts.has(e.pointerId))return; pts.set(e.pointerId,e);
    if(pts.size===2){ drag=false; const [a,b]=[...pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      if(!pd0){pd0=d;ps0=scale;} else { scale=Math.max(0.2,Math.min(3,ps0*d/pd0)); apply(); } } });
  const clr=e=>{ pts.delete(e.pointerId); if(pts.size<2) pd0=0; }; addEventListener("pointerup",clr); addEventListener("pointercancel",clr);
  host.querySelector('[data-z="in"]').onclick=()=>{ const r=svg.getBoundingClientRect(),mx=r.width/2,my=r.height/2,ns=Math.min(3,scale*1.2); tx=mx-(mx-tx)*(ns/scale);ty=my-(my-ty)*(ns/scale);scale=ns;apply(); };
  host.querySelector('[data-z="out"]').onclick=()=>{ const r=svg.getBoundingClientRect(),mx=r.width/2,my=r.height/2,ns=Math.max(0.2,scale/1.2); tx=mx-(mx-tx)*(ns/scale);ty=my-(my-ty)*(ns/scale);scale=ns;apply(); };
  host.querySelector('[data-z="fit"]').onclick=fit;

  // panel
  function deselect(){ panel.classList.remove("open"); Object.values(nodeEls).forEach(g=>g.classList.remove("dim","hl")); Object.values(edgeEls).forEach(p=>p.classList.remove("dim","up")); }
  function select(id){
    const n=byId[id]; if(!n) return; const targets=out[id]||[]; const keep=new Set([id,...targets]);
    Object.entries(nodeEls).forEach(([k,g])=>{ g.classList.toggle("dim",!keep.has(k)); g.classList.toggle("hl",k===id); });
    Object.entries(edgeEls).forEach(([k,p])=>{ const on=targets.some(t=>k===id+">"+t); p.classList.toggle("up",on); p.classList.toggle("dim",!on); });
    if(n.apex){ pinner.innerHTML=`<div class="mkicker" style="color:var(--gold)">Meta final</div><h2>Quant Financiero</h2>
      <div class="mdesc">Has recorrido toda la malla, del primer concepto de inversión hasta el núcleo cuantitativo. Aquí termina el camino del inversor. 🎓</div>`;
      panel.classList.add("open"); return; }
    const locked = n.premium && !(state.profile.role==="admin"||state.profile.premium_courses);
    const nx=targets.filter(t=>t!=="__apex__");
    pinner.innerHTML=`
      <div class="mkicker" style="color:${MCATS[n.cat].c}">${MLEVELS[n.lvl]} · ${MCATS[n.cat].n}</div>
      <h2>${esc(n.t)}</h2>
      <div class="mchips">${n.done?'<span class="mchip done">✓ Completado</span>':""}${n.premium?'<span class="mchip prem">PREMIUM</span>':""}</div>
      <div class="mdesc">${esc(n.d||"Sin descripción.")}</div>
      ${n.modules.length?`<div class="msec">Módulos del curso</div><ul>${n.modules.map((mo,i)=>`<li class="mtopic">${esc(mo.title||("Módulo "+(i+1)))}</li>`).join("")}</ul>`:""}
      ${locked?`<div class="malla-lock">🔒 Curso premium. Pídele acceso a tu asesor para desbloquearlo.</div>`
        :`<button class="malla-enter" onclick="app.openCourse('${n.id}')">Entrar al curso →</button>`}
      ${nx.length?`<div class="msec">Continúa con</div>${nx.map(t=>`<button class="munlock" data-go="${t}">→ <b>${esc(byId[t].t)}</b></button>`).join("")}`
        :`<div class="msec">Siguiente</div><button class="munlock" data-go="__apex__">→ <b>Quant Financiero</b> · meta final</button>`}`;
    pinner.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>select(b.getAttribute("data-go")));
    panel.classList.add("open");
  }
  host.querySelector(".malla-close").onclick=deselect;
  host.querySelector(".mlrows").innerHTML=Object.values(MCATS).map(c=>`<div class="mlrow"><span class="msw" style="background:${c.c}"></span>${c.n}</div>`).join("");
  const _lg=host.querySelector(".malla-legend"),_lb=host.querySelector(".mleg-btn");
  if(_lb) _lb.onclick=()=>{ _lg.classList.toggle("min"); _lb.textContent=_lg.classList.contains("min")?"+":"–"; };
  requestAnimationFrame(fit);
}

function coursesNeuralMap(cs, done){
  done = done || new Set();
  const buckets=CMAP_LAYERS.map(L=>cs.filter(c=>(c.level||"Básico")===L));
  cs.forEach(c=>{ if(!CMAP_LAYERS.includes(c.level||"Básico")) buckets[0].push(c); });
  const layers=CMAP_LAYERS.map((L,i)=>({label:L,items:buckets[i]})).filter(l=>l.items.length);
  const nL=layers.length;
  const W=1000, top=96, botPad=40;
  const maxN=Math.max(...layers.map(l=>l.items.length),1);
  const H=Math.max(380, maxN*104+top+botPad);
  const xs=nL===1?[500]:layers.map((_,i)=>150+i*(700/(nL-1)));
  const P={}; const flat=[]; let nodes="";
  layers.forEach((l,li)=>{
    const n=l.items.length;
    l.items.forEach((c,ci)=>{
      const x=xs[li], y=top+(ci+0.5)*((H-top-botPad)/n);
      P[c.id]={x,y};
      const col=CMAP_COL[l.label], title=c.title||"Curso";
      const short=title.length>22?title.slice(0,21)+"…":title;
      const i=flat.length; flat.push(c);
      const isDone=done.has(c.id);
      nodes+=`<g class="cmap-node${c.premium?" prem":""}${isDone?" done":""}" data-i="${i}" style="--col:${col}" tabindex="0" role="button" aria-label="${esc(title)}${c.premium?" (premium)":""}${isDone?" (completado)":""}">
        <circle class="halo" cx="${x}" cy="${y}" r="26"/>
        ${c.premium?`<circle class="prem-ring" cx="${x}" cy="${y}" r="19"/>`:""}
        <circle class="core" cx="${x}" cy="${y}" r="13"/>
        ${isDone?`<g class="cmap-done"><circle cx="${x+14}" cy="${y-14}" r="7.5"/><text x="${x+14}" y="${y-10.7}">✓</text></g>`:""}
        <text x="${x}" y="${y+40}" text-anchor="middle" class="cmap-label">${esc(short)}</text></g>`;
    });
  });
  // aristas manuales (continuaciones) con flecha direccional + señal que viaja
  let edges="", signals=""; let ei=0;
  cs.forEach(c=>{
    const a=P[c.id]; if(!a) return;
    const col=CMAP_COL[(c.level&&CMAP_LAYERS.includes(c.level))?c.level:"Básico"];
    (Array.isArray(c.next_courses)?c.next_courses:[]).forEach(tid=>{
      const b=P[tid]; if(!b||tid===c.id) return;
      const ang=Math.atan2(b.y-a.y,b.x-a.x);
      const sx=a.x+Math.cos(ang)*15, sy=a.y+Math.sin(ang)*15;
      const ex=b.x-Math.cos(ang)*19, ey=b.y-Math.sin(ang)*19;
      let d;
      if(Math.abs(b.x-a.x)<1){ const s=b.y>a.y?1:-1; d=`M${sx} ${sy} C ${sx+80} ${sy+18*s}, ${ex+80} ${ey-18*s}, ${ex} ${ey}`; }
      else { const dx=(ex-sx)*0.45; d=`M${sx} ${sy} C ${sx+dx} ${sy}, ${ex-dx} ${ey}, ${ex} ${ey}`; }
      const id=`ce${ei++}`;
      edges+=`<path id="${id}" class="cmap-edge" d="${d}" marker-end="url(#cmapArrow)"/>`;
      // partícula viajando por la conexión (efecto red neuronal viva)
      signals+=`<circle r="3" fill="${col}" opacity=".9" filter="url(#cmapGlow)">
        <animateMotion dur="${(2.4+Math.random()*1.6).toFixed(2)}s" begin="${(Math.random()*2.4).toFixed(2)}s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
          <mpath href="#${id}" xlink:href="#${id}"/></animateMotion>
        <animate attributeName="opacity" values="0;.95;.95;0" keyTimes="0;.15;.85;1" dur="${(2.4+Math.random()*1.6).toFixed(2)}s" begin="${(Math.random()*2.4).toFixed(2)}s" repeatCount="indefinite"/>
      </circle>`;
    });
  });
  let heads="";
  layers.forEach((l,li)=>{ heads+=`<text x="${xs[li]}" y="46" text-anchor="middle" class="cmap-head" fill="${CMAP_COL[l.label]}">${l.label.toUpperCase()}</text>
    <line x1="${xs[li]-70}" y1="60" x2="${xs[li]+70}" y2="60" stroke="${CMAP_COL[l.label]}" stroke-opacity=".3"/>`; });
  const defs=`<defs>
    <marker id="cmapArrow" markerWidth="12" markerHeight="12" refX="8.5" refY="5" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="rgba(180,205,245,.9)"/></marker>
    <filter id="cmapGlow" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;
  return {svg:`<svg viewBox="0 0 ${W} ${H}" class="cmap-svg" preserveAspectRatio="xMidYMid meet" style="min-width:${Math.max(680,nL*260)}px">${defs}<g class="cmap-edges">${edges}</g><g class="cmap-signals">${signals}</g>${heads}${nodes}</svg>`, flat};
}

function modId(){ return "m"+Math.random().toString(36).slice(2,9); }
function ytEmbed(url){
  if(!url) return "";
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  const id = m ? m[1] : "";
  if(!id) return "";
  return `<iframe src="https://www.youtube.com/embed/${id}" title="Video del curso" loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
}

function subFileLink(sub){
  return (sub&&sub.file_url) ? `<a class="mat-dl-item" href="${esc(sub.file_url)}" target="_blank" rel="noopener"><span class="mat-ic">📎</span><span class="mat-name">${esc(sub.file_name||"archivo adjunto")}</span><span class="mat-dl-go">Ver ↗</span></a>` : "";
}
function subFormHtml(sub, courseId){
  return `<div class="sub-form">
    <textarea id="subText" class="input" placeholder="Escribe tu respuesta…">${sub?esc(sub.text||""):""}</textarea>
    <div class="flex" style="gap:.6rem;align-items:center;flex-wrap:wrap;margin-top:.5rem">
      <label class="btn btn-ghost btn-sm" style="cursor:pointer;width:auto">Adjuntar archivo
        <input type="file" id="subFile" hidden onchange="app.subFilePicked(this)"></label>
      <span id="subFileName" class="sub-filename">${sub&&sub.file_name?esc(sub.file_name):"Ningún archivo nuevo"}</span>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-left:auto" onclick="app.submitAssignment('${courseId}')">Entregar tarea</button>
    </div></div>`;
}
function subStateHtml(sub, courseId){
  const graded = sub.status==="graded";
  return `<div class="sub-state">
    ${graded
      ? `<div class="sub-grade">Calificación: <b>${sub.grade!=null?sub.grade:"—"}</b></div>
         ${sub.feedback?`<div class="sub-fb"><b>Retroalimentación del asesor:</b><br>${esc(sub.feedback)}</div>`:""}`
      : `<div class="sub-pending">⏳ Tu entrega fue enviada y está en revisión.</div>`}
    <div class="sub-mine">
      ${sub.text?`<p class="sub-text">${esc(sub.text)}</p>`:""}
      ${subFileLink(sub)}
    </div>
    <button class="btn btn-ghost btn-sm" style="width:auto;margin-top:.6rem" onclick="app.editSubmission('${courseId}')">Volver a entregar</button>
  </div>`;
}
function taskBodyHtml(sub, courseId){ return sub ? subStateHtml(sub,courseId) : subFormHtml(null,courseId); }

async function saveProgress(courseId, patch){
  const row={ user_id:state.profile.id, course_id:courseId, updated_at:new Date().toISOString(), ...patch };
  return sb.from("course_progress").upsert(row, { onConflict:"user_id,course_id" });
}

async function viewCourseSubmissions(courseId){
  const m=$("#main");
  const c=await sb.from("courses").select("id,title,assignment").eq("id",courseId).single().then(r=>r.data);
  m.innerHTML=head("Formación", c?esc(c.title):"Entregas", "Tareas entregadas por los clientes");
  m.append(el(`<button class="btn btn-ghost btn-sm" style="width:auto" onclick="location.hash='#/cursos'">← Volver a cursos</button>`));
  if(!c){ return; }
  if(c.assignment) m.append(el(`<div class="card" style="margin-top:1rem"><h3>Consigna</h3><p class="course-desc" style="margin:0">${esc(c.assignment)}</p></div>`));
  const subs=await sb.from("course_submissions").select("*").eq("course_id",courseId).order("submitted_at",{ascending:false}).then(r=>r.data||[]);
  if(!subs.length){ m.append(el(`<div class="card empty" style="margin-top:1rem"><p>Aún no hay entregas para este curso.</p></div>`)); return; }
  // nombres de los clientes
  const ids=[...new Set(subs.map(s=>s.user_id))];
  const profs=await sb.from("profiles").select("id,full_name,email").in("id",ids).then(r=>r.data||[]);
  const nameOf=(uid)=>{ const p=profs.find(x=>x.id===uid); return p?(p.full_name||p.email||"Cliente"):"Cliente"; };
  const wrap=el(`<div class="subs-list" style="margin-top:1rem"></div>`);
  subs.forEach(s=>{
    wrap.append(el(`<div class="card sub-card">
      <div class="flex between" style="flex-wrap:wrap;gap:.4rem">
        <b>${esc(nameOf(s.user_id))}</b>
        <span class="pill ${s.status==="graded"?"pill-done":"pill-blue"}">${s.status==="graded"?"Calificada":"Por revisar"}</span>
      </div>
      <span class="card-sub" style="display:block;margin:.2rem 0 .6rem">Entregada: ${new Date(s.submitted_at).toLocaleString("es")}</span>
      ${s.text?`<p class="sub-text">${esc(s.text)}</p>`:""}
      ${subFileLink(s)}
      <div class="divide"></div>
      <div class="flex" style="gap:.8rem;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="width:130px"><label>Calificación</label><input class="input" id="grade_${s.id}" value="${s.grade!=null?s.grade:""}" placeholder="0-100"></div>
        <div class="field" style="flex:1;min-width:220px"><label>Retroalimentación</label><textarea class="input" id="fb_${s.id}" placeholder="Comentario para el cliente…">${esc(s.feedback||"")}</textarea></div>
      </div>
      <button class="btn btn-primary btn-sm" style="width:auto;margin-top:.5rem" onclick="app.gradeSubmission('${s.id}','${courseId}')">Guardar calificación</button>
    </div>`));
  });
  m.append(wrap);
}

async function viewCourseDetail(id){
  const cache=state.cache.cmapCourses||[];
  const c = cache.find(x=>x.id===id) || await sb.from("courses").select("*").eq("id",id).single().then(r=>r.data);
  const m=$("#main");
  if(!c){ m.innerHTML=head("Formación","Curso","No encontrado"); m.append(el(`<button class="btn btn-ghost btn-sm" style="width:auto" onclick="location.hash='#/cursos'">← Volver al mapa</button>`)); return; }
  state.cache.currentCourse=c;
  const locked = c.premium && !(state.profile.role==="admin" || state.profile.premium_courses);
  if(locked){ m.innerHTML=head("Formación",esc(c.title),"Premium");
    m.append(el(`<button class="btn btn-ghost btn-sm" style="width:auto" onclick="location.hash='#/cursos'">← Volver al mapa</button>
      <div class="card empty" style="margin-top:1rem"><div class="lock-note" style="margin:0">🔒 Este es un curso premium. Pídele acceso a tu asesor para desbloquearlo.</div></div>`)); return; }
  const pr = await sb.from("course_progress").select("*").eq("user_id",state.profile.id).eq("course_id",id).maybeSingle().then(r=>r.data);
  const sub = c.assignment ? await sb.from("course_submissions").select("*").eq("user_id",state.profile.id).eq("course_id",id).maybeSingle().then(r=>r.data) : null;
  state.cache.currentSub=sub;
  let modules=Array.isArray(c.modules)?c.modules:[];
  if(!modules.length && (c.video_url || (Array.isArray(c.materials)&&c.materials.length)))
    modules=[{id:"legacy", title:"Lección", description:"", video_url:c.video_url||"", materials:Array.isArray(c.materials)?c.materials:[]}];
  const keep = (state.cache.cd && state.cache.cd.c && state.cache.cd.c.id===id) ? state.cache.courseSel : null;
  const cd={ c, modules, exam:Array.isArray(c.exam)?c.exam:[], sub,
    prExamScore: pr?.exam_score!=null?pr.exam_score:null,
    modsDone: Array.isArray(pr?.modules_done)?[...pr.modules_done]:[], completed: !!pr?.completed };
  state.cache.cd=cd;
  if(keep) state.cache.courseSel=keep;
  else { const fu=modules.findIndex(mo=>!cd.modsDone.includes(mo.id)); state.cache.courseSel={type:"module",idx:fu<0?0:fu}; }
  renderCourse();
}

function courseAllDone(cd){ return cd.modules.length>0 && cd.modules.every(mo=>cd.modsDone.includes(mo.id)); }

function renderCourse(){
  const cd=state.cache.cd; if(!cd) return;
  const m=$("#main"); const sel=state.cache.courseSel;
  const doneChip = cd.completed ? `<span class="pill pill-done">✓ Completado</span>` : "";
  m.innerHTML=head("Formación",esc(cd.c.title||"Curso"),esc(cd.c.level||""));
  m.append(el(`<div class="course-wrap">
    <div class="course-top">
      <button class="btn btn-ghost btn-sm" style="width:auto" onclick="location.hash='#/cursos'">← Volver al mapa</button>
      <div class="flex" style="gap:.4rem;align-items:center">${doneChip}${cd.c.premium?'<span class="pill pill-premium">PREMIUM</span>':""}<span class="pill pill-blue">${esc(cd.c.level||"")}</span></div>
    </div>
    <div class="course-layout">
      <div class="course-main" id="coursePane">${coursePane(cd,sel)}</div>
      <aside class="course-curriculum card" id="courseCurriculum">${renderCurriculum(cd)}</aside>
    </div>
  </div>`));
}

function coursePane(cd,sel){
  if(sel.type==="exam") return coursePaneExam(cd);
  if(sel.type==="task") return coursePaneTask(cd);
  return coursePaneModule(cd, sel.idx||0);
}

function coursePaneModule(cd, idx){
  const mo=cd.modules[idx]; if(!mo) return `<div class="card empty"><p>Este curso todavía no tiene módulos.</p></div>`;
  const done=cd.modsDone.includes(mo.id); const yt=ytEmbed(mo.video_url);
  const mats=Array.isArray(mo.materials)?mo.materials:[]; const last=idx===cd.modules.length-1;
  const nextLabel = done ? (last?"Módulo completado":"Siguiente módulo →") : (last?"Completar módulo ✓":"Completar y continuar →");
  return `${yt?`<div class="course-video">${yt}</div>`:`<div class="course-video course-video--empty"><span>Este módulo no tiene video</span></div>`}
    <div class="pane-body">
      <h2 class="pane-title">${done?'<span class="mod-check">✓</span> ':""}Módulo ${idx+1}${mo.title?" · "+esc(mo.title):""}</h2>
      ${mo.description?`<p class="course-desc">${esc(mo.description)}</p>`:""}
      ${mats.length?`<div class="pane-mats"><h4>Materiales del módulo</h4><div class="mat-dl">${mats.map(mt=>`<a class="mat-dl-item" href="${esc(mt.url)}" target="_blank" rel="noopener"><span class="mat-ic">${mt.kind==="pdf"?"📄":"🖼️"}</span><span class="mat-name">${esc(mt.name||"archivo")}</span><span class="mat-dl-go">Descargar ↓</span></a>`).join("")}</div></div>`:""}
      <div class="pane-nav">
        <button class="btn btn-ghost btn-sm" style="width:auto" ${idx===0?"disabled":""} onclick="app.courseGo(${idx-1})">← Anterior</button>
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.completeAndNext(${idx})">${nextLabel}</button>
      </div>
    </div>`;
}

function coursePaneExam(cd){
  const exam=cd.exam;
  return `<div class="pane-body">
    <h2 class="pane-title">Examen final</h2>
    <p class="card-sub">${exam.length} pregunta${exam.length>1?"s":""} · opción múltiple · apruebas con 60%.${cd.prExamScore!=null?` Tu última nota: <b style="color:${cd.prExamScore>=60?"#3DD6A0":"var(--gold)"}">${Math.round(cd.prExamScore)}%</b>.`:""}</p>
    <div id="examBody"></div>
    <button class="btn btn-primary btn-sm" id="examStartBtn" style="width:auto" onclick="app.startExam('${cd.c.id}')">${cd.prExamScore!=null?"Repetir examen":"Comenzar examen"} →</button>
  </div>`;
}

function coursePaneTask(cd){
  return `<div class="pane-body">
    <h2 class="pane-title">Tarea final</h2>
    <p class="course-desc">${esc(cd.c.assignment||"")}</p>
    <div id="taskBody">${taskBodyHtml(cd.sub, cd.c.id)}</div>
  </div>`;
}

function renderCurriculum(cd){
  const n=cd.modules.length, doneN=cd.modules.filter(mo=>cd.modsDone.includes(mo.id)).length;
  const allDone=courseAllDone(cd); const sel=state.cache.courseSel;
  let items=cd.modules.map((mo,i)=>{
    const done=cd.modsDone.includes(mo.id), active=sel.type==="module"&&(sel.idx||0)===i;
    return `<button class="curr-item${active?" active":""}" onclick="app.courseGo(${i})">
      <span class="curr-ic ${done?"done":""}">${done?"✓":(i+1)}</span>
      <span class="curr-title">${esc(mo.title||("Módulo "+(i+1)))}</span></button>`;
  }).join("");
  if(cd.exam.length){
    const active=sel.type==="exam";
    items+=`<button class="curr-item extra${active?" active":""}${allDone?"":" locked"}" ${allDone?`onclick="app.courseSel('exam')"`:"disabled"}>
      <span class="curr-ic">${allDone?"📝":"🔒"}</span><span class="curr-title">Examen final</span></button>`;
  }
  if(cd.c.assignment){
    const active=sel.type==="task";
    items+=`<button class="curr-item extra${active?" active":""}${allDone?"":" locked"}" ${allDone?`onclick="app.courseSel('task')"`:"disabled"}>
      <span class="curr-ic">${allDone?"📤":"🔒"}</span><span class="curr-title">Tarea final</span></button>`;
  }
  return `<div class="curr-head"><b>Contenido del curso</b><span class="mono">${doneN}/${n}</span></div>
    <div class="progress"><div class="progress-fill" style="width:${n?Math.round(100*doneN/n):0}%"></div></div>
    <div class="curr-list">${items}</div>
    ${(cd.exam.length||cd.c.assignment)&&!allDone?`<p class="curr-note">🔒 Completa todos los módulos para desbloquear el examen y la tarea.</p>`:""}
    <button class="btn ${cd.completed?"btn-ghost":"btn-primary"} btn-sm curr-complete" onclick="app.markCourseComplete(${cd.completed?"false":"true"})">${cd.completed?"✓ Curso completado":"Marcar curso como completado"}</button>`;
}

function refreshCurriculum(){ const box=document.getElementById("courseCurriculum"); if(box&&state.cache.cd) box.innerHTML=renderCurriculum(state.cache.cd); }

/* ===================== Radar · escáner de señales ===================== */
const RSIG = {
  MOMENTUM_ACELERANDO:{l:"Momentum acelerando",c:"#3DD6A0"},
  RUPTURA_ALCISTA:{l:"Ruptura alcista",c:"#3DD6A0"},
  TENDENCIA_FUERTE:{l:"Tendencia fuerte",c:"#4FA3FF"},
  VOLATILIDAD_EXTREMA:{l:"Volatilidad extrema",c:"#E0894F"},
  VOLATILIDAD_COMPRIMIDA:{l:"Volatilidad comprimida",c:"#F5C451"},
  FLUJO_INUSUAL:{l:"Flujo inusual",c:"#9d7bc0"},
  PRECIO_SOBREEXTENDIDO:{l:"Precio sobre-extendido",c:"#c96a6a"},
  PRECIO_INFRAEXTENDIDO:{l:"Precio infra-extendido",c:"#7FB0FF"},
  RUPTURA_BAJISTA:{l:"Ruptura bajista",c:"#c96a6a"},
};
function radarSig(k){ return RSIG[k]||{l:k||"Señal",c:"#94A8C7"}; }

function radarDemo(){
  const S=(tid,name,sector,price,score,tag,notes)=>({tid,name,sector,price,score,tag,notes});
  return { generated_at:new Date().toISOString(), universe:"S&P 500 (demo)", demo:true, count:18, signals:[
    S("NVDA","NVIDIA","Tecnología",121.4,94,"MOMENTUM_ACELERANDO",["Retorno 20d +14.2% con aceleración","A 0.8% del máximo de 52 semanas"]),
    S("SMCI","Super Micro","Tecnología",48.7,91,"VOLATILIDAD_EXTREMA",["Volatilidad realizada en el percentil 97","Rango diario 3.1× su promedio"]),
    S("AAPL","Apple","Tecnología",231.2,72,"TENDENCIA_FUERTE",["Precio sobre SMA50 y SMA200","Tendencia alcista sostenida 60d"]),
    S("XOM","Exxon Mobil","Energía",112.9,68,"PRECIO_SOBREEXTENDIDO",["Z-score +2.4 vs media de 20d","Sobre-extendido al alza"]),
    S("KO","Coca-Cola","Consumo",71.3,63,"VOLATILIDAD_COMPRIMIDA",["Volatilidad en el percentil 6","Compresión suele preceder movimientos"]),
    S("PLTR","Palantir","Tecnología",38.5,88,"FLUJO_INUSUAL",["Volumen 3.4× su promedio de 20d","Posible catalizador en curso"]),
    S("TSLA","Tesla","Consumo",249.1,84,"VOLATILIDAD_EXTREMA",["Volatilidad realizada en el percentil 92","Rango diario 2.6× su promedio"]),
    S("JPM","JPMorgan","Financiero",228.4,66,"RUPTURA_ALCISTA",["Nuevo máximo de 52 semanas","Ruptura con volumen creciente"]),
    S("PFE","Pfizer","Salud",24.8,79,"PRECIO_INFRAEXTENDIDO",["Z-score −2.1 vs media de 20d","Infra-extendido, posible reversión"]),
    S("META","Meta","Comunicación",596.2,77,"MOMENTUM_ACELERANDO",["Retorno 60d +19% con aceleración","Fuerza relativa sobre el sector"]),
    S("BA","Boeing","Industrial",168.0,81,"RUPTURA_BAJISTA",["Nuevo mínimo de 52 semanas","Ruptura bajista con volumen"]),
    S("AMD","AMD","Tecnología",142.6,74,"TENDENCIA_FUERTE",["Cruce alcista SMA20/SMA50","Momentum positivo 40d"]),
    S("WMT","Walmart","Consumo",81.9,61,"VOLATILIDAD_COMPRIMIDA",["Volatilidad en el percentil 9","Rango estrecho 15d"]),
    S("GS","Goldman Sachs","Financiero",512.3,69,"PRECIO_SOBREEXTENDIDO",["Z-score +2.2 vs media de 20d","Extensión sobre la media"]),
    S("INTC","Intel","Tecnología",22.1,83,"FLUJO_INUSUAL",["Volumen 2.9× su promedio","Interés inusual reciente"]),
    S("CVX","Chevron","Energía",158.7,64,"MOMENTUM_ACELERANDO",["Retorno 20d +6.1%","Aceleración vs 60d"]),
    S("NFLX","Netflix","Comunicación",712.5,71,"TENDENCIA_FUERTE",["Sobre SMA50/200","Tendencia alcista limpia"]),
    S("DIS","Disney","Comunicación",95.4,76,"PRECIO_INFRAEXTENDIDO",["Z-score −1.9 vs media","Zona de posible rebote"]),
  ]};
}

/* ===================== Terminal de opciones ===================== */
function terminalDemo(){
  const spot=452.3, strikes=[], gex=[];
  for(let k=430;k<=475;k+=2.5){ strikes.push(k);
    const g=Math.exp(-(((k-460)/9)**2))*2.6 - Math.exp(-(((k-444)/8)**2))*2.0 + (Math.random()-0.5)*0.15;
    gex.push({strike:k,gex:+g.toFixed(3)}); }
  const expiries=[7,14,30,60,90,180], sstr=[440,445,450,455,460,465];
  const iv=expiries.map(d=>sstr.map(k=>+(0.15+0.9*Math.max(0,(spot-k)/spot)*0.3+1.4*((k-spot)/spot)**2+0.10/Math.sqrt(d/30)).toFixed(4)));
  const term=expiries.map(d=>({days:d,atm_iv:+(0.16+0.11/Math.sqrt(d/30)).toFixed(4)}));
  return { ticker:"SPY", demo:true, generated_at:new Date().toISOString(), spot,
    net_gex:+gex.reduce((a,b)=>a+b.gex,0).toFixed(3), gamma_flip:451.2, call_wall:460, put_wall:444,
    gex_by_strike:gex, surface:{strikes:sstr,expiries,iv}, term,
    dealer_convention:"dealers largos gamma en calls, cortos en puts (SqueezeMetrics)" };
}

async function viewTerminal(){
  const m=$("#main"); m.classList.add("wide");
  m.innerHTML=head("Análisis","Terminal de opciones","GEX, superficie de IV y estructura de plazos — motor propio.");
  m.append(el(`<div id="termShell"><div class="radar-loading">Cargando el terminal…</div></div>`));
  let idx=null;
  try{
    const u=sb.storage.from("media").getPublicUrl("terminal/index.json").data.publicUrl;
    const r=await fetch(u,{cache:"no-store"}); if(r.ok) idx=await r.json();
  }catch(e){}
  let snaps={}, order=[];
  if(idx&&Array.isArray(idx.tickers)&&idx.tickers.length){
    order=idx.tickers.map(x=>x.ticker);
    await Promise.all(order.map(async t=>{ snaps[t]=await loadTerminalSnap(t); }));
  } else {
    terminalDemoMulti().forEach(s=>{ snaps[s.ticker]=s; order.push(s.ticker); });
  }
  state.cache.term={ snaps, order, mode:"mosaico", current:null };
  renderTerminalMode();
}
function renderTerminalMode(){
  const T=state.cache.term;
  if(T.mode==="individual" && T.current) renderTerminalIndividual(T.current);
  else renderTerminalMosaico();
}
function renderTerminalMosaico(){
  const T=state.cache.term, box=$("#termShell"); if(!box) return;
  const demo=Object.values(T.snaps)[0]?.demo;
  box.innerHTML=`${demo?`<div class="radar-demo-note">Datos de <b>demostración</b>. Con tu plan de Polygon y el pipeline corriendo verás el mosaico real. Toca cualquier activo para ampliarlo.</div>`:`<p class="term-sub" style="margin-bottom:.8rem">Toca cualquier activo para ampliarlo al terminal completo.</p>`}
    <div class="term-mosaic">${T.order.map(t=>miniPanel(t,T.snaps[t])).join("")}</div>`;
}
function miniPanel(t,s){
  if(!s) return "";
  const pos=(s.net_gex||0)>=0, reg=pos?{l:"Gamma positiva",c:"#3DD6A0"}:{l:"Gamma negativa",c:"#c96a6a"};
  return `<div class="mini-panel card" onclick="app.terminalOpen('${t}')">
    <div class="mp-head"><div><b class="mp-tid">${esc(t)}</b><span class="mp-spot">$${s.spot}</span></div>
      <button class="mp-exp" onclick="event.stopPropagation();app.terminalOpen('${t}')" title="Ampliar">⤢</button></div>
    <div class="mp-reg" style="color:${reg.c}">◆ ${reg.l}</div>
    <div class="mp-metrics"><span>GEX C/P <b>${s.gex_cp??"—"}</b></span><span>OI C/P <b>${s.oi_cp??"—"}</b></span><span>Δ <b style="color:${reg.c}">${s.net_gex}b</b></span></div>
    <div class="mp-rs"><span style="color:#3DD6A0">R ${s.call_wall??"—"}</span><span style="color:#c96a6a">S ${s.put_wall??"—"}</span></div>
    ${gexMiniSVG(s.gex_by_strike||[],s.spot)}
  </div>`;
}
function gexMiniSVG(gex, spot){
  const W=260,H=70; if(!gex.length) return "";
  const xs=gex.map(g=>g.strike),vs=gex.map(g=>g.gex);
  const kmin=Math.min(...xs),kmax=Math.max(...xs),vmax=Math.max(0.001,...vs.map(Math.abs));
  const x=k=>(k-kmin)/(kmax-kmin||1)*W, y=v=>H/2-(v/vmax)*(H/2-4);
  const bw=Math.max(1.4,W/gex.length-1);
  const bars=gex.map(g=>{ const c=g.gex>=0?"#3DD6A0":"#c96a6a",yy=y(g.gex),y0=y(0);
    return `<rect x="${(x(g.strike)-bw/2).toFixed(1)}" y="${Math.min(yy,y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(yy-y0).toFixed(1)}" fill="${c}" opacity=".85"/>`; }).join("");
  return `<svg class="mp-chart" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
    <line x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="#33405e" stroke-width=".7"/>${bars}
    <line x1="${x(spot).toFixed(1)}" y1="2" x2="${x(spot).toFixed(1)}" y2="${H-2}" stroke="#F5C451" stroke-dasharray="3 2" stroke-width="1"/></svg>`;
}
function renderTerminalIndividual(t){
  const T=state.cache.term, s=T.snaps[t], box=$("#termShell"); if(!box) return;
  box.innerHTML=`<div class="term-indiv-top">
      <button class="btn btn-ghost btn-sm" style="width:auto" onclick="app.terminalBackToMosaico()">← Mosaico</button>
      <div class="term-tabs">${T.order.map(x=>`<button class="rtab ${x===t?"on":""}" onclick="app.terminalOpen('${x}')">${esc(x)}</button>`).join("")}</div>
    </div><div id="termPanels"></div>`;
  renderTerminalPanels(s);
}
function terminalDemoMulti(){
  const mk=(tid,spot,cw,pw,flip,net,gcp,ocp)=>{
    const gex=[]; for(let i=0;i<22;i++){ const k=+(spot*(0.9+i*0.01)).toFixed(1);
      const g=Math.exp(-(((k-cw)/(spot*0.03))**2))*Math.abs(net)*1.4 - Math.exp(-(((k-pw)/(spot*0.03))**2))*Math.abs(net)*1.1 + (Math.random()-0.5)*Math.abs(net)*0.1;
      gex.push({strike:k,gex:+g.toFixed(3)}); }
    const exp=[7,14,30,60,90,180],ss=[spot*0.97,spot*0.99,spot,spot*1.01,spot*1.03].map(v=>+v.toFixed(1));
    const iv=exp.map(d=>ss.map(k=>+(0.15+1.3*((k-spot)/spot)**2+0.10/Math.sqrt(d/30)).toFixed(4)));
    const term=exp.map(d=>({days:d,atm_iv:+(0.16+0.11/Math.sqrt(d/30)).toFixed(4)}));
    return { ticker:tid, demo:true, generated_at:new Date().toISOString(), spot,
      net_gex:net, gamma_flip:flip, call_wall:cw, put_wall:pw, gex_cp:gcp, oi_cp:ocp,
      gex_by_strike:gex, surface:{strikes:ss,expiries:exp,iv}, term,
      dealer_convention:"dealers largos gamma en calls, cortos en puts (SqueezeMetrics)" };
  };
  return [
    mk("SPY",452.3,460,444,451.2,3.02,1.97,1.08),
    mk("QQQ",388.1,395,378,386.0,1.35,1.28,0.98),
    mk("TLT",92.4,95,90,92.9,-0.84,0.72,1.20),
    mk("GLD",196.5,200,192,196.9,0.41,1.10,0.90),
    mk("AAPL",231.2,240,222,229.5,0.66,1.42,1.05),
    mk("NVDA",121.4,130,112,118.9,-1.20,0.88,1.15),
  ];
}

async function loadTerminalSnap(ticker){
  if(/demo/i.test(ticker)) return terminalDemo();
  try{
    const u=sb.storage.from("media").getPublicUrl("terminal/"+ticker+".json").data.publicUrl;
    const r=await fetch(u,{cache:"no-store"}); if(r.ok) return await r.json();
  }catch(e){}
  return terminalDemo();
}

function gexBarsSVG(gex, spot, callWall, putWall){
  const W=560,H=260,pad=34; const xs=gex.map(g=>g.strike); const vs=gex.map(g=>g.gex);
  const kmin=Math.min(...xs),kmax=Math.max(...xs); const vmax=Math.max(0.001,...vs.map(Math.abs));
  const x=k=>pad+(k-kmin)/(kmax-kmin||1)*(W-pad*1.4);
  const y=v=>H/2-(v/vmax)*(H/2-20);
  const bw=Math.max(2,(W-pad*1.4)/gex.length-2);
  let bars=gex.map(g=>{ const c=g.gex>=0?"#3DD6A0":"#c96a6a"; const yy=y(g.gex),y0=y(0);
    return `<rect x="${(x(g.strike)-bw/2).toFixed(1)}" y="${Math.min(yy,y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(yy-y0).toFixed(1)}" fill="${c}" opacity=".9"/>`; }).join("");
  const sx=x(spot);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <line x1="${pad}" y1="${y(0)}" x2="${W-pad*0.4}" y2="${y(0)}" stroke="#33405e" stroke-width="1"/>
    ${bars}
    <line x1="${sx}" y1="14" x2="${sx}" y2="${H-14}" stroke="#F5C451" stroke-dasharray="4 3" stroke-width="1.2"/>
    <text x="${sx+4}" y="24" fill="#F5C451" font-size="10" font-family="JetBrains Mono">spot ${spot}</text>
    ${callWall?`<text x="${x(callWall)}" y="${H-2}" fill="#3DD6A0" font-size="9" text-anchor="middle" font-family="JetBrains Mono">call wall</text>`:""}
    ${putWall?`<text x="${x(putWall)}" y="12" fill="#c96a6a" font-size="9" text-anchor="middle" font-family="JetBrains Mono">put wall</text>`:""}
    <text x="${pad}" y="${H-2}" fill="#65799A" font-size="9" font-family="JetBrains Mono">${kmin}</text>
    <text x="${W-pad}" y="${H-2}" fill="#65799A" font-size="9" text-anchor="end" font-family="JetBrains Mono">${kmax}</text>
  </svg>`;
}
function termLineSVG(term){
  const W=560,H=230,pad=40; if(!term.length) return "";
  const ds=term.map(t=>t.days),vs=term.map(t=>t.atm_iv*100);
  const dmin=Math.min(...ds),dmax=Math.max(...ds),vmin=Math.min(...vs)*0.95,vmax=Math.max(...vs)*1.05;
  const x=d=>pad+(d-dmin)/(dmax-dmin||1)*(W-pad*1.4);
  const y=v=>H-24-(v-vmin)/(vmax-vmin||1)*(H-48);
  const pts=term.map(t=>`${x(t.days).toFixed(1)},${y(t.atm_iv*100).toFixed(1)}`).join(" ");
  const dots=term.map(t=>`<circle cx="${x(t.days).toFixed(1)}" cy="${y(t.atm_iv*100).toFixed(1)}" r="3.2" fill="#3DD6A0"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <polyline points="${pts}" fill="none" stroke="#3DD6A0" stroke-width="2"/>${dots}
    <text x="${pad}" y="${H-6}" fill="#65799A" font-size="9" font-family="JetBrains Mono">${dmin}d</text>
    <text x="${W-pad}" y="${H-6}" fill="#65799A" font-size="9" text-anchor="end" font-family="JetBrains Mono">${dmax}d</text>
    <text x="6" y="20" fill="#65799A" font-size="9" font-family="JetBrains Mono">${vmax.toFixed(0)}%</text>
    <text x="6" y="${H-26}" fill="#65799A" font-size="9" font-family="JetBrains Mono">${vmin.toFixed(0)}%</text>
  </svg>`;
}
function ensurePlotly(onready, onfail){
  if(window.Plotly) return onready();
  const cdns=["https://cdn.plot.ly/plotly-2.32.0.min.js","https://cdn.jsdelivr.net/npm/plotly.js@2.32.0/dist/plotly.min.js"];
  let i=0;
  const tryLoad=()=>{
    if(i>=cdns.length){ onfail&&onfail(); return; }
    const s=document.createElement("script"); s.src=cdns[i++];
    s.onload=()=>{ if(window.Plotly) onready(); else tryLoad(); };
    s.onerror=tryLoad;
    document.head.appendChild(s);
  };
  tryLoad();
}
function ivSurfacePlotly(host, surf){
  const draw=()=>{ if(!window.Plotly) return false;
    const z=surf.iv.map(row=>row.map(v=>v==null?null:v*100));
    window.Plotly.newPlot(host, [{type:"surface",x:surf.strikes,y:surf.expiries,z,
      colorscale:"Viridis",showscale:false,contours:{z:{show:true,usecolormap:true,project:{z:true}}}}],
      {margin:{l:0,r:0,t:0,b:0},paper_bgcolor:"rgba(0,0,0,0)",
       scene:{xaxis:{title:"Strike",color:"#94A8C7",gridcolor:"#1e2a44"},
              yaxis:{title:"Días",color:"#94A8C7",gridcolor:"#1e2a44"},
              zaxis:{title:"IV %",color:"#94A8C7",gridcolor:"#1e2a44"},
              bgcolor:"rgba(0,0,0,0)"}},
      {displayModeBar:false,responsive:true}); return true; };
  ensurePlotly(draw, ()=>{ host.innerHTML='<div class="term-noplot">No se pudo cargar el visor 3D. Revisa tu conexión o el bloqueador del navegador.</div>'; });
}

async function renderTerminalPanels(snap){
  const box=$("#termPanels"); if(!box) return;
  const fmt=v=>v==null?"—":(v>=0?"+":"")+v+" $bn";
  box.innerHTML=`
    ${snap.demo?`<div class="radar-demo-note">Datos de <b>demostración</b>. Al correr terminal_pipeline.py con tu llave de Polygon verás datos reales.</div>`:""}
    <div class="term-metrics">
      <div class="tm"><span>Spot</span><b>$${snap.spot}</b></div>
      <div class="tm"><span>GEX neto</span><b style="color:${(snap.net_gex||0)>=0?'#3DD6A0':'#c96a6a'}">${fmt(snap.net_gex)}</b></div>
      <div class="tm"><span>Gamma flip</span><b>${snap.gamma_flip??"—"}</b></div>
      <div class="tm"><span>Call wall</span><b style="color:#3DD6A0">${snap.call_wall??"—"}</b></div>
      <div class="tm"><span>Put wall</span><b style="color:#c96a6a">${snap.put_wall??"—"}</b></div>
    </div>
    <div class="term-grid">
      <div class="card term-panel"><div class="tp-head"><h3>GEX por strike</h3><button class="tp-max" onclick="app.maxPanel(this)" title="Ampliar">⤢</button></div><p class="term-sub">Verde = dealers largos gamma · rojo = cortos. Línea dorada = spot.</p>${gexBarsSVG(snap.gex_by_strike||[],snap.spot,snap.call_wall,snap.put_wall)}</div>
      <div class="card term-panel"><div class="tp-head"><h3>Superficie de IV</h3><button class="tp-max" onclick="app.maxPanel(this)" title="Ampliar">⤢</button></div><p class="term-sub">Strike × vencimiento × IV. Arrastra para rotar.</p><div id="ivSurface" class="iv-surface"></div></div>
      <div class="card term-panel"><div class="tp-head"><h3>Estructura de plazos (IV ATM)</h3><button class="tp-max" onclick="app.maxPanel(this)" title="Ampliar">⤢</button></div><p class="term-sub">Volatilidad implícita at-the-money por vencimiento.</p>${termLineSVG(snap.term||[])}</div>
    </div>
    <p class="brief-disc">Convención de dealers: ${esc(snap.dealer_convention||"—")}. Cálculo propio a partir de datos de Polygon.io. No es asesoría financiera.</p>`;
  const host=document.getElementById("ivSurface");
  if(host && snap.surface && snap.surface.iv && snap.surface.iv.length) ivSurfacePlotly(host, snap.surface);
  else if(host) host.innerHTML='<div class="term-noplot">Sin datos de superficie para este ticker.</div>';
}

async function viewRadar(){
  const m=$("#main"); m.classList.add("wide");
  m.innerHTML=head("Análisis","Radar","Escáner de señales y mapa de momentum del mercado.");
  m.append(el(`<div><div class="courses-toggle" id="radarModeTabs"></div><div id="radarShell"><div class="radar-loading">Escaneando el mercado…</div></div></div>`));
  let data=null, momo=null;
  try{
    const url=sb.storage.from("media").getPublicUrl("radar/radar_latest.json").data.publicUrl;
    const r=await fetch(url,{cache:"no-store"}); if(r.ok) data=await r.json();
  }catch(e){}
  try{
    const url=sb.storage.from("media").getPublicUrl("radar/momentum_latest.json").data.publicUrl;
    const r=await fetch(url,{cache:"no-store"}); if(r.ok) momo=await r.json();
  }catch(e){}
  if(!data||!Array.isArray(data.signals)||!data.signals.length) data=radarDemo();
  if(!momo||!Array.isArray(momo.assets)||!momo.assets.length){ momo=momentumDemo(); }
  state.cache.radar={ data, filter:"__all__", q:"" };
  state.cache.momo=momo;
  if(!state.cache.radarMode) state.cache.radarMode="cards";
  renderRadarMode();
}
function renderRadarMode(){
  const mode=state.cache.radarMode||"cards";
  const tabs=$("#radarModeTabs");
  if(tabs) tabs.innerHTML=`<button class="ct-btn ${mode==="cards"?"on":""}" onclick="app.radarMode('cards')">Señales</button>
    <button class="ct-btn ${mode==="momo"?"on":""}" onclick="app.radarMode('momo')">Momentum 3D</button>`;
  if(mode==="momo") renderMomentum(); else renderRadar();
}

function momentumDemo(){
  const A=(tid,name,ret,sharpe,z)=>({tid,name,ret,sharpe,z,score:Math.max(-3,Math.min(3,ret/6+sharpe/1.5+z*0.6))});
  return { demo:true, generated_at:new Date().toISOString(), window:"ret 20d · sharpe 60d · z-score 20d",
    assets:[A("QQQ","Nasdaq 100",6.2,1.8,1.4),A("XLK","Tecnología",7.1,2.1,1.7),A("SMH","Semis",9.4,2.4,2.0),
      A("SPY","S&P 500",3.1,1.2,0.8),A("XLF","Financiero",4.2,1.5,1.1),A("XLC","Comunicación",5.0,1.3,0.9),
      A("XLE","Energía",-2.1,-0.4,-0.7),A("XLU","Utilities",-1.2,0.2,-0.3),A("GLD","Oro",2.4,1.0,0.6),
      A("TLT","Bonos 20+",-3.4,-0.9,-1.2),A("USO","Petróleo",-4.8,-1.1,-1.6),A("XLV","Salud",0.8,0.3,0.1),
      A("XLI","Industrial",2.9,1.1,0.7),A("XLP","Consumo básico",-0.6,-0.1,-0.2),A("IWM","Small caps",1.5,0.6,0.3),
      A("EEM","Emergentes",-1.8,-0.5,-0.6),A("XLY","Consumo disc.",3.6,1.2,0.9),A("XLB","Materiales",-0.9,-0.2,-0.4)] };
}

function renderMomentum(){
  const host=$("#radarShell"); if(!host) return;
  const d=state.cache.momo;
  const when=d.generated_at?new Date(d.generated_at).toLocaleString("es"):"—";
  host.innerHTML=`${d.demo?`<div class="radar-demo-note">Momentum de <b>demostración</b>. Al correr el Radar verás el mapa real.</div>`:""}
    <div class="radar-meta" style="margin-bottom:.6rem"><span class="radar-count">${d.assets.length}</span> activos · ${esc(d.window||"")} · <span class="radar-when">${esc(when)}</span></div>
    <div class="card" style="padding:.4rem"><div id="momo3d" style="width:100%;height:520px"></div></div>
    <p class="term-sub" style="margin-top:.7rem">Cada punto es un activo. <b style="color:#3DD6A0">Verde</b> = momentum positivo, <b style="color:#c96a6a">rojo</b> = negativo. Arrastra para rotar.</p>`;
  const g=document.getElementById("momo3d");
  ensurePlotly(()=>{
    const a=d.assets;
    window.Plotly.newPlot(g,[{
      type:"scatter3d", mode:"markers+text",
      x:a.map(x=>x.ret), y:a.map(x=>x.sharpe), z:a.map(x=>x.z),
      text:a.map(x=>x.tid), textposition:"top center", textfont:{size:9,color:"#94A8C7"},
      hovertext:a.map(x=>`${x.tid} · ${x.name||""}<br>Ret ${x.ret}% · Sharpe ${x.sharpe} · Z ${x.z}`), hoverinfo:"text",
      marker:{ size:7, color:a.map(x=>x.score),
        colorscale:[[0,"#c96a6a"],[0.5,"#65799A"],[1,"#3DD6A0"]], cmin:-3, cmax:3,
        opacity:.92, line:{width:.5,color:"#0A1120"} }
    }],{
      autosize:true, margin:{l:0,r:0,t:0,b:0}, paper_bgcolor:"rgba(0,0,0,0)",
      scene:{ xaxis:{title:"Ret % (20d)",color:"#94A8C7",gridcolor:"#1e2a44",zerolinecolor:"#33405e"},
              yaxis:{title:"Sharpe",color:"#94A8C7",gridcolor:"#1e2a44",zerolinecolor:"#33405e"},
              zaxis:{title:"Z-score",color:"#94A8C7",gridcolor:"#1e2a44",zerolinecolor:"#33405e"},
              bgcolor:"rgba(0,0,0,0)", aspectmode:"cube",
              camera:{eye:{x:1.6,y:1.6,z:1.1}} }
    },{displayModeBar:false,responsive:true});
    setTimeout(()=>{ try{ window.Plotly.Plots.resize(g); }catch(e){} }, 80);
  },()=>{ if(g) g.innerHTML='<div class="term-noplot">No se pudo cargar el visor 3D. Revisa el bloqueador del navegador.</div>'; });
}

function renderRadar(){
  const R=state.cache.radar, d=R.data, box=$("#radarShell"); if(!box) return;
  const tags=[...new Set(d.signals.map(s=>s.tag))];
  const when=d.generated_at?new Date(d.generated_at).toLocaleString("es"):"—";
  const tabs=[["__all__","Todas",d.signals.length],
    ...tags.map(t=>[t,radarSig(t).l,d.signals.filter(s=>s.tag===t).length])];
  box.innerHTML=`
    ${d.demo?`<div class="radar-demo-note">Mostrando datos de <b>demostración</b>. Cuando corras el pipeline (radar_pipeline.py), verás el escaneo real del mercado.</div>`:""}
    <div class="radar-bar">
      <div class="radar-meta"><span class="radar-count">${d.signals.length}</span> señales · ${esc(d.universe||"universo")} · <span class="radar-when">${esc(when)}</span></div>
      <input id="radarQ" class="radar-search" placeholder="Buscar ticker o nombre…" oninput="app.radarSearch(this.value)" value="${esc(R.q||"")}">
    </div>
    <div class="radar-tabs">${tabs.map(([k,l,n])=>`<button class="rtab ${R.filter===k?"on":""}" onclick="app.radarFilter('${k}')">${esc(l)} <span>${n}</span></button>`).join("")}</div>
    <div id="radarGrid" class="radar-grid"></div>`;
  renderRadarGrid();
}
function renderRadarGrid(){
  const R=state.cache.radar, grid=$("#radarGrid"); if(!grid) return;
  const q=(R.q||"").trim().toLowerCase();
  let list=R.data.signals.slice();
  if(R.filter!=="__all__") list=list.filter(s=>s.tag===R.filter);
  if(q) list=list.filter(s=>(s.tid||"").toLowerCase().includes(q)||(s.name||"").toLowerCase().includes(q));
  list.sort((a,b)=>(b.score||0)-(a.score||0));
  if(!list.length){ grid.innerHTML=`<div class="card empty" style="grid-column:1/-1"><p>Sin señales para ese filtro.</p></div>`; return; }
  grid.innerHTML=list.map(s=>{ const g=radarSig(s.tag);
    return `<div class="radar-card" style="--sig:${g.c}">
      <div class="rc-top">
        <div><span class="rc-tid">${esc(s.tid||"")}</span><span class="rc-price">${s.price!=null?"$"+Number(s.price).toFixed(2):""}</span></div>
        <span class="rc-score">${s.score!=null?Math.round(s.score):"—"}</span>
      </div>
      <div class="rc-tag">${esc(g.l)}</div>
      ${(Array.isArray(s.notes)?s.notes:[]).slice(0,3).map(n=>`<div class="rc-note">${esc(n)}</div>`).join("")}
      ${s.sector?`<div class="rc-sector">${esc(s.sector)}</div>`:""}
    </div>`; }).join("");
}

/* ===================== Brief macro (Lepton-AI) ===================== */
async function viewBrief(){
  const admin = state.profile.role==="admin";
  const m=$("#main");
  m.innerHTML=head("Análisis","Brief macro","Análisis del mercado generado por IA a partir del Radar.");
  m.append(el(`<div id="briefShell"><div class="radar-loading">Cargando el brief…</div></div>`));
  let b=null;
  try{
    const url=sb.storage.from("media").getPublicUrl("brief/brief_latest.json").data.publicUrl;
    const r=await fetch(url,{cache:"no-store"}); if(r.ok) b=await r.json();
  }catch(e){}
  state.cache.brief=b;
  renderBrief();
}
function renderBrief(){
  const b=state.cache.brief, admin=state.profile.role==="admin", box=$("#briefShell"); if(!box) return;
  const genBtn = admin ? `<button class="btn btn-primary btn-sm" id="briefGen" style="width:auto" onclick="app.generateBrief()">${b?"Regenerar brief":"Generar brief ahora"} ✦</button>` : "";
  if(!b){
    box.innerHTML=`<div class="card empty">${icon("brief")}
      <h3 style="margin:.5rem 0 .2rem">Aún no hay brief publicado</h3>
      <p style="color:var(--muted)">${admin?"Genera el primero con un clic — la IA analizará las señales del Radar.":"Tu asesor publicará pronto el análisis del mercado."}</p>
      ${genBtn?`<div style="margin-top:.9rem">${genBtn}</div>`:""}</div>`;
    return;
  }
  const when=b.generated_at?new Date(b.generated_at).toLocaleString("es"):"—";
  box.innerHTML=`
    <div class="brief-head">
      <div><div class="brief-kicker">✦ Brief IA · ${esc(b.universe||"")}</div>
        <h2 class="brief-title">${esc(b.titulo||"Brief del mercado")}</h2>
        <div class="brief-when">${esc(when)} · ${b.signals_used||0} señales analizadas</div></div>
      ${genBtn}
    </div>
    ${b.resumen?`<div class="brief-summary">${esc(b.resumen)}</div>`:""}
    <div class="brief-sections">${(b.secciones||[]).map(s=>`<div class="brief-sec card">
      <h3>${esc(s.titulo||"")}</h3><p>${esc(s.cuerpo||"").replace(/\n/g,"<br>")}</p></div>`).join("")}</div>
    ${b.disclaimer?`<p class="brief-disc">${esc(b.disclaimer)}</p>`:""}`;
}

async function viewCoursesClient(){
  const cs=await sb.from("courses").select("*").eq("published",true).order("created_at",{ascending:false}).then(r=>r.data||[]);
  const prog=await sb.from("course_progress").select("course_id,completed").eq("user_id",state.profile.id).then(r=>r.data||[]);
  const done=new Set((prog||[]).filter(p=>p.completed).map(p=>p.course_id));
  const m=$("#main"); m.classList.add("wide");
  const focus=document.body.classList.contains("focus-mode");
  m.innerHTML = focus ? "" : head("Formación","Cursos","Tu ruta de aprendizaje, de Básico a Quant Financiero.");
  if(!cs.length){ m.append(el(`<div class="card empty">${icon("book")}<p style="margin-top:.4rem">Aún no hay cursos publicados.</p></div>`)); return; }
  const host=el(`<div class="courses-canvas malla${focus?" focus":""}"></div>`); m.append(host);
  state.cache.cmapCourses=cs;
  buildMalla(host, cs, done);
}
function renderNeural(host, cs, done){
  const {svg,flat}=coursesNeuralMap(cs, done);
  host.innerHTML=`<div class="cmap-wrap">
    <div class="cmap-scroll card">${svg}</div>
    <div id="courseDetail" class="cmap-detail card">
      <div class="cmap-detail-empty">${icon("book")}<p>Toca una neurona del mapa para ver el curso.</p></div>
    </div></div>`;
  state.cache.cmapCourses=flat;
  host.querySelectorAll(".cmap-node").forEach(g=>{
    const pick=()=>app.pickCourse(+g.dataset.i);
    g.addEventListener("click",pick);
    g.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();pick();} });
  });
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
  await sb.from("messages").update({read:true}).eq("client_id",state.profile.id).eq("sender_role","admin").eq("read",false);
  refreshBadges();
}

/* ============================================================
   Notificaciones (cliente y admin)
   ============================================================ */
async function viewNotifications(){
  const ns=await sb.from("notifications").select("*").eq("user_id",state.profile.id)
    .order("created_at",{ascending:false}).limit(50).then(r=>r.data||[]);
  const m=$("#main");
  const unread=ns.filter(n=>!n.read).length;
  m.innerHTML=head("Avisos","Notificaciones",
    unread?`Tienes ${unread} sin leer.`:"Estás al día.");
  if(unread) $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="app.readAll()">Marcar todas como leídas</button>`));
  if(!ns.length){ m.append(el(`<div class="card empty">${icon("bell")}<p style="margin-top:.4rem">No tienes notificaciones.</p></div>`)); return; }
  const ICONS={mensaje:"chat",evento:"cal",cartera:"pie",general:"bell"};
  const box=el(`<div></div>`);
  ns.forEach(n=>{
    const it=el(`<div class="notif ${n.read?"":"unread"}">
      <div class="notif-ic">${icon(ICONS[n.kind]||"bell")}</div>
      <div class="li-main" style="flex:1"><b>${esc(n.title)}</b><span>${esc(n.body||"")}</span></div>
      <span class="mono" style="color:var(--faint);font-size:.72rem;white-space:nowrap">${fmtTime(n.created_at)}</span></div>`);
    it.onclick=()=>app.openNotif(n);
    box.append(it);
  });
  m.append(box);
}

/* ============================================================
   Asistente IA
   ============================================================ */
async function viewAssistant(){
  const m=$("#main");
  m.innerHTML=head("Asistente","Asistente IA",
    "Resuelve dudas sobre inversión, tu perfil y tu cartera. Para decisiones concretas, habla con tu asesor.");
  m.append(el(`<div class="card">
    <div class="flex between" style="margin-bottom:.9rem">
      <span class="pill pill-blue dot">En línea</span>
      <span id="quota" class="quota">—</span>
    </div>
    <div id="chat" class="chat"></div>
    <div class="composer">
      <input id="botIn" class="input" placeholder="Pregunta lo que quieras…" onkeydown="if(event.key==='Enter')app.askBot()">
      <button id="botBtn" class="btn btn-primary" style="width:auto" onclick="app.askBot()">Enviar</button>
    </div>
    <p class="card-sub" style="margin:.8rem 0 0;font-size:.76rem">El asistente es educativo y puede equivocarse. No ejecuta operaciones ni sustituye la asesoría de tu gestor.</p>
  </div>`));
  state.cache.bot = state.cache.bot || [];
  renderBot();
  loadQuota();
  if(!state.cache.bot.length){
    const sug=["¿Qué significa mi perfil de riesgo?","¿Por qué diversificar?","¿Cómo funciona el interés compuesto?"];
    $("#chat").innerHTML=`<div class="empty" style="padding:1.2rem">
      <div style="margin-bottom:.9rem">Hola ${esc((state.profile.full_name||"").split(" ")[0])}. ¿En qué te ayudo?</div>
      <div class="flex" style="justify-content:center;flex-wrap:wrap">
        ${sug.map(q=>`<button class="btn btn-ghost btn-sm" onclick="app.askBot('${esc(q)}')">${esc(q)}</button>`).join("")}
      </div></div>`;
  }
}
async function loadQuota(){
  try{
    const { data:{ session } }=await sb.auth.getSession();
    const r=await fetch("/api/chat",{ headers:{ Authorization:"Bearer "+session.access_token } });
    const ct=r.headers.get("content-type")||"";
    if(!ct.includes("application/json")) return;
    const d=await r.json();
    if(d.ok) paintQuota(d);
  }catch(e){ /* silencio: no bloquear la vista */ }
}
function paintQuota(d){
  const box=$("#quota"); if(!box) return;
  if(d.unlimited){ box.textContent="Sin límite (administrador)"; return; }
  const left=d.remaining??0, lim=d.limit||5;
  box.innerHTML=`<b class="mono ${left===0?"neg":(left<=1?"warn-t":"")}">${left}</b> de ${lim} consultas esta semana`;
  const btn=$("#botBtn"), inp=$("#botIn");
  if(left<=0 && btn){
    btn.disabled=true; inp.disabled=true;
    inp.placeholder="Sin consultas disponibles esta semana";
  } else if(btn){ btn.disabled=false; inp.disabled=false; inp.placeholder="Pregunta lo que quieras…"; }
}
function renderBot(){
  const box=$("#chat"); if(!box) return;
  if(!state.cache.bot.length) return;
  box.innerHTML="";
  state.cache.bot.forEach(x=>{
    if(x.role==="error"){
      box.append(el(`<div class="bot-error">${icon("bell")}<span>${esc(x.content)}</span></div>`));
    } else {
      box.append(el(`<div class="bubble ${x.role==="user"?"me":"them"}">${esc(x.content).replace(/\n/g,"<br>")}</div>`));
    }
  });
  box.scrollTop=box.scrollHeight;
}

/* ============================================================
   Mi perfil (cliente)
   ============================================================ */
async function viewProfile(){
  const p=state.profile;
  const m=$("#main");
  m.innerHTML=head("Cuenta","Mi perfil","Tus datos personales y de contacto.");
  m.append(el(`<div class="card" style="max-width:560px">
    <div class="field"><label>Foto de perfil</label>
      <div class="imgpick">
        <div class="imgpick-preview avatar-prev ${p.avatar_url?"has":""}" id="prev_avatar">
          ${p.avatar_url?`<img src="${esc(p.avatar_url)}" alt="">`:`<span>${initials(p.full_name)}</span>`}</div>
        <div class="imgpick-ctrl">
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">Subir foto
            <input type="file" accept="image/*" hidden onchange="app.pickAvatar(this)"></label>
          <button type="button" class="btn btn-ghost btn-sm" onclick="app.clearAvatar()">Quitar</button>
          <input type="hidden" id="url_avatar" value="${esc(p.avatar_url||"")}">
          <span class="imgpick-hint">JPG, PNG o WebP · máx. 5 MB</span>
        </div></div></div>
    <div class="divide"></div>
    <div class="field"><label>Nombre completo</label><input id="pfFull" class="input" value="${esc(p.full_name||"")}"></div>
    <div class="field"><label>Correo</label><input class="input" value="${esc(p.email||"")}" disabled></div>
    <div class="flex" style="gap:.8rem;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:180px"><label>Celular (con código de país)</label>
        <input id="phIn" class="input" placeholder="+591 7xxxxxxx" value="${esc(p.phone||"")}"></div>
      <div class="field" style="flex:1;min-width:180px"><label>Fecha de nacimiento</label>
        <input id="pfBirth" class="input" type="date" value="${esc(p.birth_date||"")}"></div>
    </div>
    <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.saveProfileInfo()">Guardar cambios</button>
  </div>`));
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
    const av=c.avatar_url?`<img src="${esc(c.avatar_url)}" alt="">`:initials(c.full_name);
    const tr=el(`<tr class="row-click">
      <td><div class="flex"><div class="avatar" style="width:32px;height:32px">${av}</div>
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
  const edad = client.birth_date
    ? Math.floor((Date.now()-new Date(client.birth_date))/(365.25*864e5)) : null;
  ph.innerHTML=`<div class="flex" style="gap:.9rem;align-items:center">
      <div class="avatar" style="width:52px;height:52px;border-radius:12px">
        ${client.avatar_url?`<img src="${esc(client.avatar_url)}" alt="">`:initials(client.full_name)}</div>
      <div><div class="eyebrow">Cliente</div><h1>${esc(client.full_name||client.email)}</h1>
        <p><span class="mono">${esc(client.email||"")}</span>${client.phone?` · <span class="mono">${esc(client.phone)}</span>`:""}${edad!=null?` · ${edad} años`:""}</p>
      </div></div>`;
  $("#headExtra").append(el(`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/mensajes/${uid}'">Escribir mensaje</button>`));
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
      <div class="divide"></div><div class="radar">${radarChart(computeRadar(ra.answers||{}))}</div></div>`));
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

  // zona de peligro
  m.append(el(`<div class="card mt2">
    <h3>Cuenta de inversión (Alpaca · sandbox)</h3>
    <p class="card-sub">Pega el <b>account_id</b> de la cuenta de prueba de este cliente para habilitarle la sección <b>Operar</b>. En producción, esto se creará automáticamente en el onboarding.</p>
    <div class="flex" style="gap:.6rem;flex-wrap:wrap">
      <input id="alpacaId" class="input mono" style="flex:1;min-width:260px" placeholder="ej. b6332229-32b3-455e-a612-bc77e3111336" value="${esc(client.alpaca_account_id||"")}">
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="app.saveAlpacaId('${uid}')">Vincular</button>
    </div>
    <div class="flex mt" style="gap:.6rem;align-items:center;flex-wrap:wrap">
      <button id="setupBtn" class="btn btn-ghost btn-sm" onclick="app.createTestAccount('${uid}')">⚙️ Crear cuenta de prueba y fondear</button>
      ${client.alpaca_account_id?`<button id="fundBtn" class="btn btn-ghost btn-sm" onclick="app.fundAccount('${esc(client.alpaca_account_id)}')">💵 Fondear cuenta vinculada</button>`:""}
      <span id="setupMsg" class="card-sub" style="margin:0"></span>
    </div>
  </div>`));

  // servicio premium
  m.append(el(`<div class="card mt2">
    <div class="flex between" style="align-items:flex-start">
      <div><h3>Ajuste de portafolio (premium)</h3>
        <p class="card-sub" style="margin:0">Habilita el diagnóstico cuantitativo (Markowitz, HRP, Core-Satellite) para este cliente.</p></div>
      <label class="tgl"><input type="checkbox" id="premChk" ${client.premium_portfolio?"checked":""} onchange="app.togglePremium('${uid}',this.checked)"><span class="tgl-track"></span></label>
    </div>
    <div class="divide"></div>
    <div class="flex between" style="align-items:flex-start">
      <div><h3 style="margin:0">Red de mercado · QuantNet (premium)</h3>
        <p class="card-sub" style="margin:0">Habilita el terminal de red de correlaciones para este cliente.</p></div>
      <label class="tgl"><input type="checkbox" id="qnChk" ${client.premium_quantnet?"checked":""} onchange="app.toggleQuantnet('${uid}',this.checked)"><span class="tgl-track"></span></label>
    </div>
    <div class="divide"></div>
    <div class="flex between" style="align-items:flex-start">
      <div><h3 style="margin:0">Cursos premium</h3>
        <p class="card-sub" style="margin:0">Da acceso a los cursos marcados como premium para este cliente.</p></div>
      <label class="tgl"><input type="checkbox" id="cuChk" ${client.premium_courses?"checked":""} onchange="app.toggleCourses('${uid}',this.checked)"><span class="tgl-track"></span></label>
    </div>
  </div>`));

  // zona de peligro
  m.append(el(`<div class="card danger mt2">
    <h3>Zona de peligro</h3>
    <p class="card-sub">Eliminar la cuenta de <b>${esc(client.full_name||client.email)}</b> borra de forma permanente
      su perfil de riesgo, su cartera, sus posiciones y toda la conversación. No hay forma de deshacerlo.</p>
    <div class="flex">
      <button class="btn btn-ghost btn-sm" onclick="app.exportClient('${uid}')">Exportar sus datos antes (JSON)</button>
      <button class="btn btn-danger btn-sm" onclick="app.confirmDelete('${uid}','${esc(client.full_name||client.email).replace(/'/g,"\\'")}')">Eliminar cuenta</button>
    </div>
  </div>`));

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
    ${p.image_url?`<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy">`:""}
    <div class="li-main"><div class="flex" style="gap:.5rem">
      <span class="pill ${p.kind==='idea'?'pill-blue':''}" style="${p.kind!=='idea'?'color:var(--faint)':''}">${p.kind==="idea"?"Idea":"Noticia"}</span>
      ${p.ticker?`<span class="mono ticker" style="font-size:.8rem">${esc(p.ticker)}</span>`:""}</div>
      <b style="margin-top:.3rem">${esc(p.title)}</b>
      <span>${p.published?"Publicada":"Borrador"} · ${fmtDate(p.created_at)}</span></div>
    <div class="flex">
      <button class="btn btn-ghost btn-sm" onclick="app.editPost('${p.id}')">Editar</button>
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
    ${c.image_url?`<img class="thumb" src="${esc(c.image_url)}" alt="" loading="lazy">`:""}
    <div class="li-main"><b>${esc(c.title)}</b><span>${esc(c.level||"")} · ${c.published?"Publicado":"Borrador"}</span></div>
    <div class="flex"><button class="btn btn-ghost btn-sm" onclick="app.editCourse('${c.id}')">Editar</button>
      ${c.assignment?`<button class="btn btn-ghost btn-sm" onclick="location.hash='#/cursos/${c.id}'">Entregas</button>`:""}
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
  const clients=await sb.from("profiles").select("id,full_name,email,avatar_url").eq("role","client").then(r=>r.data||[]);
  const pmap=Object.fromEntries(clients.map(p=>[p.id,p]));

  // Hilo individual (funciona aunque no haya mensajes previos)
  if(state.param) return void await adminThread(state.param,pmap[state.param]);

  $("#headExtra").append(el(`<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.newThread()">+ Escribir a un cliente</button>`));
  m.append(el(`<div id="newThread"></div>`));

  const msgs=await sb.from("messages").select("*").order("created_at",{ascending:false}).then(r=>r.data||[]);
  const ids=[...new Set(msgs.map(x=>x.client_id))];
  if(!ids.length){
    m.append(el(`<div class="card empty">${icon("chat")}<p style="margin-top:.4rem">Sin conversaciones todavía.</p>
      <p style="font-size:.85rem">Usa <b>Escribir a un cliente</b> para iniciar una.</p></div>`));
    return;
  }
  const list=el(`<div></div>`);
  ids.forEach(id=>{
    const last=msgs.find(x=>x.client_id===id), p=pmap[id]||{};
    const unread=msgs.some(x=>x.client_id===id&&x.sender_role==="client"&&!x.read);
    const it=el(`<div class="list-item row-click">
      <div class="flex"><div class="avatar">${p.avatar_url?`<img src="${esc(p.avatar_url)}" alt="">`:initials(p.full_name)}</div>
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
    <div class="composer"><input id="msgIn" class="input" placeholder="Escribe un mensaje…" onkeydown="if(event.key==='Enter')app.sendMsg('${uid}')">
    <button class="btn btn-primary" style="width:auto" onclick="app.sendMsg('${uid}')">Enviar</button></div></div>`));
  await loadThread(uid);
  await sb.from("messages").update({read:true}).eq("client_id",uid).eq("sender_role","client").eq("read",false);
  refreshBadges();
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
    m.append(renderResult(data)); loadSuggestion();
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
    refreshBadge();
  },

  // ajuste de portafolio (premium)
  searchAdj(q){
    q=(q||"").trim(); clearTimeout(state.cache.adjT);
    const box=$("#adjResults"); if(!box) return;
    if(q.length<1){ box.classList.add("hidden"); box.innerHTML=""; return; }
    state.cache.adjT=setTimeout(async ()=>{
      try{
        const { data:{ session } }=await sb.auth.getSession();
        const r=await fetch("/api/alpaca-assets?q="+encodeURIComponent(q),{ headers:{ Authorization:"Bearer "+session.access_token } });
        const d=await r.json();
        if(!d.ok||!d.results.length){ box.innerHTML=`<div class="sr-empty">Sin coincidencias</div>`; box.classList.remove("hidden"); return; }
        box.innerHTML=d.results.map(a=>`<div class="sr-item" onclick="app.pickAdj('${esc(a.symbol)}')">
          <div><b class="mono">${esc(a.symbol)}</b> <span class="sr-name">${esc(a.name)}</span></div></div>`).join("");
        box.classList.remove("hidden");
      }catch(e){ box.classList.add("hidden"); }
    },250);
  },
  pickAdj(sym){ const i=$("#adjSym"); if(i)i.value=sym; const b=$("#adjResults"); if(b){b.classList.add("hidden");b.innerHTML="";} $("#adjVal")?.focus(); },
  addAdj(){
    const sym=($("#adjSym").value||"").trim().toUpperCase();
    if(!sym) return ui.toast("Escribe un símbolo","err");
    const val=parseFloat($("#adjVal").value)||0;
    state.cache.adj=state.cache.adj||[];
    if(state.cache.adj.some(h=>h.symbol===sym)) return ui.toast("Ya está en la lista","err");
    state.cache.adj.push({symbol:sym,value:val>0?val:null});
    $("#adjSym").value=""; $("#adjVal").value="";
    renderAdjList();
  },
  rmAdj(i){ state.cache.adj.splice(i,1); renderAdjList(); },
  async runAnalyze(){
    const list=state.cache.adj||[];
    if(list.length<2) return ui.toast("Añade al menos 2 activos","err");
    const btn=$("#adjRun"); btn.disabled=true; const prev=btn.textContent; btn.innerHTML='<span class="spinner"></span> Analizando (descargando históricos)…';
    const out=$("#adjOut"); out.innerHTML=`<div class="card">${loading()}<p class="card-sub" style="text-align:center">Descargando 3 años de históricos y calculando carteras…</p></div>`;
    try{
      const { data:{ session } }=await sb.auth.getSession();
      const r=await fetch("/api/portfolio-analyze",{ method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token },
        body:JSON.stringify({ holdings:list }) });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/portfolio-analyze no está desplegada.");
      const d=await r.json();
      if(!d.ok) throw new Error(d.message||d.error||"No se pudo analizar");
      await runAnalyzeRender(d);
    }catch(e){ out.innerHTML=`<div class="card"><div class="notice warn" style="margin:0">${esc(e.message)}</div></div>`; }
    finally{ btn.disabled=false; btn.textContent=prev; }
  },
  planTab(key){
    const r=state.cache.adjResult; if(!r) return;
    document.querySelectorAll(".tabs .tab").forEach(t=>t.classList.remove("active"));
    const idx={hrp:0,mk:1,cs:2}[key]; const tabs=document.querySelectorAll(".tabs .tab");
    if(tabs[idx]) tabs[idx].classList.add("active");
    const plan=r.plans[key];
    const cur=plan.symbols.map(s=>r.curBySym[s]||0);   // alinear actual al universo del método
    $("#planBody").innerHTML=`<table class="qtbl plan"><thead><tr><th>Activo</th><th style="text-align:right">Actual</th><th></th><th style="text-align:right">Objetivo</th><th style="text-align:right">Acción</th></tr></thead><tbody>${planRows(plan.symbols,cur,plan.target)}</tbody></table>`;
  },

  // mapa de cursos (red neuronal)
  pickCourse(i){
    const c=(state.cache.cmapCourses||[])[i]; if(!c) return;
    document.querySelectorAll(".cmap-node").forEach(n=>n.classList.toggle("sel",+n.dataset.i===i));
    const box=$("#courseDetail"); if(!box) return;
    const locked = c.premium && !(state.profile.role==="admin" || state.profile.premium_courses);
    box.innerHTML=`<div class="cmap-detail-full">
      <div class="flex" style="gap:.4rem;flex-wrap:wrap;margin-bottom:.2rem">
        <span class="pill pill-blue">${esc(c.level||"Curso")}</span>
        ${c.premium?`<span class="pill pill-premium">PREMIUM</span>`:""}</div>
      <h3>${esc(c.title||"Curso")}</h3>
      <p>${esc(c.description||"Sin descripción.")}</p>
      ${locked
        ? `<div class="lock-note">🔒 Curso premium. Pídele acceso a tu asesor para desbloquearlo.</div>`
        : `<button class="btn btn-primary btn-sm" style="width:auto" onclick="app.openCourse('${c.id}')">Entrar al curso →</button>`}
    </div>`;
  },
  openCourse(id){ location.hash="#/cursos/"+id; },
  setCoursesView(v){ state.coursesView=v; viewCoursesClient(); },
  radarFilter(k){ if(state.cache.radar){ state.cache.radar.filter=k; renderRadar(); } },
  radarMode(m){ state.cache.radarMode=m; renderRadarMode(); },
  radarSearch(v){ if(state.cache.radar){ state.cache.radar.q=v; renderRadarGrid(); } },
  async terminalSelect(t){ app.terminalOpen(t); },
  terminalOpen(t){ const T=state.cache.term; if(!T) return; T.mode="individual"; T.current=t; renderTerminalMode(); window.scrollTo({top:0,behavior:"smooth"}); },
  terminalBackToMosaico(){ const T=state.cache.term; if(!T) return; T.mode="mosaico"; T.current=null; renderTerminalMode(); },
  maxPanel(btn){ const p=btn.closest(".term-panel"); if(!p) return;
    const on=p.classList.toggle("maximized"); btn.textContent=on?"⤡":"⤢";
    document.body.classList.toggle("panel-maxed",on);
    const host=p.querySelector("#ivSurface");
    if(host&&window.Plotly){ setTimeout(()=>{ try{ window.Plotly.Plots.resize(host); }catch(e){} },60); }
  },
  async generateBrief(){
    const btn=$("#briefGen"); if(btn){ btn.disabled=true; btn.textContent="Generando… (~15s)"; }
    try{
      const { data:{ session } }=await sb.auth.getSession();
      const r=await fetch("/api/generate-brief",{ method:"POST", headers:{ Authorization:"Bearer "+session.access_token } });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/generate-brief no está desplegada.");
      const d=await r.json();
      if(!d.ok) throw new Error(d.message||"No se pudo generar el brief.");
      state.cache.brief=d.brief; renderBrief(); ui.toast("Brief generado","ok");
    }catch(e){ ui.toast(e.message,"err"); if(btn){ btn.disabled=false; btn.textContent="Generar brief ahora ✦"; } }
  },
  editSubmission(courseId){ const b=$("#taskBody"); if(b) b.innerHTML=subFormHtml(state.cache.currentSub,courseId); },
  async gradeSubmission(subId,courseId){
    const g=$("#grade_"+subId)?.value.trim();
    const fb=$("#fb_"+subId)?.value.trim()||null;
    const grade = g==="" ? null : Number(g);
    if(g!=="" && !isFinite(grade)) return ui.toast("La calificación debe ser un número","err");
    const {error}=await sb.from("course_submissions").update({ grade, feedback:fb, status:"graded", graded_at:new Date().toISOString() }).eq("id",subId);
    if(error) return ui.toast(error.message,"err");
    ui.toast("Calificación guardada","ok"); viewCourseSubmissions(courseId);
  },
  subFilePicked(input){ const f=input.files?.[0]; const s=$("#subFileName"); if(s) s.textContent=f?f.name:"Ningún archivo nuevo"; },
  async submitAssignment(courseId){
    const text=($("#subText")?.value||"").trim();
    const file=$("#subFile")?.files?.[0];
    const hadFile=state.cache.currentSub?.file_url;
    if(!text && !file && !hadFile) return ui.toast("Escribe una respuesta o adjunta un archivo","err");
    const btn=document.querySelector('#taskBody .btn-primary'); if(btn){ btn.disabled=true; btn.textContent="Enviando…"; }
    let fileData=null;
    if(file){ try{ fileData=await uploadAny(file); }catch(e){ ui.toast(e.message,"err"); if(btn){btn.disabled=false;btn.textContent="Entregar tarea";} return; } }
    const row={ course_id:courseId, user_id:state.profile.id, text:text||null,
      status:"submitted", grade:null, feedback:null, graded_at:null, submitted_at:new Date().toISOString() };
    if(fileData){ row.file_url=fileData.url; row.file_name=fileData.name; }
    const {error}=await sb.from("course_submissions").upsert(row,{onConflict:"course_id,user_id"});
    if(error) return ui.toast(/relation|does not exist/i.test(error.message)?"Falta ejecutar migration_v15.sql":error.message,"err");
    ui.toast("Tarea entregada","ok"); viewCourseDetail(courseId);
  },
  courseGo(idx){ state.cache.courseSel={type:"module",idx}; renderCourse(); window.scrollTo({top:0,behavior:"smooth"}); },
  courseSel(type){ const cd=state.cache.cd; if(!cd) return;
    if((type==="exam"||type==="task") && !courseAllDone(cd)) return ui.toast("Completa todos los módulos primero","err");
    state.cache.courseSel={type}; renderCourse(); window.scrollTo({top:0,behavior:"smooth"}); },
  async completeAndNext(idx){
    const cd=state.cache.cd; if(!cd) return; const mo=cd.modules[idx]; if(!mo) return;
    if(!cd.modsDone.includes(mo.id)){
      cd.modsDone.push(mo.id);
      const allDone=courseAllDone(cd);
      const patch={modules_done:cd.modsDone}; if(allDone) patch.completed=true;
      const {error}=await saveProgress(cd.c.id,patch);
      if(error){ cd.modsDone=cd.modsDone.filter(x=>x!==mo.id);
        return ui.toast(/relation|does not exist|column/i.test(error.message)?"Falta ejecutar migration_v17.sql":error.message,"err"); }
      if(allDone){ cd.completed=true; ui.toast("¡Completaste todos los módulos! 🎉","ok"); }
    }
    const allDone=courseAllDone(cd);
    if(idx<cd.modules.length-1) state.cache.courseSel={type:"module",idx:idx+1};
    else if(allDone && cd.exam.length) state.cache.courseSel={type:"exam"};
    else if(allDone && cd.c.assignment) state.cache.courseSel={type:"task"};
    else state.cache.courseSel={type:"module",idx};
    renderCourse(); window.scrollTo({top:0,behavior:"smooth"});
  },
  async markCourseComplete(on){
    const cd=state.cache.cd; if(!cd) return;
    const patch={completed:on};
    if(on) patch.modules_done=cd.modules.map(mo=>mo.id);
    const {error}=await saveProgress(cd.c.id,patch);
    if(error) return ui.toast(/relation|does not exist|column/i.test(error.message)?"Falta ejecutar migration_v17.sql":error.message,"err");
    cd.completed=on; if(on) cd.modsDone=cd.modules.map(mo=>mo.id);
    ui.toast(on?"Curso marcado como completado 🎉":"Marcado como pendiente","ok");
    renderCourse();
  },
  startExam(id){
    const c=state.cache.currentCourse||(state.cache.cmapCourses||[]).find(x=>x.id===id);
    const exam=(c&&c.exam)||[]; if(!exam.length) return;
    state.cache.currentExam={id,exam};
    const body=$("#examBody"); const btn=$("#examStartBtn"); if(btn) btn.style.display="none";
    body.innerHTML = exam.map((q,qi)=>`<div class="quiz-q" data-qi="${qi}">
      <p class="quiz-qtext">${qi+1}. ${esc(q.q)}</p>
      <div class="quiz-opts">${q.options.map((o,oi)=>`<label class="quiz-opt">
        <input type="radio" name="q${qi}" value="${oi}"><span>${esc(o)}</span></label>`).join("")}</div></div>`).join("")
      + `<button class="btn btn-primary btn-sm" style="width:auto;margin-top:.4rem" onclick="app.submitExam('${id}')">Enviar respuestas</button>
         <div id="quizResult"></div>`;
  },
  async submitExam(id){
    const cur=state.cache.currentExam; if(!cur||cur.id!==id) return;
    const exam=cur.exam;
    let correct=0, answered=0;
    exam.forEach((q,qi)=>{ const sel=document.querySelector(`input[name="q${qi}"]:checked`);
      if(sel){ answered++; if(+sel.value===q.correct) correct++; } });
    if(answered<exam.length) return ui.toast("Responde todas las preguntas","err");
    const score=Math.round(100*correct/exam.length), passed=score>=60;
    const patch = passed ? {exam_score:score, completed:true} : {exam_score:score};
    const {error}=await saveProgress(id,patch);
    if(error) return ui.toast(/relation|does not exist/i.test(error.message)?"Falta ejecutar migration_v14.sql":error.message,"err");
    const cd=state.cache.cd; if(cd){ cd.prExamScore=score; if(passed) cd.completed=true; refreshCurriculum(); }
    const res=$("#quizResult");
    if(res) res.innerHTML=`<div class="quiz-result ${passed?"pass":"fail"}">
      ${passed?"✓":"✕"} Obtuviste <b>${score}%</b> (${correct}/${exam.length}).
      ${passed?" ¡Aprobado! El curso quedó completado.":" Necesitas 60% para aprobar — puedes intentarlo otra vez."}
      <div style="margin-top:.6rem"><button class="btn btn-ghost btn-sm" style="width:auto" onclick="app.courseGo(0)">Volver a los módulos</button></div></div>`;
  },

  // admin: activar/desactivar premium
  async togglePremium(uid,on){
    const {error}=await sb.from("profiles").update({premium_portfolio:on}).eq("id",uid);
    if(error){ ui.toast(error.message,"err"); const c=$("#premChk"); if(c)c.checked=!on; return; }
    ui.toast(on?"Ajuste de portafolio habilitado":"Servicio deshabilitado","ok");
  },
  async toggleQuantnet(uid,on){
    const {error}=await sb.from("profiles").update({premium_quantnet:on}).eq("id",uid);
    if(error){ ui.toast(error.message,"err"); const c=$("#qnChk"); if(c)c.checked=!on; return; }
    ui.toast(on?"QuantNet habilitado":"QuantNet deshabilitado","ok");
  },
  async toggleCourses(uid,on){
    const {error}=await sb.from("profiles").update({premium_courses:on}).eq("id",uid);
    if(error){ ui.toast(error.message,"err"); const c=$("#cuChk"); if(c)c.checked=!on; return; }
    ui.toast(on?"Cursos premium habilitados":"Cursos premium deshabilitados","ok");
  },

  // operar (Alpaca sandbox)
  searchAssets(q){
    q=(q||"").trim();
    clearTimeout(state.cache.searchT);
    const box=$("#symResults"); if(!box) return;
    if(q.length<1){ box.classList.add("hidden"); box.innerHTML=""; return; }
    state.cache.searchT=setTimeout(async ()=>{
      try{
        const { data:{ session } }=await sb.auth.getSession();
        const r=await fetch("/api/alpaca-assets?q="+encodeURIComponent(q),{ headers:{ Authorization:"Bearer "+session.access_token } });
        const d=await r.json();
        if(!d.ok || !d.results.length){
          box.innerHTML=`<div class="sr-empty">Sin coincidencias para "${esc(q)}"</div>`;
          box.classList.remove("hidden"); return;
        }
        box.innerHTML=d.results.map(a=>`<div class="sr-item" onclick="app.pickSym('${esc(a.symbol)}')">
          <div><b class="mono">${esc(a.symbol)}</b> <span class="sr-name">${esc(a.name)}</span></div>
          <span class="sr-ex">${a.fractionable?"":'<span class="sr-whole">solo unidades enteras</span> '}${esc(a.exchange||"")}</span>
        </div>`).join("");
        box.classList.remove("hidden");
      }catch(e){ box.classList.add("hidden"); }
    }, 250);
  },
  pickSym(sym){ app.pickTradeSym(sym); },
  pickTradeSym(sym){
    state.cache.tradeSym=(sym||"").toUpperCase();
    const inp=$("#buySym"); if(inp) inp.value=state.cache.tradeSym;
    const ord=$("#ordSym"); if(ord) ord.value=state.cache.tradeSym;
    const box=$("#symResults"); if(box){ box.classList.add("hidden"); box.innerHTML=""; }
    const h=document.querySelector(".trade-chart-card h3"); if(h) h.textContent=state.cache.tradeSym;
    tvWidget(state.cache.tradeSym); loadOrderPrice(state.cache.tradeSym);
  },
  tradeSelectPf(id){ state.cache.tradePf=id; renderTrade(); },
  tradeEstimate(){
    const price=state.cache.tradePrice, amt=parseFloat($("#ordAmt")?.value), est=$("#ordEst");
    if(!est) return;
    if(price==null||!amt||amt<=0){ est.textContent=""; return; }
    est.innerHTML=`≈ <b>${(amt/price).toFixed(4)}</b> unidades a ${money(price,"USD")}`;
  },
  async buyAsset(){
    const pf=(state.cache.portfolios||[]).find(p=>p.id===state.cache.tradePf);
    const box=$("#ordMsg"); if(box) box.className="msg-line";
    if(!pf){ if(box){box.textContent="Selecciona un portafolio.";box.classList.add("err");} return; }
    const sym=state.cache.tradeSym, price=state.cache.tradePrice, amt=parseFloat($("#ordAmt")?.value);
    if(price==null){ box.textContent="No hay precio disponible para este activo."; box.classList.add("err"); return; }
    if(!amt||amt<=0){ box.textContent="Indica un monto válido."; box.classList.add("err"); return; }
    if(amt>num(pf.cash)+1e-6){ box.textContent="Efectivo insuficiente en este portafolio."; box.classList.add("err"); return; }
    const qty=amt/price, holds=(pf.holdings||[]).slice(), i=holds.findIndex(h=>h.ticker===sym);
    if(i>=0){ const oQ=num(holds[i].quantity)||0,oC=num(holds[i].avg_cost)||0,nQ=oQ+qty;
      holds[i]={...holds[i],quantity:nQ,avg_cost:(oQ*oC+qty*price)/nQ}; }
    else holds.push({ticker:sym,name:sym,asset_class:classOf(sym),quantity:qty,avg_cost:price});
    const newCash=num(pf.cash)-amt;
    const {error}=await sb.from("sim_portfolios").update({cash:newCash,holdings:holds}).eq("id",pf.id);
    if(error){ box.textContent=/relation|does not exist/i.test(error.message)?"Falta ejecutar migration_v19.sql":error.message; box.classList.add("err"); return; }
    pf.cash=newCash; pf.holdings=holds;
    ui.toast(`Compraste ${qty.toFixed(4)} de ${sym}`,"ok"); $("#ordAmt").value=""; renderTrade();
  },
  async sellAsset(){
    const pf=(state.cache.portfolios||[]).find(p=>p.id===state.cache.tradePf);
    const box=$("#ordMsg"); if(box) box.className="msg-line";
    if(!pf) return;
    const sym=state.cache.tradeSym, price=state.cache.tradePrice, amt=parseFloat($("#ordAmt")?.value);
    const holds=(pf.holdings||[]).slice(), i=holds.findIndex(h=>h.ticker===sym);
    if(i<0){ box.textContent="No tienes ese activo en este portafolio."; box.classList.add("err"); return; }
    if(price==null){ box.textContent="No hay precio disponible."; box.classList.add("err"); return; }
    if(!amt||amt<=0){ box.textContent="Indica el monto a vender."; box.classList.add("err"); return; }
    const have=num(holds[i].quantity)||0; let sellQty=amt/price; if(sellQty>have) sellQty=have;
    const proceeds=sellQty*price, remain=have-sellQty;
    if(remain<=1e-9) holds.splice(i,1); else holds[i]={...holds[i],quantity:remain};
    const newCash=num(pf.cash)+proceeds;
    const {error}=await sb.from("sim_portfolios").update({cash:newCash,holdings:holds}).eq("id",pf.id);
    if(error){ box.textContent=error.message; box.classList.add("err"); return; }
    pf.cash=newCash; pf.holdings=holds;
    ui.toast(`Vendiste ${sellQty.toFixed(4)} de ${sym}`,"ok"); $("#ordAmt").value=""; renderTrade();
  },
  async createPortfolio(goTrade){
    const pfs=state.cache.portfolios||[];
    if(pfs.length>=10) return ui.toast("Llegaste al límite de 10 portafolios","err");
    const name=(prompt("Nombre del portafolio (ej. Portafolio prueba 1):","Portafolio prueba "+(pfs.length+1))||"").trim();
    if(!name) return;
    const {data,error}=await sb.from("sim_portfolios").insert({user_id:state.profile.id,name,cash:10000,holdings:[]}).select().single();
    if(error) return ui.toast(/relation|does not exist/i.test(error.message)?"Falta ejecutar migration_v19.sql":(/límite|limit/i.test(error.message)?"Límite de 10 portafolios":error.message),"err");
    await loadSimPortfolios();
    ui.toast("Portafolio creado 🎉","ok");
    if(goTrade){ state.cache.tradePf=data.id; renderTrade(); } else renderPortfolioList();
  },
  openPortfolio(id){ renderPortfolioDetail(id); window.scrollTo({top:0,behavior:"smooth"}); },
  backToPortfolios(){ renderPortfolioList(); },
  async deletePortfolio(id,ev){ if(ev) ev.stopPropagation();
    const pf=(state.cache.portfolios||[]).find(p=>p.id===id);
    if(!confirm(`¿Eliminar "${pf?.name||"este portafolio"}"? No se puede deshacer.`)) return;
    const {error}=await sb.from("sim_portfolios").delete().eq("id",id);
    if(error) return ui.toast(error.message,"err");
    await loadSimPortfolios(); ui.toast("Portafolio eliminado","ok"); renderPortfolioList();
  },
  async renamePortfolio(id){
    const pf=(state.cache.portfolios||[]).find(p=>p.id===id); if(!pf) return;
    const name=(prompt("Nuevo nombre:",pf.name)||"").trim(); if(!name||name===pf.name) return;
    const {error}=await sb.from("sim_portfolios").update({name}).eq("id",id);
    if(error) return ui.toast(error.message,"err");
    pf.name=name; ui.toast("Renombrado","ok"); renderPortfolioDetail(id);
  },
  tradeInPortfolio(id){ state.cache.tradePf=id; location.hash="#/operar"; },

  // admin: vincular cuenta Alpaca del cliente
  async saveAlpacaId(uid){
    const val=$("#alpacaId").value.trim()||null;
    const {error}=await sb.from("profiles").update({alpaca_account_id:val}).eq("id",uid);
    if(error) return ui.toast(error.message,"err");
    ui.toast(val?"Cuenta de inversión vinculada":"Vínculo eliminado","ok");
  },
  async fundAccount(accountId){
    const btn=$("#fundBtn"), msg=$("#setupMsg");
    btn.disabled=true; const prev=btn.textContent; btn.innerHTML='<span class="spinner"></span> Fondeando…';
    msg.textContent="";
    try{
      const { data:{ session } }=await sb.auth.getSession();
      const r=await fetch("/api/alpaca-setup",{ method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token },
        body:JSON.stringify({ fundAccountId:accountId, amount:"50000" }) });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/alpaca-setup no está desplegada.");
      const d=await r.json();
      if(!d.ok) throw new Error(d.message||"No se pudo fondear");
      msg.innerHTML=`✓ ${esc(d.fundMsg||"Fondeada")}. El cliente ya puede comprar.`;
      ui.toast("Cuenta fondeada","ok");
    }catch(e){ msg.innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; }
    finally{ btn.disabled=false; btn.textContent=prev; }
  },
  async createTestAccount(uid){
    const btn=$("#setupBtn"), msg=$("#setupMsg");
    msg.textContent="";
    try{
      const { data:{ session } }=await sb.auth.getSession();
      const r=await fetch("/api/alpaca-setup",{ method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token } });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/alpaca-setup no está desplegada.");
      const d=await r.json();
      if(!d.ok) throw new Error(d.message||"No se pudo crear la cuenta");
      // autocompletar y vincular
      $("#alpacaId").value=d.account_id;
      await sb.from("profiles").update({alpaca_account_id:d.account_id}).eq("id",uid);
      msg.innerHTML=`✓ Cuenta <span class="mono">${esc(d.account_id.slice(0,8))}…</span> creada y vinculada. ${d.funded?"Fondeada con $50 000 de prueba.":"⚠ "+esc(d.fundMsg||"Fondeo pendiente.")}`;
      ui.toast("Cuenta de prueba lista","ok");
    }catch(e){ msg.innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; }
    finally{ btn.disabled=false; btn.textContent=prev; }
  },

  // campana de notificaciones (esquina)
  async toggleBell(ev){
    if(ev) ev.stopPropagation();
    const panel=$("#bellPanel");
    if(!panel.classList.contains("hidden")){ panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    panel.innerHTML=`<div class="bell-head"><b>Notificaciones</b></div><div class="bell-list">${loading()}</div>`;
    const ns=await sb.from("notifications").select("*").eq("user_id",state.profile.id)
      .order("created_at",{ascending:false}).limit(12).then(r=>r.data||[]);
    const unread=ns.filter(n=>!n.read).length;
    const ICONS={mensaje:"chat",evento:"cal",cartera:"pie",curso:"book",general:"bell"};
    let body;
    if(!ns.length){
      body=`<div class="bell-empty">${icon("bell")}<p>No tienes notificaciones.</p></div>`;
    } else {
      body=ns.map((n,i)=>`<div class="bell-item ${n.read?"":"unread"}" data-ni="${i}">
        <div class="bi-ic">${icon(ICONS[n.kind]||"bell")}</div>
        <div class="bi-main"><b>${esc(n.title)}</b><span>${esc(n.body||"")}</span>
          <i>${fmtTime(n.created_at)}</i></div></div>`).join("");
    }
    panel.innerHTML=`<div class="bell-head"><b>Notificaciones</b>
      ${unread?`<button onclick="app.readAll()">Marcar leídas</button>`:""}</div>
      <div class="bell-list">${body}</div>`;
    panel.querySelectorAll("[data-ni]").forEach(elm=>{
      elm.onclick=()=>app.openNotif(ns[+elm.dataset.ni]);
    });
  },

  // notificaciones
  async openNotif(n){
    $("#bellPanel")?.classList.add("hidden");
    if(!n.read){ await sb.from("notifications").update({read:true}).eq("id",n.id); refreshBadges(); }
    if(n.link) location.hash=n.link; else render();
  },
  async readAll(){
    await sb.from("notifications").update({read:true}).eq("user_id",state.profile.id).eq("read",false);
    refreshBadges();
    $("#bellPanel")?.classList.add("hidden");
    ui.toast("Marcadas como leídas","ok");
  },

  // asistente IA
  async askBot(preset){
    const inp=$("#botIn");
    const text=(preset||inp.value).trim(); if(!text) return;
    if(!preset) inp.value="";
    state.cache.bot=state.cache.bot||[];
    state.cache.bot.push({role:"user",content:text});
    renderBot();
    const box=$("#chat");
    const thinking=el(`<div class="bubble them"><span class="spinner" style="border-color:rgba(120,150,200,.3);border-top-color:var(--blue-400)"></span></div>`);
    box.append(thinking); box.scrollTop=box.scrollHeight;
    const btn=$("#botBtn"); btn.disabled=true;
    try{
      const { data:{ session } }=await sb.auth.getSession();
      const r=await fetch("/api/chat",{ method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token },
        body:JSON.stringify({ messages:state.cache.bot.filter(x=>x.role!=="error") }) });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/chat no está desplegada.");
      const d=await r.json();
      if(!d.ok){
        if(d.error==="quota"){
          state.cache.bot.pop();               // no gastar el turno en el historial
          state.cache.bot.push({role:"error",content:d.message});
          paintQuota({remaining:0,limit:d.limit||5});
          renderBot(); btn.disabled=true; return;
        }
        throw new Error(d.message||"Error del asistente");
      }
      state.cache.bot.push({role:"assistant",content:d.reply});
      if(!d.unlimited) paintQuota(d);
    }catch(e){
      state.cache.bot.push({role:"error",content:e.message});
    }
    if(!$("#botIn")?.disabled) btn.disabled=false;
    renderBot(); $("#botIn")?.focus();
  },

  // perfil del cliente
  async pickAvatar(input){
    const file=input.files?.[0]; if(!file) return;
    const box=$("#prev_avatar"); box.classList.add("has"); box.innerHTML='<span class="spinner"></span>';
    try{
      const url=await uploadImage(file,`avatars/${state.profile.id}`);
      $("#url_avatar").value=url;
      box.innerHTML=`<img src="${esc(url)}" alt="">`;
      ui.toast("Foto subida. No olvides guardar.","ok");
    }catch(e){
      box.classList.remove("has"); box.innerHTML=`<span>${initials(state.profile.full_name)}</span>`;
      ui.toast(/bucket|policy|row-level/i.test(e.message)?"Falta ejecutar migration_v5.sql en Supabase":e.message,"err");
    }
    input.value="";
  },
  clearAvatar(){
    $("#url_avatar").value="";
    const box=$("#prev_avatar"); box.classList.remove("has");
    box.innerHTML=`<span>${initials(state.profile.full_name)}</span>`;
  },
  async saveProfileInfo(){
    const upd={ full_name:$("#pfFull").value.trim()||state.profile.full_name,
      phone:$("#phIn").value.trim()||null,
      birth_date:$("#pfBirth").value||null,
      avatar_url:$("#url_avatar").value.trim()||null };
    const {error}=await sb.from("profiles").update(upd).eq("id",state.profile.id);
    if(error) return ui.toast(error.message,"err");
    Object.assign(state.profile,upd);
    $("#uName").textContent=state.profile.full_name||"—";
    const av=$("#uAvatar"), avm=$("#uAvatarMob");
    if(upd.avatar_url){ av.innerHTML=`<img src="${esc(upd.avatar_url)}" alt="">`; if(avm) avm.innerHTML=`<img src="${esc(upd.avatar_url)}" alt="">`; }
    else { av.textContent=initials(state.profile.full_name); if(avm) avm.textContent=initials(state.profile.full_name); }
    ui.toast("Perfil actualizado","ok");
  },

  // admin: iniciar conversación
  newThread(){
    const box=$("#newThread"); if(box.dataset.open){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    box.innerHTML=`<div class="card"><div class="card-sub">Cargando clientes…</div></div>`;
    sb.from("profiles").select("id,full_name,email").eq("role","client").order("full_name")
      .then(({data})=>{
        const cs=data||[];
        if(!cs.length){ box.innerHTML=`<div class="card"><p class="card-sub" style="margin:0">No hay clientes registrados.</p></div>`; return; }
        box.innerHTML=`<div class="card">
          <div class="field"><label>Elige un cliente</label>
            <select id="ntSel" class="input">${cs.map(c=>`<option value="${c.id}">${esc(c.full_name||c.email)}</option>`).join("")}</select></div>
          <button class="btn btn-primary btn-sm" style="width:auto"
            onclick="location.hash='#/mensajes/'+document.getElementById('ntSel').value">Abrir conversación</button></div>`;
      });
  },

  // imágenes
  previewImage(id,url){
    const box=$("#prev_"+id);
    if(!url){ box.innerHTML="<span>Sin imagen</span>"; box.classList.remove("has"); return; }
    box.classList.add("has");
    box.innerHTML=`<img src="${esc(url)}" alt="" onerror="this.parentNode.classList.remove('has');this.parentNode.innerHTML='<span>No se pudo cargar</span>'">`;
  },
  async pickImage(id,input){
    const file=input.files?.[0]; if(!file) return;
    const box=$("#prev_"+id);
    box.classList.add("has"); box.innerHTML='<span class="spinner"></span>';
    try{
      const url=await uploadImage(file, id==="post"?"posts":"courses");
      $("#url_"+id).value=url; app.previewImage(id,url);
      ui.toast("Imagen subida","ok");
    }catch(e){
      app.clearImage(id);
      ui.toast(/bucket|not found/i.test(e.message)?"Falta ejecutar migration_v4.sql en Supabase":e.message,"err");
    }
    input.value="";
  },
  clearImage(id){ $("#url_"+id).value=""; app.previewImage(id,""); },

  // publicaciones
  postForm(post){
    const box=$("#postForm");
    if(box.dataset.open && !post){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    const p=post||{};
    const isIdea=p.kind==="idea";
    box.innerHTML=`<div class="card">
      ${post?`<div class="flex between"><b>Editar publicación</b><button class="btn btn-ghost btn-sm" onclick="app.postForm()">Cancelar</button></div><div class="divide"></div>`:""}
      <input type="hidden" id="pId" value="${esc(p.id||"")}">
      <div class="field" style="max-width:200px"><label>Tipo</label>
        <select id="pKind" class="input" onchange="app.postKindChange()">
          <option value="noticia" ${p.kind==="noticia"?"selected":""}>Noticia</option>
          <option value="idea" ${isIdea?"selected":""}>Idea de inversión</option></select></div>
      <div class="field"><label>Imagen de portada</label>${imagePicker("post",p.image_url)}</div>
      <div class="field"><label>Título</label><input id="pTitle" class="input" value="${esc(p.title||"")}"></div>
      <div class="field"><label>Contenido / tesis</label><textarea id="pBody" class="input">${esc(p.body||"")}</textarea></div>
      <div class="field"><label>Enlace a la fuente (opcional)</label><input id="pUrl" class="input" placeholder="https://…" value="${esc(p.source_url||"")}"></div>
      <div id="ideaFields" class="${isIdea?"":"hidden"}">
        <div class="divide"></div>
        <div class="flex" style="gap:.8rem;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:110px"><label>Ticker</label><input id="pTicker" class="input mono" placeholder="AAPL" value="${esc(p.ticker||"")}"></div>
          <div class="field" style="flex:1;min-width:120px"><label>Dirección</label>
            <select id="pDir" class="input">
              <option value="compra" ${p.direction==="compra"?"selected":""}>Compra</option>
              <option value="venta" ${p.direction==="venta"?"selected":""}>Venta</option>
              <option value="mantener" ${p.direction==="mantener"?"selected":""}>Mantener</option></select></div>
          <div class="field" style="flex:1;min-width:120px"><label>Precio objetivo</label><input id="pTarget" class="input mono" type="number" step="any" value="${p.target_price??""}"></div>
          <div class="field" style="flex:1;min-width:120px"><label>Horizonte</label><input id="pHor" class="input" placeholder="6–12 meses" value="${esc(p.horizon||"")}"></div>
        </div>
        <div class="field"><label>Potencial de crecimiento / rentabilidad</label>
          <textarea id="pPotential" class="input" placeholder="Ej. Alto — se estima un potencial de +25% a 12 meses si se cumple la tesis. Riesgo principal: …">${esc(p.potential||"")}</textarea></div>
      </div>
      <div class="flex mt"><label class="flex" style="gap:.4rem;color:var(--muted);font-size:.85rem"><input type="checkbox" id="pPub" ${(p.published??true)?"checked":""}> Publicar de inmediato</label>
        <button class="btn btn-primary btn-sm" style="width:auto;margin-left:auto" onclick="app.savePost()">${post?"Guardar cambios":"Guardar publicación"}</button></div></div>`;
    if(post) box.scrollIntoView({behavior:"smooth",block:"start"});
  },
  async editPost(id){
    const p=await sb.from("posts").select("*").eq("id",id).single().then(r=>r.data);
    if(!p) return ui.toast("No se encontró la publicación","err");
    app.postForm(p);
  },
  postKindChange(){ $("#ideaFields").classList.toggle("hidden", $("#pKind").value!=="idea"); },
  async savePost(){
    const t=$("#pTitle").value.trim(); if(!t) return ui.toast("Ponle un título","err");
    const kind=$("#pKind").value;
    const row={ kind, title:t, body:$("#pBody").value.trim(), source_url:$("#pUrl").value.trim()||null,
      image_url:$("#url_post").value.trim()||null, published:$("#pPub").checked };
    if(kind==="idea"){
      row.ticker=$("#pTicker").value.trim().toUpperCase()||null;
      row.direction=$("#pDir").value; row.target_price=num($("#pTarget").value);
      row.horizon=$("#pHor").value.trim()||null;
      row.potential=$("#pPotential").value.trim()||null;
    } else {
      row.ticker=null; row.potential=null;
    }
    const id=$("#pId").value;
    let error;
    if(id){ ({error}=await sb.from("posts").update(row).eq("id",id)); }
    else { row.created_by=state.profile.id; row.status="abierta"; ({error}=await sb.from("posts").insert(row)); }
    if(error) return ui.toast(error.message,"err");
    ui.toast(id?"Cambios guardados":"Publicación creada","ok"); render();
  },
  async togglePost(id,pub){ await sb.from("posts").update({published:pub}).eq("id",id); render(); },
  async closeIdea(id,status){ await sb.from("posts").update({status}).eq("id",id); render(); },
  async delPost(id){ if(!confirm("¿Eliminar esta publicación?"))return; await sb.from("posts").delete().eq("id",id); render(); },

  // eliminación de clientes
  async exportClient(uid){
    const [p,ra,pfs,msgs]=await Promise.all([
      sb.from("profiles").select("*").eq("id",uid).single().then(r=>r.data),
      sb.from("risk_assessments").select("*").eq("user_id",uid).then(r=>r.data),
      sb.from("portfolios").select("*").eq("user_id",uid).then(r=>r.data),
      sb.from("messages").select("*").eq("client_id",uid).then(r=>r.data),
    ]);
    const ids=(pfs||[]).map(x=>x.id);
    const holds= ids.length ? await sb.from("holdings").select("*").in("portfolio_id",ids).then(r=>r.data) : [];
    const dump={ exportado:new Date().toISOString(), perfil:p, evaluaciones:ra,
                 carteras:pfs, posiciones:holds, mensajes:msgs };
    const blob=new Blob([JSON.stringify(dump,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=`invexia-${(p?.full_name||uid).replace(/\s+/g,"-").toLowerCase()}.json`; a.click();
    ui.toast("Datos exportados","ok");
  },
  confirmDelete(uid,name){
    const old=$("#modal"); if(old) old.remove();
    const modal=el(`<div id="modal" class="modal-bg">
      <div class="modal">
        <h3>Eliminar cuenta</h3>
        <p class="card-sub">Vas a eliminar permanentemente a <b>${esc(name)}</b> y todos sus datos:
          perfil de riesgo, cartera, posiciones y mensajes. <b>Esta acción no se puede deshacer.</b></p>
        <div class="field"><label>Para confirmar, escribe <b class="mono">ELIMINAR</b></label>
          <input id="delWord" class="input mono" placeholder="ELIMINAR" autocomplete="off"></div>
        <div class="flex between mt">
          <button class="btn btn-ghost btn-sm" onclick="app.closeModal()">Cancelar</button>
          <button id="delBtn" class="btn btn-danger btn-sm" disabled onclick="app.doDelete('${uid}')">Eliminar definitivamente</button>
        </div>
        <div id="delMsg" class="msg-line"></div>
      </div></div>`);
    document.body.append(modal);
    const inp=$("#delWord",modal);
    inp.focus();
    inp.oninput=()=>{ $("#delBtn").disabled = inp.value.trim().toUpperCase()!=="ELIMINAR"; };
    modal.onclick=(e)=>{ if(e.target===modal) app.closeModal(); };
  },
  closeModal(){ $("#modal")?.remove(); },
  async doDelete(uid){
    const btn=$("#delBtn"), box=$("#delMsg");
    btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
    box.className="msg-line";
    try{
      const { data:{ session } } = await sb.auth.getSession();
      const r=await fetch("/api/delete-user",{ method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:"Bearer "+session.access_token },
        body:JSON.stringify({ userId:uid }) });
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json")) throw new Error("La función /api/delete-user no está desplegada.");
      const d=await r.json();
      if(!d.ok) throw new Error(d.message||d.error||"Error desconocido");
      app.closeModal();
      ui.toast("Cuenta eliminada","ok");
      location.hash="#/clientes";
    }catch(e){
      box.textContent=e.message; box.classList.add("err");
      btn.disabled=false; btn.textContent="Eliminar definitivamente";
    }
  },

  // cursos
  async courseForm(course){
    const box=$("#courseForm");
    if(box.dataset.open && !course){ box.innerHTML=""; box.dataset.open=""; return; }
    box.dataset.open="1";
    const c=course||{};
    // lista de otros cursos para elegir continuaciones
    const all=await sb.from("courses").select("id,title,level").order("created_at").then(r=>r.data||[]);
    const others=all.filter(x=>x.id!==c.id);
    const nexts=Array.isArray(c.next_courses)?c.next_courses:[];
    const pick=others.length
      ? others.map(o=>`<label class="conn-opt"><input type="checkbox" value="${o.id}" ${nexts.includes(o.id)?"checked":""}>
          <span>${esc(o.title)} <i>${esc(o.level||"")}</i></span></label>`).join("")
      : `<p class="card-sub" style="margin:0">Crea más cursos para poder conectarlos.</p>`;
    state.cache.courseMaterials = Array.isArray(c.materials)?[...c.materials]:[];
    state.cache.courseExam = Array.isArray(c.exam)?JSON.parse(JSON.stringify(c.exam)):[];
    // módulos: si el curso ya tiene, se usan; si es antiguo (video/materiales sueltos) se migra a un módulo
    let mods = Array.isArray(c.modules)?JSON.parse(JSON.stringify(c.modules)):[];
    if(!mods.length && (c.video_url || (Array.isArray(c.materials)&&c.materials.length)))
      mods=[{id:modId(), title:"Módulo 1", description:"", video_url:c.video_url||"", materials:Array.isArray(c.materials)?[...c.materials]:[]}];
    state.cache.courseModules = mods;
    box.innerHTML=`<div class="card">
      ${course?`<div class="flex between"><b>Editar curso</b><button class="btn btn-ghost btn-sm" onclick="app.courseForm()">Cancelar</button></div><div class="divide"></div>`:""}
      <input type="hidden" id="cId" value="${esc(c.id||"")}">
      <div class="field"><label>Imagen de referencia</label>${imagePicker("course",c.image_url)}</div>
      <div class="field"><label>Título</label><input id="cT" class="input" value="${esc(c.title||"")}"></div>
      <div class="flex" style="gap:.8rem"><div class="field" style="flex:1"><label>Nivel</label>
        <select id="cL" class="input">${["Básico","Intermedio","Avanzado"].map(l=>`<option ${c.level===l?"selected":""}>${l}</option>`).join("")}</select></div>
        <div class="field" style="flex:1"><label>Categoría</label>
          <select id="cCat" class="input">${Object.entries(MCATS).map(([k,v])=>`<option value="${k}" ${(c.category||"fund")===k?"selected":""}>${v.n}</option>`).join("")}</select></div>
        <div class="field" style="flex:2"><label>Enlace externo (opcional)</label><input id="cU" class="input" placeholder="https://…" value="${esc(c.url||"")}"></div></div>
      <div class="field"><label>Descripción general del curso</label><textarea id="cD" class="input">${esc(c.description||"")}</textarea></div>
      <div class="field"><label>Módulos <span style="color:var(--faint);font-weight:400">(cada uno con su video, descripción y materiales)</span></label>
        <div id="modEditor" class="mod-editor"></div>
        <button type="button" class="btn btn-ghost btn-sm" style="width:auto;margin-top:.5rem" onclick="app.addModule()">+ Agregar módulo</button></div>
      <div class="field"><label>Examen <span style="color:var(--faint);font-weight:400">(opción múltiple, se auto-califica)</span></label>
        <div id="examEditor" class="exam-editor"></div>
        <button type="button" class="btn btn-ghost btn-sm" style="width:auto;margin-top:.5rem" onclick="app.addExamQuestion()">+ Agregar pregunta</button></div>
      <div class="field"><label>Tarea <span style="color:var(--faint);font-weight:400">(instrucciones para el cliente; vacío = sin tarea)</span></label>
        <textarea id="cA" class="input" placeholder="Describe la tarea que el cliente debe entregar…">${esc(c.assignment||"")}</textarea></div>
      <div class="field"><label>Después de este curso, sigue… <span style="color:var(--faint);font-weight:400">(dibuja las flechas del mapa)</span></label>
        <div class="conn-grid">${pick}</div></div>
      <div class="flex" style="gap:1.2rem;flex-wrap:wrap;align-items:center">
        <label class="flex" style="gap:.4rem;color:var(--muted);font-size:.85rem"><input type="checkbox" id="cP" ${(c.published??true)?"checked":""}> Publicar de inmediato</label>
        <label class="flex" style="gap:.4rem;color:var(--gold);font-size:.85rem"><input type="checkbox" id="cPrem" ${c.premium?"checked":""}> Curso premium</label>
        <button class="btn btn-primary btn-sm" style="width:auto;margin-left:auto" onclick="app.saveCourse()">${course?"Guardar cambios":"Guardar curso"}</button></div></div>`;
    app.renderMaterials(); app.renderExam(); app.renderModules();
    if(course) box.scrollIntoView({behavior:"smooth",block:"start"});
  },
  async editCourse(id){
    const c=await sb.from("courses").select("*").eq("id",id).single().then(r=>r.data);
    if(!c) return ui.toast("No se encontró el curso","err");
    app.courseForm(c);
  },
  renderMaterials(){
    const box=$("#matList"); if(!box) return;
    const mats=state.cache.courseMaterials||[];
    box.innerHTML = mats.length ? mats.map((mt,i)=>`<div class="mat-item">
      <span class="mat-ic">${mt.kind==="pdf"?"📄":"🖼️"}</span>
      <span class="mat-name">${esc(mt.name||"archivo")}</span>
      <button class="btn btn-ghost btn-sm" onclick="app.removeMaterial(${i})">Quitar</button></div>`).join("")
      : `<p class="card-sub" style="margin:.2rem 0">Sin materiales aún.</p>`;
  },
  async addMaterial(input){
    const file=input.files?.[0]; if(!file) return; input.value="";
    ui.toast("Subiendo archivo…","ok");
    try{
      const mat=await uploadFile(file);
      (state.cache.courseMaterials=state.cache.courseMaterials||[]).push(mat);
      app.renderMaterials();
    }catch(e){ ui.toast(/bucket|not found/i.test(e.message)?"Falta el bucket 'media' (migration_v4.sql)":e.message,"err"); }
  },
  removeMaterial(i){ state.cache.courseMaterials.splice(i,1); app.renderMaterials(); },
  renderModules(){
    const box=$("#modEditor"); if(!box) return;
    const mods=state.cache.courseModules||[];
    box.innerHTML = mods.length ? mods.map((mo,mi)=>`<div class="mod-block" data-mid="${mo.id}">
      <div class="mod-head"><span class="mod-num">Módulo ${mi+1}</span>
        <div class="flex" style="gap:.3rem">
          <button type="button" class="btn btn-ghost btn-sm" onclick="app.moveModule('${mo.id}',-1)" ${mi===0?"disabled":""}>↑</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="app.moveModule('${mo.id}',1)" ${mi===mods.length-1?"disabled":""}>↓</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="app.removeModule('${mo.id}')">Quitar</button></div></div>
      <input class="input mod-title" placeholder="Título del módulo" value="${esc(mo.title||"")}">
      <input class="input mod-video" placeholder="Video de YouTube (opcional)" value="${esc(mo.video_url||"")}">
      <textarea class="input mod-desc" placeholder="Descripción del módulo">${esc(mo.description||"")}</textarea>
      <div class="mat-list" id="modMats_${mo.id}"></div>
      <label class="btn btn-ghost btn-sm" style="cursor:pointer;width:auto;margin-top:.4rem">+ Material
        <input type="file" accept=".pdf,image/*" hidden onchange="app.addModuleMaterial('${mo.id}',this)"></label></div>`).join("")
      : `<p class="card-sub" style="margin:.2rem 0">Sin módulos aún. Agrega el primero.</p>`;
    (state.cache.courseModules||[]).forEach(mo=>app.renderModuleMats(mo.id));
  },
  renderModuleMats(mid){
    const box=$("#modMats_"+mid); if(!box) return;
    const mo=(state.cache.courseModules||[]).find(m=>m.id===mid); const mats=(mo&&mo.materials)||[];
    box.innerHTML = mats.length ? mats.map((mt,i)=>`<div class="mat-item">
      <span class="mat-ic">${mt.kind==="pdf"?"📄":"🖼️"}</span><span class="mat-name">${esc(mt.name||"archivo")}</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="app.removeModuleMaterial('${mid}',${i})">Quitar</button></div>`).join("") : "";
  },
  syncModules(){
    document.querySelectorAll("#modEditor .mod-block").forEach(bl=>{
      const mid=bl.dataset.mid; const mo=(state.cache.courseModules||[]).find(m=>m.id===mid); if(!mo) return;
      mo.title=bl.querySelector(".mod-title").value;
      mo.video_url=bl.querySelector(".mod-video").value;
      mo.description=bl.querySelector(".mod-desc").value;
    });
  },
  addModule(){ app.syncModules(); (state.cache.courseModules=state.cache.courseModules||[]).push({id:modId(),title:"",description:"",video_url:"",materials:[]}); app.renderModules(); },
  removeModule(id){ app.syncModules(); state.cache.courseModules=state.cache.courseModules.filter(m=>m.id!==id); app.renderModules(); },
  moveModule(id,dir){ app.syncModules(); const a=state.cache.courseModules; const i=a.findIndex(m=>m.id===id); const j=i+dir;
    if(i<0||j<0||j>=a.length) return; [a[i],a[j]]=[a[j],a[i]]; app.renderModules(); },
  async addModuleMaterial(mid,input){
    const file=input.files?.[0]; if(!file) return; input.value=""; ui.toast("Subiendo archivo…","ok");
    try{ const mat=await uploadFile(file); const mo=(state.cache.courseModules||[]).find(m=>m.id===mid);
      if(mo){ (mo.materials=mo.materials||[]).push(mat); app.renderModuleMats(mid); } }
    catch(e){ ui.toast(/bucket|not found|mime/i.test(e.message)?"Revisa migration_v16.sql (tipos permitidos)":e.message,"err"); }
  },
  removeModuleMaterial(mid,i){ const mo=(state.cache.courseModules||[]).find(m=>m.id===mid); if(mo){ mo.materials.splice(i,1); app.renderModuleMats(mid); } },
  renderExam(){
    const box=$("#examEditor"); if(!box) return;
    const qs=state.cache.courseExam||[];
    box.innerHTML = qs.length ? qs.map((q,qi)=>`<div class="exam-q" data-qi="${qi}">
      <div class="exam-q-head"><span class="exam-q-num">Pregunta ${qi+1}</span>
        <button type="button" class="btn btn-ghost btn-sm" onclick="app.removeExamQuestion(${qi})">Quitar</button></div>
      <input class="input exam-qtext" placeholder="Escribe la pregunta" value="${esc(q.q||"")}">
      <div class="exam-opts">${[0,1,2,3].map(oi=>`<label class="exam-opt-row">
        <input type="radio" name="correct-${qi}" ${q.correct===oi?"checked":""}>
        <input class="input exam-opt" placeholder="Opción ${oi+1}" value="${esc((q.options&&q.options[oi])||"")}"></label>`).join("")}</div>
      <p class="exam-hint">Marca el círculo de la respuesta correcta.</p></div>`).join("")
      : `<p class="card-sub" style="margin:.2rem 0">Sin preguntas. Este curso no tendrá examen.</p>`;
  },
  syncExam(){
    const qs=[];
    document.querySelectorAll("#examEditor .exam-q").forEach(qd=>{
      const q=qd.querySelector(".exam-qtext").value.trim();
      const opts=[...qd.querySelectorAll(".exam-opt")].map(i=>i.value.trim());
      const radios=[...qd.querySelectorAll('input[type=radio]')];
      let correct=radios.findIndex(r=>r.checked); if(correct<0) correct=0;
      qs.push({q, options:opts, correct});
    });
    state.cache.courseExam=qs;
  },
  addExamQuestion(){ app.syncExam(); (state.cache.courseExam=state.cache.courseExam||[]).push({q:"",options:["","","",""],correct:0}); app.renderExam(); },
  removeExamQuestion(i){ app.syncExam(); state.cache.courseExam.splice(i,1); app.renderExam(); },
  async saveCourse(){
    const t=$("#cT").value.trim(); if(!t) return ui.toast("Ponle un título","err");
    app.syncExam(); app.syncModules();
    // limpiar examen: quitar opciones vacías, descartar preguntas incompletas
    const exam=(state.cache.courseExam||[]).map(q=>{
      const opts=(q.options||[]).map(o=>(o||"").trim());
      const correctText=opts[q.correct]||"";
      const clean=opts.filter(o=>o);
      const correct=Math.max(0,clean.indexOf(correctText));
      return { q:(q.q||"").trim(), options:clean, correct };
    }).filter(q=>q.q && q.options.length>=2);
    // módulos: descartar los completamente vacíos
    const modules=(state.cache.courseModules||[]).map(m=>({
      id:m.id||modId(), title:(m.title||"").trim(), description:(m.description||"").trim(),
      video_url:(m.video_url||"").trim()||null, materials:Array.isArray(m.materials)?m.materials:[]
    })).filter(m=>m.title || m.video_url || m.description || m.materials.length);
    const nexts=[...document.querySelectorAll(".conn-grid input:checked")].map(i=>i.value);
    const row={ title:t, level:$("#cL").value, category:$("#cCat").value, url:$("#cU").value.trim()||null,
      description:$("#cD").value.trim(), image_url:$("#url_course").value.trim()||null,
      published:$("#cP").checked, premium:$("#cPrem").checked,
      modules, video_url:null, materials:[],   // el contenido vive ahora en los módulos
      exam, assignment:$("#cA").value.trim()||null, next_courses:nexts };
    const id=$("#cId").value; let error;
    if(id){ ({error}=await sb.from("courses").update(row).eq("id",id)); }
    else { ({error}=await sb.from("courses").insert(row)); }
    if(error) return ui.toast(error.message,"err");
    ui.toast(id?"Cambios guardados":"Curso creado","ok"); render();
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
    user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    bell:'<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10.5 19a2 2 0 0 0 3 0"/>',
    bot:'<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.2"/><path d="M9 13.5h.01M15 13.5h.01"/>',
    trade:'<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v5h-5"/>',
    tune:'<circle cx="7" cy="8" r="2.2"/><circle cx="16" cy="16" r="2.2"/><path d="M9 8h11M4 8h1M15 16h5M4 16h9"/>',
    net:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="17" r="2"/><path d="M8 7l8 0M7 8l0 8M8 17l7-1M8 7l8 9"/>',
    radar:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/><path d="M12 12l6-4"/>',
    brief:'<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/>',
    term:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l2.5 3L7 15M13 15h4"/>',
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
