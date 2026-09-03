/* ============================================================
   InveXia · Cerebro del mercado en 3D (Three.js)
   Nube de puntos con forma de cerebro (2 lóbulos + pliegues),
   navegación orbital, glow por shader, sinapsis, partículas,
   etiquetas anti-superposición, tooltip y selección de sector.
   Expone window.brain3D(container, data) -> API {setSelected, dispose}
   ============================================================ */
(function () {
  function glowTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.25, "rgba(255,255,255,0.9)");
    rg.addColorStop(0.5, "rgba(255,255,255,0.35)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); return t;
  }

  function brainPos(x, y, z) {
    const L = Math.hypot(x, y, z) || 1; x /= L; y /= L; z /= L;
    const rx = 1.58, ry = 1.02, rz = 1.30;
    const groove = Math.exp(-(x * x) / 0.030);       // surco sagital (separa hemisferios)
    const top = Math.max(0, y);
    const fold = 1 + 0.11 * Math.sin(x * 8 + z * 6) * Math.sin(y * 7 + z * 5); // pliegues
    const rad = (1 - 0.34 * groove * top) * fold * (0.9 + 0.12 * Math.random());
    return [x * rx * rad, y * ry * rad, z * rz * rad];
  }

  function fibDir(i, n) {
    const ga = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  }

  window.brain3D = function (container, data) {
    const W0 = () => container.clientWidth || 800;
    const H0 = () => container.clientHeight || 520;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, W0() / H0(), 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W0(), H0());
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const SCALE = 5.0;
    const sectors = data.sectors;
    const S = sectors.length;
    const tex = glowTexture();

    // ---- construir nodos ----
    const meta = [];
    const posArr = [], colArr = [], sizeArr = [], secArr = [], phArr = [], actArr = [];
    const sectorCenters = sectors.map(() => new THREE.Vector3());
    const sectorCounts = sectors.map(() => 0);
    sectors.forEach((s, si) => {
      const c = fibDir(si, S);
      const maxCh = Math.max(...s.stocks.map(x => Math.abs(x.change_1y || 0)), 1);
      s.stocks.forEach(st => {
        let x = c[0] + (Math.random() - 0.5) * 0.85;
        let y = c[1] + (Math.random() - 0.5) * 0.85;
        let z = c[2] + (Math.random() - 0.5) * 0.85;
        const p = brainPos(x, y, z);
        posArr.push(p[0] * SCALE, p[1] * SCALE, p[2] * SCALE);
        const col = new THREE.Color(s.color);
        colArr.push(col.r, col.g, col.b);
        const act = Math.min(1, Math.abs(st.change_1y || 0) / maxCh);
        sizeArr.push(9 + Math.min(4, (Math.log10((st.mcap || 1e9)) - 8)) * 4);
        secArr.push(si); phArr.push(Math.random() * 6.28); actArr.push(act);
        meta.push({ ticker: st.ticker, ch: st.change_1y, sec: s.name, si, color: s.color });
        sectorCenters[si].add(new THREE.Vector3(p[0] * SCALE, p[1] * SCALE, p[2] * SCALE));
        sectorCounts[si]++;
      });
    });
    sectorCenters.forEach((v, i) => { if (sectorCounts[i]) v.multiplyScalar(1 / sectorCounts[i]); });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colArr, 3));
    geo.setAttribute("aSize", new THREE.Float32BufferAttribute(sizeArr, 1));
    geo.setAttribute("aSector", new THREE.Float32BufferAttribute(secArr, 1));
    geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(phArr, 1));
    geo.setAttribute("aAct", new THREE.Float32BufferAttribute(actArr, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSel: { value: -1 }, uTex: { value: tex }, uPix: { value: H0() } },
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uTime; uniform float uSel; uniform float uPix;
        attribute float aSize; attribute float aSector; attribute float aPhase; attribute float aAct;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vColor = color;
          float pulse = 0.65 + 0.35*sin(uTime*2.0 + aPhase);
          float dim = (uSel >= 0.0 && abs(aSector-uSel) > 0.5) ? 0.12 : 1.0;
          vAlpha = dim * (0.55 + aAct*0.45);
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = aSize * (1.0 + aAct*1.1) * pulse * (uPix*0.013) / max(0.1,-mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex; varying vec3 vColor; varying float vAlpha;
        void main(){
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vColor,1.0) * t * vAlpha;
          if(gl_FragColor.a < 0.01) discard;
        }`
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);

    // ---- sinapsis ----
    const bySector = sectors.map((_, si) => {
      const idx = []; secArr.forEach((v, i) => { if (v === si) idx.push(i); }); return idx;
    });
    function nodeVec(i) { return new THREE.Vector3(posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2]); }
    const linePos = [], lineCol = [], interEdges = [];
    bySector.forEach((idx, si) => {
      const col = new THREE.Color(sectors[si].color);
      for (let k = 0; k < idx.length; k++) {
        const a = idx[k], b = idx[(k + 1 + (Math.random() * 2 | 0)) % idx.length];
        if (a === b) continue;
        const va = nodeVec(a), vb = nodeVec(b);
        linePos.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
        lineCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    });
    for (let si = 0; si < S; si++) {
      [(si + 1) % S, (si + 3) % S, (si + 5) % S].forEach(sj => {
        const A = bySector[si], B = bySector[sj]; if (!A.length || !B.length) return;
        const a = A[Math.random() * A.length | 0], b = B[Math.random() * B.length | 0];
        const va = nodeVec(a), vb = nodeVec(b);
        const col = new THREE.Color(sectors[si].color);
        linePos.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
        lineCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
        interEdges.push({ a: va, b: vb, color: sectors[si].color });
      });
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
    lgeo.setAttribute("color", new THREE.Float32BufferAttribute(lineCol, 3));
    const lmat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(lgeo, lmat);
    scene.add(lines);

    // ---- partículas que viajan por las sinapsis ----
    const PN = 260;
    const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3);
    const parts = [];
    for (let i = 0; i < PN; i++) {
      const e = interEdges.length ? interEdges[Math.random() * interEdges.length | 0] : null;
      parts.push({ e, t: Math.random(), sp: 0.004 + Math.random() * 0.012 });
      const col = new THREE.Color(e ? e.color : "#4FA3FF");
      pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pgeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
    const pmat = new THREE.PointsMaterial({ size: 0.17, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const pPoints = new THREE.Points(pgeo, pmat);
    scene.add(pPoints);

    // ---- controles de órbita (propios) ----
    let theta = 0.6, phi = 1.30, radius = 12, tRadius = 12;
    let tTheta = theta, tPhi = phi, dragging = false, lastX = 0, lastY = 0, idle = 0, pointers = {}, pinch = 0;
    function applyCam() {
      const x = radius * Math.sin(phi) * Math.sin(theta);
      const y = radius * Math.cos(phi);
      const z = radius * Math.sin(phi) * Math.cos(theta);
      camera.position.set(x, y, z); camera.lookAt(0, 0, 0);
    }
    const el = renderer.domElement;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", e => { pointers[e.pointerId] = { x: e.clientX, y: e.clientY }; dragging = true; lastX = e.clientX; lastY = e.clientY; idle = 0; });
    el.addEventListener("pointermove", e => {
      if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      const ids = Object.keys(pointers);
      if (ids.length >= 2) { // pinch
        const a = pointers[ids[0]], b = pointers[ids[1]]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) tRadius = Math.max(6, Math.min(30, tRadius * (pinch / d))); pinch = d; idle = 0; return;
      }
      if (dragging) { tTheta -= (e.clientX - lastX) * 0.006; tPhi = Math.max(0.25, Math.min(Math.PI - 0.25, tPhi - (e.clientY - lastY) * 0.006)); lastX = e.clientX; lastY = e.clientY; idle = 0; }
      onHover(e);
    });
    const up = e => { delete pointers[e.pointerId]; if (Object.keys(pointers).length < 2) pinch = 0; if (Object.keys(pointers).length === 0) dragging = false; };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", e => { e.preventDefault(); tRadius = Math.max(6, Math.min(30, tRadius + Math.sign(e.deltaY) * 0.8)); idle = 0; }, { passive: false });
    let autoRotate = true;
    el.addEventListener("click", e => { if (moved) return; const n = pick(e); if (n) { if (typeof window.__brainOnPick === "function") window.__brainOnPick(n.ticker); } else selectAPI(-1); });
    let downX = 0, downY = 0, moved = false;
    el.addEventListener("pointerdown", e => { downX = e.clientX; downY = e.clientY; moved = false; });
    el.addEventListener("pointermove", e => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) moved = true; });

    // ---- selección ----
    let selected = -1;
    function selectAPI(i) {
      selected = i; mat.uniforms.uSel.value = i;
      if (typeof window.__brainOnSelect === "function") window.__brainOnSelect(i);
    }

    // ---- hover / tooltip ----
    const tip = document.getElementById("brainTip");
    const proj = new THREE.Vector3();
    function screenOf(v) { proj.copy(v).project(camera); return { x: (proj.x * 0.5 + 0.5) * W0(), y: (-proj.y * 0.5 + 0.5) * H0(), z: proj.z }; }
    function onHover(e) {
      const r = el.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const n = pickAt(mx, my);
      if (n && tip) { tip.style.display = "block"; tip.style.left = (mx + 14) + "px"; tip.style.top = (my - 6) + "px";
        tip.style.borderColor = n.color; tip.innerHTML = `<b>${n.ticker}</b> <span style="color:${n.ch >= 0 ? '#3DD6A0' : '#c96a6a'}">${n.ch >= 0 ? '+' : ''}${n.ch == null ? '—' : n.ch}%</span><br><span class="tp-lo-sec">${n.sec}</span><br><span class="tp-hint2">clic para analizar →</span>`; }
      else if (tip) tip.style.display = "none";
    }
    function pickAt(mx, my) {
      let best = 16, hit = null;
      for (let i = 0; i < meta.length; i++) { const s = screenOf(nodeVec(i)); if (s.z > 1) continue; const d = Math.hypot(s.x - mx, s.y - my); if (d < best) { best = d; hit = meta[i]; } }
      return hit;
    }
    function pick(e) { const r = el.getBoundingClientRect(); return pickAt(e.clientX - r.left, e.clientY - r.top); }
    el.addEventListener("pointerleave", () => { if (tip) tip.style.display = "none"; });

    // ---- etiquetas HTML anti-superposición ----
    const labelLayer = document.getElementById("brainLabels");
    let labelEls = [];
    if (labelLayer) {
      labelLayer.innerHTML = "";
      labelEls = sectors.map((s, i) => { const d = document.createElement("div"); d.className = "b3-label"; d.style.color = s.color;
        d.innerHTML = `<b>${s.name}</b><span>${s.count} activos · ${s.avg >= 0 ? '+' : ''}${s.avg}%</span>`; labelLayer.appendChild(d); return d; });
    }
    function updateLabels() {
      if (!labelEls.length) return;
      const placed = [];
      const order = sectors.map((s, i) => ({ i, d: sectorCenters[i].distanceTo(camera.position) })).sort((a, b) => a.d - b.d);
      order.forEach(({ i }) => {
        const el2 = labelEls[i]; const sc = screenOf(sectorCenters[i]);
        if (sc.z > 1 || sc.x < 0 || sc.x > W0() || sc.y < 0 || sc.y > H0()) { el2.style.display = "none"; return; }
        // evitar solape
        let clash = false; for (const p of placed) { if (Math.abs(p.x - sc.x) < 95 && Math.abs(p.y - sc.y) < 30) { clash = true; break; } }
        const isSel = selected === i;
        if (clash && !isSel) { el2.style.display = "none"; return; }
        placed.push({ x: sc.x, y: sc.y });
        el2.style.display = "block";
        el2.style.left = sc.x + "px"; el2.style.top = sc.y + "px";
        const fade = Math.max(0.35, 1 - (sc.z) * 0.6);
        el2.style.opacity = (selected >= 0 && !isSel) ? 0.28 : fade;
        el2.classList.toggle("sel", isSel);
      });
    }

    // ---- resize ----
    let ro; try { ro = new ResizeObserver(() => { renderer.setSize(W0(), H0()); camera.aspect = W0() / H0(); camera.updateProjectionMatrix(); mat.uniforms.uPix.value = H0(); }); ro.observe(container); } catch (e) {}

    // ---- loop ----
    let t = 0, stopped = false;
    function frame() {
      if (stopped || !document.body.contains(container)) { dispose(); return; }
      t += 0.016; mat.uniforms.uTime.value = t; idle += 0.016;
      if (autoRotate && idle > 2.5 && !dragging) tTheta += 0.0016;
      theta += (tTheta - theta) * 0.08; phi += (tPhi - phi) * 0.08; radius += (tRadius - radius) * 0.08;
      applyCam();
      // partículas
      for (let i = 0; i < PN; i++) { const pt = parts[i]; if (!pt.e) continue; pt.t += pt.sp; if (pt.t >= 1) { pt.t = 0; if (interEdges.length) pt.e = interEdges[Math.random() * interEdges.length | 0]; const col = new THREE.Color(pt.e.color); pCol[i*3]=col.r;pCol[i*3+1]=col.g;pCol[i*3+2]=col.b; }
        const a = pt.e.a, b = pt.e.b; pPos[i*3]=a.x+(b.x-a.x)*pt.t; pPos[i*3+1]=a.y+(b.y-a.y)*pt.t; pPos[i*3+2]=a.z+(b.z-a.z)*pt.t; }
      pgeo.attributes.position.needsUpdate = true; pgeo.attributes.color.needsUpdate = true;
      renderer.render(scene, camera);
      updateLabels();
      requestAnimationFrame(frame);
    }
    applyCam(); requestAnimationFrame(frame);

    function dispose() { stopped = true; try { ro && ro.disconnect(); } catch (e) {} try { renderer.dispose(); geo.dispose(); lgeo.dispose(); pgeo.dispose(); tex.dispose(); } catch (e) {} }

    return { setSelected: (i) => { selected = i; mat.uniforms.uSel.value = (i == null ? -1 : i); }, setAutoRotate: (v) => { autoRotate = v; idle = 0; }, reset: () => { tTheta = 0.6; tPhi = 1.25; tRadius = 12; idle = 0; }, dispose };
  };
})();
