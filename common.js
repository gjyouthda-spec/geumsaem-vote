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

// 상태 조회: { teams: [...], survey: true/false }  (예전 형식도 처리)
async function getState() {
  const st = await rpc("get_state", {}, 1);
  if (Array.isArray(st)) return { teams: st, survey: false, rsurvey: false };
  const survey = !!(st && st.survey);
  return { teams: (st && st.teams) || [], survey, rsurvey: st && st.rsurvey !== undefined ? !!st.rsurvey : survey };
}

// ---------- 사후 만족도 설문 ----------
const SURVEY = {
  team: {
    title: "참가팀 사후 만족도 조사",
    qs: [
      "이번 행사는 전반적으로 만족스러웠나요?",
      "행사 진행 시간(리허설 포함)은 적절했나요?",
      "행사 장소와 무대·대기 공간은 적합했나요?",
      "지도자와 스태프의 안내 및 운영은 전문적이었나요?",
    ],
    comment: "행사 소감이나 개선점을 자유롭게 적어주세요.",
  },
  resident: {
    title: "관객 사후 만족도 조사",
    qs: [
      "오늘 행사는 전반적으로 만족스러웠나요?",
      "프로그램 구성과 진행 시간은 적절했나요?",
      "행사 장소와 관람 환경(안전·QR투표 등)은 쾌적했나요?",
      "스태프와 운영진의 안내는 친절하고 원활했나요?",
    ],
    comment: "인상 깊었던 무대나 소감을 자유롭게 적어주세요.",
  },
};
const SCALE = [
  { v: 5, face: "😍", label: "매우 그렇다" },
  { v: 4, face: "🙂", label: "그렇다" },
  { v: 3, face: "😐", label: "보통" },
  { v: 2, face: "🙁", label: "그렇지 않다" },
  { v: 1, face: "😞", label: "전혀 그렇지 않다" },
];

// draft: { ans: [..4], comment } — 화면이 다시 그려져도 작성 중인 응답 유지
function buildSurveyForm(el, kind, onSubmit, draft) {
  const S = SURVEY[kind];
  el.innerHTML = S.qs.map((q, i) => `
    <div class="sq" data-i="${i}">
      <div class="sq-title"><span class="sq-no">${i + 1}</span>${q}</div>
      <div class="scale" role="radiogroup" aria-label="${q}">
        ${SCALE.map((s) => `<button type="button" class="sc" data-v="${s.v}" role="radio" aria-checked="false">
          <span class="face">${s.face}</span><span class="lb">${s.label}</span></button>`).join("")}
      </div>
    </div>`).join("") + `
    <div class="sq">
      <div class="sq-title"><span class="sq-no">5</span>${S.comment} <span class="muted" style="font-weight:500">(선택)</span></div>
      <textarea class="text sc-comment" rows="3" maxlength="1000" placeholder="자유롭게 적어주세요"></textarea>
    </div>
    <button type="button" class="btn primary big submit" disabled>설문 제출하기</button>
    <p class="hint">1~4번 문항에 모두 답해 주세요 (<b class="cnt">0</b>/4)</p>`;
  const ans = draft && draft.ans ? draft.ans : [null, null, null, null];
  const cm = el.querySelector(".sc-comment");
  if (draft) { cm.value = draft.comment || ""; cm.addEventListener("input", () => { draft.comment = cm.value; }); }
  const submit = el.querySelector(".submit"), hint = el.querySelector(".hint"), cnt = el.querySelector(".cnt");
  const refresh = () => {
    const done = ans.filter((a) => a !== null).length;
    cnt.textContent = done; submit.disabled = done < 4;
    hint.style.visibility = done < 4 ? "visible" : "hidden";
  };
  el.querySelectorAll(".sq[data-i]").forEach((box) => {
    const i = +box.dataset.i;
    box.querySelectorAll(".sc").forEach((b) => b.addEventListener("click", () => {
      ans[i] = +b.dataset.v;
      box.querySelectorAll(".sc").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
      box.classList.add("answered"); refresh();
    }));
    if (ans[i] !== null) box.querySelector(`.sc[data-v="${ans[i]}"]`)?.click();
  });
  refresh();
  submit.addEventListener("click", async () => {
    submit.disabled = true; submit.textContent = "보내는 중…";
    try { await onSubmit(ans, el.querySelector(".sc-comment").value); }
    finally { if (document.body.contains(submit)) { submit.textContent = "설문 제출하기"; refresh(); } }
  });
}

function surveyResultMsg(r) {
  return { ok: "설문 제출 완료! 감사합니다 💖", already: "이미 설문에 참여했어요", closed: "설문이 종료되었어요",
           no_team: "팀을 다시 선택해 주세요", code: "참가자 코드가 맞지 않아요" }[r] || "다시 시도해 주세요";
}
