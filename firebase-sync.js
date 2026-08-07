import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  browserLocalPersistence,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const config = window.FIREBASE_CONFIG || {};
const bridge = window.quizSyncBridge;
const PLACEHOLDER_RE = /請貼上|YOUR_|example/i;

let app = null;
let auth = null;
let db = null;
let currentUser = null;
let syncing = false;
let progressShadow = {};
let sessionShadow = null;
let progressTimer = null;
let sessionTimer = null;

const GEMINI_NOTE_STORAGE_KEY = "procurement_quiz_gemini_notes_v1";
const OPTION_ANALYSIS_EDIT_STORAGE_KEY = "procurement_quiz_option_analysis_edits_v1";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function configured() {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every(
    (key) => typeof config[key] === "string" &&
      config[key].trim() &&
      !PLACEHOLDER_RE.test(config[key])
  );
}

function all(selector) {
  return [...document.querySelectorAll(selector)];
}

function setText(selector, text) {
  all(selector).forEach((element) => {
    element.textContent = text;
  });
}

function setHidden(selector, hidden) {
  all(selector).forEach((element) => {
    element.classList.toggle("hidden", hidden);
  });
}

function setSyncState(message, kind = "idle") {
  setText("[data-sync-status]", message);
  all("[data-sync-state]").forEach((element) => {
    element.dataset.syncState = kind;
  });
}

function setSyncButtonsBusy(busy, label = "立即同步") {
  all("[data-sync-now]").forEach((button) => {
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
    const labelNode = button.querySelector("[data-sync-button-label]");
    if (labelNode) {
      labelNode.textContent = busy ? "同步中…" : label;
    } else {
      button.textContent = busy ? "同步中…" : label;
    }
  });
}

function friendlyFirebaseError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  if (code.includes("permission-denied") || message.includes("Missing or insufficient permissions")) {
    return "Firestore 權限不足。請確認已建立 Firestore Database，並已發布 ZIP 內的 firestore.rules。";
  }
  if (code.includes("unavailable") || message.includes("offline")) {
    return "目前無法連線 Firestore，請檢查網路後再試。";
  }
  if (code.includes("unauthenticated")) {
    return "登入狀態已失效，請登出後重新登入。";
  }
  if (code.includes("failed-precondition")) {
    return "Firestore 尚未完成設定，請確認資料庫已建立。";
  }
  if (code.includes("quota-exceeded") || code.includes("resource-exhausted")) {
    return "Firebase 使用量已達限制，請稍後再試或檢查專案配額。";
  }
  if (message.includes("deadline") || message.includes("逾時")) {
    return "同步逾時。首次上傳大量舊紀錄時可能需要1至3分鐘；請保持畫面開啟並重新按立即同步。若「測試 Firebase 連線」也失敗，請再檢查 Firestore 與網路設定。";
  }
  return message || "同步時發生未知錯誤。";
}

function withTimeout(promise, milliseconds, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}逾時`);
      error.code = "sync/deadline-exceeded";
      reject(error);
    }, milliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatUser(user) {
  return user?.displayName || user?.email || "已登入使用者";
}

function updateAuthUi(user) {
  currentUser = user || null;

  if (user) {
    setText("[data-auth-button-label]", "已登入");
    setText("[data-auth-user-name]", formatUser(user));
    setText("[data-auth-user-email]", user.email || "Google 帳號");
    setHidden("[data-auth-guest]", true);
    setHidden("[data-auth-user]", false);
    setSyncState("準備同步雲端學習紀錄…", "working");
  } else {
    setText("[data-auth-button-label]", "登入同步");
    setText("[data-auth-user-name]", "尚未登入");
    setText("[data-auth-user-email]", "");
    setHidden("[data-auth-guest]", false);
    setHidden("[data-auth-user]", true);
    setSyncState(
      configured()
        ? "訪客模式：紀錄只保存在目前裝置。"
        : "尚未填入 Firebase 設定，請先完成部署步驟。",
      configured() ? "local" : "error"
    );
  }
}

function openAuthModal() {
  document.getElementById("authModal")?.classList.remove("hidden");
}

function closeAuthModal() {
  document.getElementById("authModal")?.classList.add("hidden");
}

function authFormValues() {
  return {
    email: document.getElementById("authEmail")?.value.trim() || "",
    password: document.getElementById("authPassword")?.value || ""
  };
}

function showAuthMessage(message, error = false) {
  const box = document.getElementById("authMessage");
  if (!box) return;
  box.textContent = message;
  box.classList.toggle("error", error);
}

function normalizeProgressRecord(record, fallbackTime = 0) {
  const item = record && typeof record === "object" ? record : {};
  return {
    attempts: Number(item.attempts || 0),
    correct: Number(item.correct || 0),
    wrong: Number(item.wrong || 0),
    skipped: Number(item.skipped || 0),
    lastAnswer: item.lastAnswer ?? null,
    lastCorrect: typeof item.lastCorrect === "boolean" ? item.lastCorrect : null,
    lastAction: item.lastAction || null,
    favorite: Boolean(item.favorite),
    updatedAtMs: Number(item.updatedAtMs || fallbackTime || 0)
  };
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function commitOperations(operations, progressLabel = "正在同步") {
  if (!operations.length) return;

  const batchSize = 180;
  const totalBatches = Math.ceil(operations.length / batchSize);

  for (let start = 0, batchIndex = 0;
       start < operations.length;
       start += batchSize, batchIndex++) {
    const batch = writeBatch(db);
    const chunk = operations.slice(start, start + batchSize);

    chunk.forEach((operation) => {
      if (operation.type === "set") {
        let data=operation.data;

        if(
          operation.ref?.path?.includes("/optionAnalysisEdits/") &&
          data &&
          typeof data==="object"
        ){
          const id=operation.ref.path.split("/").pop()||"";
          const safe=safeOptionAnalysisFirestoreData(data,id);
          data={
            ...safe,
            ...(data.updatedAt?{updatedAt:data.updatedAt}:{})
          };
        }

        batch.set(operation.ref, data, { merge: true });
      } else {
        batch.delete(operation.ref);
      }
    });

    const doneBefore = Math.min(start, operations.length);
    setSyncState(
      `${progressLabel}：${doneBefore}/${operations.length} 筆（第 ${batchIndex + 1}/${totalBatches} 批）`,
      "working"
    );

    await withTimeout(
      batch.commit(),
      45000,
      `第 ${batchIndex + 1} 批 Firestore 寫入`
    );

    const doneAfter = Math.min(start + chunk.length, operations.length);
    setSyncState(
      `${progressLabel}：${doneAfter}/${operations.length} 筆`,
      "working"
    );

    // 讓 iPhone／iPad UI 有機會更新，不要看起來像卡住。
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

async function loadAndMergeProgress(user) {
  const localRaw = bridge?.getProgress?.() || {};
  const remoteSnapshot = await getDocs(
    collection(db, "users", user.uid, "progress")
  );

  const remoteRaw = {};
  remoteSnapshot.forEach((snapshot) => {
    remoteRaw[snapshot.id] = snapshot.data();
  });

  const merged = {};
  const operations = [];
  const now = Date.now();
  const ids = new Set([...Object.keys(localRaw), ...Object.keys(remoteRaw)]);

  ids.forEach((questionId) => {
    const hasLocal = Object.prototype.hasOwnProperty.call(localRaw, questionId);
    const hasRemote = Object.prototype.hasOwnProperty.call(remoteRaw, questionId);
    const local = hasLocal ? normalizeProgressRecord(localRaw[questionId]) : null;
    const remote = hasRemote ? normalizeProgressRecord(remoteRaw[questionId]) : null;

    let chosen = null;
    let source = "";

    if (local && remote) {
      if (!local.updatedAtMs && remote.updatedAtMs) {
        chosen = remote;
        source = "remote";
      } else if (local.updatedAtMs >= remote.updatedAtMs) {
        chosen = {
          ...local,
          updatedAtMs: local.updatedAtMs || now
        };
        source = "local";
      } else {
        chosen = remote;
        source = "remote";
      }
    } else if (local) {
      chosen = {
        ...local,
        updatedAtMs: local.updatedAtMs || now
      };
      source = "local";
    } else if (remote) {
      chosen = remote;
      source = "remote";
    }

    if (!chosen) return;
    merged[questionId] = chosen;

    if (
      source === "local" &&
      (!remote || !sameValue(chosen, remote))
    ) {
      operations.push({
        type: "set",
        ref: doc(db, "users", user.uid, "progress", questionId),
        data: chosen
      });
    }
  });

  if (operations.length) {
    setSyncState(
      `偵測到 ${operations.length} 筆本機紀錄需要上傳，初次同步可能需要較久。`,
      "working"
    );
    await commitOperations(operations, "正在上傳學習紀錄");
  }

  bridge?.replaceProgress?.(merged);
  progressShadow = clone(merged);
}

async function loadAndMergeSession(user) {
  const local = bridge?.getSession?.() || null;
  const remoteReference = doc(db, "users", user.uid, "state", "session");
  const remoteSnapshot = await getDoc(remoteReference);
  const remote = remoteSnapshot.exists() ? remoteSnapshot.data() : null;

  const localTime = Number(local?.updatedAtMs || 0);
  const remoteTime = Number(remote?.updatedAtMs || 0);
  let chosen = null;

  if (local && remote) {
    chosen = localTime >= remoteTime ? local : remote;
  } else {
    chosen = local || remote;
  }

  if (chosen && !chosen.updatedAtMs) {
    chosen = { ...chosen, updatedAtMs: Date.now() };
  }

  if (chosen) {
    bridge?.replaceSession?.(chosen);
    if (!remote || !sameValue(chosen, remote)) {
      await setDoc(remoteReference, chosen, { merge: true });
    }
  }

  sessionShadow = clone(chosen);
}

function readLocalOptionAnalysisEdits(){
  try{
    const raw=localStorage.getItem(OPTION_ANALYSIS_EDIT_STORAGE_KEY);
    const parsed=raw?JSON.parse(raw):{};
    if(!parsed||typeof parsed!=="object")return{};

    const cleaned={};
    let changed=false;

    Object.entries(parsed).forEach(([questionId,record])=>{
      const normalized=normalizeOptionAnalysisRecord(record,questionId);
      cleaned[String(questionId)]=normalized;

      const before=JSON.stringify(record||{});
      const after=JSON.stringify(normalized);
      if(before!==after)changed=true;
    });

    if(changed){
      localStorage.setItem(
        OPTION_ANALYSIS_EDIT_STORAGE_KEY,
        JSON.stringify(cleaned)
      );
      console.info("已自動遷移舊版逐項分析欄位名稱。");
    }

    return cleaned;
  }catch(e){
    console.warn(e);
    return{};
  }
}
function writeLocalOptionAnalysisEdits(v){localStorage.setItem(OPTION_ANALYSIS_EDIT_STORAGE_KEY,JSON.stringify(v&&typeof v==="object"?v:{}))}
function normalizeOptionAnalysisItem(v){v=v&&typeof v==="object"?v:{};return{text:String(v.text||""),deleted:Boolean(v.deleted),createdAtMs:Number(v.createdAtMs||v.updatedAtMs||0),updatedAtMs:Number(v.updatedAtMs||0)}}
function normalizeOptionAnalysisRecord(v,id=""){
  v=v&&typeof v==="object"?v:{};
  const items={};
  const raw=v.items&&typeof v.items==="object"?v.items:{};

  Object.entries(raw).forEach(([k,x])=>{
    let safeKey=String(k);

    // Firestore 不允許欄位名稱以 "__" 開頭及結尾。
    // v17 曾使用 "__summary__" 儲存本題總結，這裡自動遷移成安全欄位 summaryText。
    if(safeKey==="__summary__"){
      safeKey="summaryText";
    }else if(/^__.*__$/.test(safeKey)){
      safeKey=`custom_${safeKey.replace(/^__|__$/g,"")||"field"}`;
    }

    const incoming=normalizeOptionAnalysisItem(x);
    const existing=items[safeKey];

    // 若舊、新 key 同時存在，保留更新時間較新的內容。
    if(!existing||incoming.updatedAtMs>=existing.updatedAtMs){
      items[safeKey]=incoming;
    }
  });

  return{
    questionId:String(v.questionId||id),
    items,
    updatedAtMs:Number(v.updatedAtMs||0)
  }
}
function mergeOptionAnalysisRecords(a,b,id){a=normalizeOptionAnalysisRecord(a,id);b=normalizeOptionAnalysisRecord(b,id);const items={};new Set([...Object.keys(a.items),...Object.keys(b.items)]).forEach(k=>{const x=a.items[k],y=b.items[k];items[k]=x&&y?(x.updatedAtMs>=y.updatedAtMs?x:y):(x||y)});return{questionId:String(id),items,updatedAtMs:Math.max(Number(a.updatedAtMs||0),Number(b.updatedAtMs||0),...Object.values(items).map(x=>Number(x.updatedAtMs||0)))}}
function safeOptionAnalysisFirestoreData(record,id=""){
  const normalized=normalizeOptionAnalysisRecord(record,id);
  const safeItems={};

  Object.entries(normalized.items||{}).forEach(([rawKey,item])=>{
    let key=String(rawKey);

    if(key==="__summary__"){
      key="summaryText";
    }else if(/^__.*__$/.test(key)){
      key=`custom_${key.replace(/^__+|__+$/g,"")||"field"}`;
    }

    // 最後一道保護，禁止任何雙底線保留欄位進入 Firestore。
    if(/^__.*__$/.test(key)){
      key=`custom_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    safeItems[key]=normalizeOptionAnalysisItem(item);
  });

  return{
    questionId:String(normalized.questionId||id),
    items:safeItems,
    updatedAtMs:Number(normalized.updatedAtMs||0)
  };
}

async function syncOptionAnalysisEdits(user){
  if(!user||!db)return;

  const local=readLocalOptionAnalysisEdits();
  const snap=await getDocs(
    collection(db,"users",user.uid,"optionAnalysisEdits")
  );

  const remote={};
  snap.forEach(s=>{
    remote[s.id]=normalizeOptionAnalysisRecord(s.data(),s.id)
  });

  const mergedAll={};
  const ops=[];

  new Set([...Object.keys(local),...Object.keys(remote)]).forEach(id=>{
    const merged=mergeOptionAnalysisRecords(local[id],remote[id],id);
    const safeMerged=safeOptionAnalysisFirestoreData(merged,id);
    mergedAll[id]=safeMerged;

    const r=remote[id]
      ?safeOptionAnalysisFirestoreData(remote[id],id)
      :null;

    if(!r||!sameValue(safeMerged,r)){
      ops.push({
        type:"set",
        ref:doc(db,"users",user.uid,"optionAnalysisEdits",id),
        data:{
          ...safeMerged,
          updatedAt:serverTimestamp()
        }
      })
    }
  });

  // 先把清洗後資料回寫本機，從根源移除舊 __summary__。
  writeLocalOptionAnalysisEdits(mergedAll);

  if(ops.length){
    await commitOperations(ops,"正在同步逐項分析修改")
  }
}
async function getOptionAnalysisEdits(questionId){
  const id=String(questionId||"").trim();if(!id)return{};const all=readLocalOptionAnalysisEdits();const local=all[id]?normalizeOptionAnalysisRecord(all[id],id):null;const user=currentUser||auth?.currentUser||null;if(!user||!db||!navigator.onLine)return clone(local?.items||{});try{const ref=doc(db,"users",user.uid,"optionAnalysisEdits",id);const s=await getDoc(ref);const remote=s.exists()?normalizeOptionAnalysisRecord(s.data(),id):null;const merged=mergeOptionAnalysisRecords(local,remote,id);all[id]=merged;writeLocalOptionAnalysisEdits(all);if(!remote||!sameValue(merged,remote))await setDoc(
      ref,
      {
        ...safeOptionAnalysisFirestoreData(merged,id),
        updatedAt:serverTimestamp()
      },
      {merge:true}
    );return clone(merged.items||{})}catch(e){console.warn(e);return clone(local?.items||{})}
}
async function saveOptionAnalysisEdit(questionId,optionKey,text){
  const id=String(questionId||"").trim();
  let key=String(optionKey||"").trim();
  if(key==="__summary__")key="summaryText";
  if(/^__.*__$/.test(key))key=`custom_${key.replace(/^__|__$/g,"")||"field"}`;
  const content=String(text||"").trim();if(!id||!key)throw new Error("找不到目前題目或選項。");if(!content)throw new Error("逐項分析內容不可空白。");if(content.length>30000)throw new Error("單一選項分析內容過長。");const all=readLocalOptionAnalysisEdits(),rec=normalizeOptionAnalysisRecord(all[id],id),old=rec.items[key]?normalizeOptionAnalysisItem(rec.items[key]):null,now=Date.now();rec.items[key]={text:content,deleted:false,createdAtMs:old&&!old.deleted?Number(old.createdAtMs||old.updatedAtMs||now):now,updatedAtMs:now};rec.updatedAtMs=now;all[id]=rec;writeLocalOptionAnalysisEdits(all);const user=currentUser||auth?.currentUser||null;if(user&&db&&navigator.onLine){await setDoc(
      doc(db,"users",user.uid,"optionAnalysisEdits",id),
      {
        ...safeOptionAnalysisFirestoreData(rec,id),
        updatedAt:serverTimestamp()
      },
      {merge:true}
    );return{item:clone(rec.items[key]),location:"cloud"}}return{item:clone(rec.items[key]),location:"local"}
}
async function resetOptionAnalysisEdit(questionId,optionKey){
  const id=String(questionId||"").trim();
  let key=String(optionKey||"").trim();
  if(key==="__summary__")key="summaryText";
  if(/^__.*__$/.test(key))key=`custom_${key.replace(/^__|__$/g,"")||"field"}`;if(!id||!key)throw new Error("找不到目前題目或選項。");const all=readLocalOptionAnalysisEdits(),rec=normalizeOptionAnalysisRecord(all[id],id),old=rec.items[key]?normalizeOptionAnalysisItem(rec.items[key]):null,now=Date.now();rec.items[key]={text:"",deleted:true,createdAtMs:Number(old?.createdAtMs||old?.updatedAtMs||now),updatedAtMs:now};rec.updatedAtMs=now;all[id]=rec;writeLocalOptionAnalysisEdits(all);const user=currentUser||auth?.currentUser||null;if(user&&db&&navigator.onLine){await setDoc(
      doc(db,"users",user.uid,"optionAnalysisEdits",id),
      {
        ...safeOptionAnalysisFirestoreData(rec,id),
        updatedAt:serverTimestamp()
      },
      {merge:true}
    );return{location:"cloud"}}return{location:"local"}
}

function readLocalGeminiNotes() {
  try {
    const raw = localStorage.getItem(GEMINI_NOTE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("Unable to read local Gemini notes:", error);
    return {};
  }
}

function writeLocalGeminiNotes(notes) {
  localStorage.setItem(
    GEMINI_NOTE_STORAGE_KEY,
    JSON.stringify(notes && typeof notes === "object" ? notes : {})
  );
}

function normalizeGeminiNote(note, questionId = "") {
  const item = note && typeof note === "object" ? note : {};
  const updatedAtMs = Number(item.updatedAtMs || 0);
  return {
    questionId: String(item.questionId || questionId),
    text: String(item.text || ""),
    deleted: Boolean(item.deleted),
    createdAtMs: Number(item.createdAtMs || updatedAtMs || 0),
    updatedAtMs
  };
}

async function syncGeminiNotes(user) {
  if (!user || !db) return;

  const localRaw = readLocalGeminiNotes();
  const remoteSnapshot = await getDocs(
    collection(db, "users", user.uid, "geminiNotes")
  );

  const remoteRaw = {};
  remoteSnapshot.forEach((snapshot) => {
    remoteRaw[snapshot.id] = normalizeGeminiNote(
      snapshot.data(),
      snapshot.id
    );
  });

  const merged = {};
  const operations = [];
  const ids = new Set([
    ...Object.keys(localRaw),
    ...Object.keys(remoteRaw)
  ]);

  ids.forEach((questionId) => {
    const local = Object.prototype.hasOwnProperty.call(localRaw, questionId)
      ? normalizeGeminiNote(localRaw[questionId], questionId)
      : null;
    const remote = Object.prototype.hasOwnProperty.call(remoteRaw, questionId)
      ? normalizeGeminiNote(remoteRaw[questionId], questionId)
      : null;

    let selected = null;
    let selectedFromLocal = false;

    if (local && remote) {
      if (local.updatedAtMs >= remote.updatedAtMs) {
        selected = local;
        selectedFromLocal = true;
      } else {
        selected = remote;
      }
    } else if (local) {
      selected = local;
      selectedFromLocal = true;
    } else if (remote) {
      selected = remote;
    }

    if (!selected) return;

    if (!selected.updatedAtMs) {
      selected = {
        ...selected,
        updatedAtMs: Date.now()
      };
      selectedFromLocal = true;
    }

    merged[questionId] = selected;

    if (
      selectedFromLocal &&
      (!remote || !sameValue(selected, remote))
    ) {
      operations.push({
        type: "set",
        ref: doc(
          db,
          "users",
          user.uid,
          "geminiNotes",
          questionId
        ),
        data: {
          ...selected,
          updatedAt: serverTimestamp()
        }
      });
    }
  });

  writeLocalGeminiNotes(merged);

  if (operations.length) {
    await commitOperations(operations, "正在同步 Gemini 個人筆記");
  }
}

async function getGeminiNote(questionId) {
  const id = String(questionId || "").trim();
  if (!id) return null;

  const localNotes = readLocalGeminiNotes();
  let local = Object.prototype.hasOwnProperty.call(localNotes, id)
    ? normalizeGeminiNote(localNotes[id], id)
    : null;

  const user = currentUser || auth?.currentUser || null;

  if (!user || !db || !navigator.onLine) {
    return local && !local.deleted ? clone(local) : null;
  }

  try {
    const reference = doc(
      db,
      "users",
      user.uid,
      "geminiNotes",
      id
    );
    const snapshot = await getDoc(reference);
    const remote = snapshot.exists()
      ? normalizeGeminiNote(snapshot.data(), id)
      : null;

    let selected = local;
    let uploadLocal = false;

    if (local && remote) {
      if (local.updatedAtMs >= remote.updatedAtMs) {
        selected = local;
        uploadLocal = !sameValue(local, remote);
      } else {
        selected = remote;
      }
    } else if (local) {
      selected = local;
      uploadLocal = true;
    } else if (remote) {
      selected = remote;
    }

    if (selected) {
      localNotes[id] = selected;
      writeLocalGeminiNotes(localNotes);
    }

    if (uploadLocal && selected) {
      await setDoc(
        reference,
        {
          ...selected,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    return selected && !selected.deleted ? clone(selected) : null;
  } catch (error) {
    console.warn("Unable to load Gemini note from Firestore:", error);
    return local && !local.deleted ? clone(local) : null;
  }
}

async function saveGeminiNote(questionId, text) {
  const id = String(questionId || "").trim();
  const content = String(text || "").trim();

  if (!id) {
    throw new Error("找不到目前題目編號。");
  }
  if (!content) {
    throw new Error("請先貼上 Gemini 分析內容。");
  }
  if (content.length > 100000) {
    throw new Error("筆記內容過長，請縮短至 100,000 字以內。");
  }

  const localNotes = readLocalGeminiNotes();
  const existing = Object.prototype.hasOwnProperty.call(localNotes, id)
    ? normalizeGeminiNote(localNotes[id], id)
    : null;
  const now = Date.now();

  const note = {
    questionId: id,
    text: content,
    deleted: false,
    createdAtMs:
      existing && !existing.deleted
        ? Number(existing.createdAtMs || existing.updatedAtMs || now)
        : now,
    updatedAtMs: now
  };

  localNotes[id] = note;
  writeLocalGeminiNotes(localNotes);

  const user = currentUser || auth?.currentUser || null;

  if (user && db && navigator.onLine) {
    await setDoc(
      doc(db, "users", user.uid, "geminiNotes", id),
      {
        ...note,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    return {
      ...clone(note),
      location: "cloud"
    };
  }

  return {
    ...clone(note),
    location: "local"
  };
}

async function deleteGeminiNote(questionId) {
  const id = String(questionId || "").trim();

  if (!id) {
    throw new Error("找不到目前題目編號。");
  }

  /*
    使用刪除標記而非直接移除文件，避免不同裝置離線時，
    舊筆記在下次同步時又被還原。
  */
  const localNotes = readLocalGeminiNotes();
  const existing = Object.prototype.hasOwnProperty.call(localNotes, id)
    ? normalizeGeminiNote(localNotes[id], id)
    : null;
  const now = Date.now();

  const tombstone = {
    questionId: id,
    text: "",
    deleted: true,
    createdAtMs: Number(existing?.createdAtMs || existing?.updatedAtMs || now),
    updatedAtMs: now
  };
  localNotes[id] = tombstone;
  writeLocalGeminiNotes(localNotes);

  const user = currentUser || auth?.currentUser || null;

  if (user && db && navigator.onLine) {
    await setDoc(
      doc(db, "users", user.uid, "geminiNotes", id),
      {
        ...tombstone,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

    return { location: "cloud" };
  }

  return { location: "local" };
}

async function writeProfile(user) {
  await setDoc(
    doc(db, "users", user.uid),
    {
      displayName: user.displayName || "",
      email: user.email || "",
      lastLoginAt: serverTimestamp(),
      appVersion: "firebase-unified-analysis-editor-v19"
    },
    { merge: true }
  );
}

async function syncAll(showMessage = true) {
  const user = currentUser || auth?.currentUser || null;

  if (!user) {
    const message = "尚未登入，請先登入後再同步。";
    setSyncState(message, "error");
    showAuthMessage(message, true);
    bridge?.toast?.(message);
    openAuthModal();
    return false;
  }

  if (!db) {
    const message = "Firestore 尚未初始化，請重新整理網頁後再試。";
    setSyncState(message, "error");
    showAuthMessage(message, true);
    bridge?.toast?.(message);
    return false;
  }

  if (syncing) {
    const message = "同步正在進行中，請稍候。";
    setSyncState(message, "working");
    showAuthMessage(message);
    bridge?.toast?.(message);
    return false;
  }

  syncing = true;
  setSyncButtonsBusy(true);
  setSyncState("正在讀取雲端學習紀錄…", "working");
  showAuthMessage("正在讀取雲端學習紀錄…");

  try {
    await withTimeout(loadAndMergeProgress(user), 180000, "題目紀錄同步");
    setSyncState("正在同步目前練習位置…", "working");
    showAuthMessage("題目紀錄完成，正在同步練習位置…");

    await withTimeout(loadAndMergeSession(user), 45000, "練習位置同步");

    setSyncState("正在同步 Gemini 個人筆記…", "working");
    showAuthMessage("正在同步 Gemini 個人筆記…");
    await withTimeout(syncGeminiNotes(user), 90000, "Gemini 個人筆記同步");

    setSyncState("正在同步逐項分析修改…", "working");
    showAuthMessage("正在同步逐項分析修改…");
    await withTimeout(syncOptionAnalysisEdits(user), 90000, "逐項分析修改同步");

    setSyncState("正在更新帳號同步資訊…", "working");

    try {
      await withTimeout(writeProfile(user), 12000, "帳號資訊更新");
    } catch (profileError) {
      console.warn("Profile update skipped:", profileError);
    }

    const time = new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit"
    });

    setSyncState(`已同步・${time}`, "ok");
    setText("[data-last-sync]", `最後同步：${time}`);
    showAuthMessage(`同步完成・${time}`);
    if (showMessage) bridge?.toast?.("雲端學習紀錄同步完成");
    return true;
  } catch (error) {
    console.error("Firebase sync failed:", error);
    const detail = navigator.onLine
      ? friendlyFirebaseError(error)
      : "目前離線，紀錄已保存在本機，恢復網路後再同步。";
    const message = `同步失敗：${detail}`;
    setSyncState(message, "error");
    showAuthMessage(message, true);
    bridge?.toast?.("同步失敗，請查看登入視窗中的說明");
    return false;
  } finally {
    syncing = false;
    setSyncButtonsBusy(false);
  }
}

async function flushProgress() {
  if (!currentUser || !db || syncing) return;

  const current = clone(bridge?.getProgress?.() || {});
  const ids = new Set([
    ...Object.keys(progressShadow || {}),
    ...Object.keys(current || {})
  ]);
  const operations = [];
  const now = Date.now();

  ids.forEach((questionId) => {
    const beforeExists = Object.prototype.hasOwnProperty.call(
      progressShadow || {},
      questionId
    );
    const afterExists = Object.prototype.hasOwnProperty.call(
      current || {},
      questionId
    );

    if (!afterExists && beforeExists) {
      operations.push({
        type: "delete",
        ref: doc(db, "users", currentUser.uid, "progress", questionId)
      });
      return;
    }

    if (!afterExists) return;

    const after = normalizeProgressRecord(current[questionId], now);
    current[questionId] = after;

    if (!beforeExists || !sameValue(after, progressShadow[questionId])) {
      operations.push({
        type: "set",
        ref: doc(db, "users", currentUser.uid, "progress", questionId),
        data: after
      });
    }
  });

  if (!operations.length) return;

  try {
    setSyncState("正在上傳最新作答紀錄…", "working");
    await commitOperations(operations, "正在自動上傳");
    progressShadow = clone(current);
    setSyncState("已自動同步", "ok");
  } catch (error) {
    console.error(error);
    setSyncState(
      navigator.onLine
        ? "自動同步失敗，稍後將再嘗試。"
        : "目前離線，紀錄已保存在本機。",
      "error"
    );
  }
}

async function flushSession() {
  if (!currentUser || !db || syncing) return;

  const current = clone(bridge?.getSession?.() || null);
  if (sameValue(current, sessionShadow)) return;

  try {
    const reference = doc(db, "users", currentUser.uid, "state", "session");

    if (current) {
      await setDoc(reference, current, { merge: true });
    } else {
      await deleteDoc(reference);
    }

    sessionShadow = clone(current);
  } catch (error) {
    console.error(error);
  }
}

function queueProgressSync() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 650);
}

function queueSessionSync() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 850);
}

async function testFirebaseConnection() {
  const user = currentUser || auth?.currentUser || null;

  if (!user) {
    const message = "請先登入，再測試 Firebase 連線。";
    showAuthMessage(message, true);
    setSyncState(message, "error");
    openAuthModal();
    return false;
  }

  if (!db) {
    const message = "Firestore 尚未初始化，請重新整理網頁。";
    showAuthMessage(message, true);
    setSyncState(message, "error");
    return false;
  }

  all("[data-test-firebase]").forEach((button) => {
    button.disabled = true;
    button.textContent = "測試中…";
  });

  setSyncState("正在測試 Firestore 寫入與讀取…", "working");
  showAuthMessage("正在測試 Firestore 寫入與讀取…");

  const reference = doc(db, "users", user.uid, "state", "diagnostic");

  try {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    await withTimeout(
      setDoc(reference, {
        token,
        checkedAtMs: Date.now()
      }, { merge: true }),
      15000,
      "Firestore 寫入測試"
    );

    const snapshot = await withTimeout(
      getDoc(reference),
      15000,
      "Firestore 讀取測試"
    );

    if (!snapshot.exists() || snapshot.data()?.token !== token) {
      throw new Error("Firestore 測試資料讀回不一致");
    }

    await deleteDoc(reference).catch(() => null);

    const message = "Firebase 連線正常：登入、Firestore 寫入與讀取均成功。";
    setSyncState(message, "ok");
    showAuthMessage(message);
    bridge?.toast?.("Firebase 連線測試成功");
    return true;
  } catch (error) {
    console.error("Firebase diagnostic failed:", error);
    const message = `Firebase 測試失敗：${friendlyFirebaseError(error)}`;
    setSyncState(message, "error");
    showAuthMessage(message, true);
    bridge?.toast?.("Firebase 連線測試失敗");
    return false;
  } finally {
    all("[data-test-firebase]").forEach((button) => {
      button.disabled = false;
      button.textContent = "測試 Firebase 連線";
    });
  }
}

window.firebaseQuizSync = {
  queueProgressSync,
  queueSessionSync,
  syncNow: () => syncAll(true),
  isSignedIn: () => Boolean(currentUser || auth?.currentUser),
  getGeminiNote,
  saveGeminiNote,
  deleteGeminiNote,
  getOptionAnalysisEdits,
  saveOptionAnalysisEdit,
  resetOptionAnalysisEdit
};

function bindUi() {
  all("[data-open-auth]").forEach((button) => {
    button.addEventListener("click", openAuthModal);
  });

  document.getElementById("closeAuthBtn")?.addEventListener(
    "click",
    closeAuthModal
  );

  document.getElementById("authModal")?.addEventListener("click", (event) => {
    if (event.target?.id === "authModal") closeAuthModal();
  });

  document.getElementById("googleLoginBtn")?.addEventListener(
    "click",
    async () => {
      if (!auth) return showAuthMessage("請先完成 Firebase 設定。", true);
      showAuthMessage("正在開啟 Google 登入…");

      try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithPopup(auth, provider);
      } catch (error) {
        if (
          error?.code === "auth/popup-blocked" ||
          error?.code === "auth/operation-not-supported-in-this-environment"
        ) {
          await signInWithRedirect(auth, new GoogleAuthProvider());
          return;
        }
        showAuthMessage(error?.message || "Google 登入失敗。", true);
      }
    }
  );

  document.getElementById("emailLoginBtn")?.addEventListener(
    "click",
    async () => {
      if (!auth) return showAuthMessage("請先完成 Firebase 設定。", true);
      const { email, password } = authFormValues();

      if (!email || !password) {
        return showAuthMessage("請輸入電子郵件與密碼。", true);
      }

      try {
        showAuthMessage("登入中…");
        await signInWithEmailAndPassword(auth, email, password);
      } catch (error) {
        showAuthMessage(error?.message || "登入失敗。", true);
      }
    }
  );

  document.getElementById("emailRegisterBtn")?.addEventListener(
    "click",
    async () => {
      if (!auth) return showAuthMessage("請先完成 Firebase 設定。", true);
      const { email, password } = authFormValues();

      if (!email || password.length < 6) {
        return showAuthMessage(
          "請輸入有效電子郵件，密碼至少需6個字元。",
          true
        );
      }

      try {
        showAuthMessage("正在建立帳號…");
        await createUserWithEmailAndPassword(auth, email, password);
      } catch (error) {
        showAuthMessage(error?.message || "建立帳號失敗。", true);
      }
    }
  );

  document.getElementById("passwordResetBtn")?.addEventListener(
    "click",
    async () => {
      if (!auth) return showAuthMessage("請先完成 Firebase 設定。", true);
      const { email } = authFormValues();

      if (!email) {
        return showAuthMessage("請先輸入電子郵件。", true);
      }

      try {
        await sendPasswordResetEmail(auth, email);
        showAuthMessage("密碼重設信已寄出，請檢查信箱。");
      } catch (error) {
        showAuthMessage(error?.message || "寄送失敗。", true);
      }
    }
  );

  all("[data-sync-now]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      showAuthMessage("已收到同步指令，準備同步…");
      setSyncState("已收到同步指令，準備同步…", "working");
      await syncAll(true);
    });
  });

  all("[data-test-firebase]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      await testFirebaseConnection();
    });
  });

  all("[data-logout]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (auth) await signOut(auth);
      closeAuthModal();
    });
  });
}

bindUi();
updateAuthUi(null);

if (!configured()) {
  showAuthMessage(
    "尚未設定 Firebase。請先編輯 firebase-config.js，再部署到 GitHub Pages。",
    true
  );
} else if (!location.protocol.startsWith("http")) {
  showAuthMessage(
    "Firebase 登入需要 HTTPS 網址。請將此版本部署到 GitHub Pages 後使用。",
    true
  );
  setSyncState("請先部署到 GitHub Pages，才能使用跨裝置同步。", "error");
} else {
  try {
    app = initializeApp(config);
    auth = getAuth(app);
    db = getFirestore(app);

    await setPersistence(auth, browserLocalPersistence);
    await getRedirectResult(auth).catch(() => null);

    onAuthStateChanged(auth, async (user) => {
      updateAuthUi(user);

      if (user) {
        showAuthMessage("登入成功，正在同步學習紀錄。");
        const success = await syncAll(false);
        if (success) {
          closeAuthModal();
        } else {
          openAuthModal();
        }
      } else {
        progressShadow = {};
        sessionShadow = null;
      }
    });

    window.addEventListener("online", () => {
      if (currentUser) syncAll(false);
    });

    document.addEventListener("visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        currentUser &&
        navigator.onLine
      ) {
        syncAll(false);
      }
    });
  } catch (error) {
    console.error(error);
    showAuthMessage(
      `Firebase 初始化失敗：${error?.message || "請檢查設定"}`,
      true
    );
    setSyncState("Firebase 初始化失敗，請檢查設定。", "error");
  }
}
