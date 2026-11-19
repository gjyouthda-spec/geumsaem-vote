// 공통 함수
const CFG = window.APP_CONFIG || {};

function configMissing() {
  return !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("YOUR-PROJECT") ||
         !CFG.SUPABASE_KEY || CFG.SUPABASE_KEY.includes("YOUR-");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiHeaders() {
  const h = { "Content-Type": "application/json", apikey: CFG.SUPABASE_KEY };
  // 예전 방식 anon 키(JWT, eyJ로 시작)는 Authorization 헤더도 함께 보냄
  if (CFG.SUPABASE_KEY && CFG.SUPABASE_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + CFG.SUPABASE_KEY;
  return h;
}

// Supabase 함수 호출. 네트워크 오류/서버 과부하(5xx, 429)는 자동 재시도
async function rpc(fn, args = {}, retries = 3) {
  const url = CFG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + fn;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: apiHeaders(), body: JSON.stringify(args) });
      const txt = await res.text();
      let data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
      if (res.ok) return data;
      const err = new Error((data && data.message) || txt || "HTTP " + res.status);
      err.status = res.status;
      if (res.status < 500 && res.status !== 429) throw err; // 재시도해도 소용없는 오류
      lastErr = err;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    if (i < retries) await sleep(700 * (i + 1) + Math.random() * 600);
  }
  throw lastErr;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key));
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch { return null; }
}

function deviceId() {
  let id = store("gs_device");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : "d" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    store("gs_device", id);
    if (store("gs_device") !== id) { // 저장 불가(시크릿 모드 등)
      window.__gsid = window.__gsid || id;
      id = window.__gsid;
    }
  }
  return id;
}

function toast(msg, ms = 2200) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

// 화면이 보일 때만 주기적으로 실행 (배터리·서버 부담 줄이기)
function poll(fn, baseMs) {
  let timer;
  const run = async () => {
    clearTimeout(timer);
    if (document.visibilityState === "visible") { try { await fn(); } catch (e) { console.warn(e); } }
    timer = setTimeout(run, baseMs + Math.random() * baseMs * 0.4);
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") run(); });
  run();
  return { now: run };
}

// 항목별 점수 입력 폼 (창의성 50 + 표현력 50)
const CRITERIA = [
  { key: "c", title: "① 창의성", desc: "OOTD·TPO 주제에 맞는 완성도, 컨셉의 독창성, 의상·소품 활용의 참신성, 기존 무대와의 차별성" },
  { key: "e", title: "② 표현력 및 무대 매너", desc: "런웨이 전달력, 관객 호응 유도, 시선을 사로잡는 포즈, 당당한 발걸음·표정·무대 매너" },
];

function buildScoreForm(el, onSubmit) {
  el.innerHTML = CRITERIA.map((c) => `
    <div class="crit" data-k="${c.key}">
      <div class="crit-head">
        <span class="crit-title">${c.title}</span>
        <span class="crit-val"><b>-</b><small> / 50</small></span>
      </div>
      <p class="crit-desc">${c.desc}</p>
      <div class="slider-row">
        <button type="button" class="step" data-d="-1" aria-label="1점 내리기">−</button>
        <input type="range" min="0" max="50" step="1" value="25" class="untouched" aria-label="${c.title} 점수">
        <button type="button" class="step" data-d="1" aria-label="1점 올리기">+</button>
      </div>
      <div class="ticks"><span>0</span><span>10</span><span>20</span><span>30</span><span>40</span><span>50</span></div>
    </div>`).join("") + `
    <div class="total">합계 <b class="tot">-</b> / 100</div>
    <button type="button" class="btn primary big submit" disabled>점수 보내기</button>
    <p class="hint">두 항목 모두 막대를 움직여 점수를 정해 주세요</p>`;

  const vals = {};
  const submit = el.querySelector(".submit");
  const hint = el.querySelector(".hint");
  const tot = el.querySelector(".tot");
  const refresh = () => {
    const done = CRITERIA.every((c) => vals[c.key] !== undefined);
    tot.textContent = done ? vals.c + vals.e : "-";
    submit.disabled = !done;
    hint.style.visibility = done ? "hidden" : "visible";
  };
  el.querySelectorAll(".crit").forEach((box) => {
    const k = box.dataset.k;
    const range = box.querySelector("input");
    const out = box.querySelector(".crit-val b");
    const set = (v) => {
      v = Math.max(0, Math.min(50, v));
      range.value = v; vals[k] = v; out.textContent = v;
      range.classList.remove("untouched");
      range.style.setProperty("--p", (v / 50) * 100 + "%");
      refresh();
    };
    ["input", "change", "pointerup", "touchend"].forEach((ev) => range.addEventListener(ev, () => set(+range.value)));
    box.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => set((vals[k] ?? 25) + +b.dataset.d)));
  });
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    submit.textContent = "보내는 중…";
    try { await onSubmit(vals.c, vals.e); }
    finally { if (document.body.contains(submit)) { submit.textContent = "점수 보내기"; refresh(); } }
  });
}

function showConfigError() {
  document.body.innerHTML = `<main class="wrap"><div class="card"><h2>설정 필요</h2>
  <p>config.js 파일에 Supabase 주소와 키를 넣어 주세요.</p></div></main>`;
}
