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

async function commitOperations(operations) {
  for (let start = 0; start < operations.length; start += 400) {
    const batch = writeBatch(db);
    const chunk = operations.slice(start, start + 400);

    chunk.forEach((operation) => {
      if (operation.type === "set") {
        batch.set(operation.ref, operation.data, { merge: true });
      } else {
        batch.delete(operation.ref);
      }
    });

    await batch.commit();
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
    await commitOperations(operations);
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

async function writeProfile(user) {
  await setDoc(
    doc(db, "users", user.uid),
    {
      displayName: user.displayName || "",
      email: user.email || "",
      lastLoginAt: serverTimestamp(),
      appVersion: "firebase-sync-v1"
    },
    { merge: true }
  );
}

async function syncAll(showMessage = true) {
  if (!currentUser || !db || syncing) return;

  syncing = true;
  setSyncState("正在合併本機與雲端紀錄…", "working");

  try {
    await Promise.all([
      loadAndMergeProgress(currentUser),
      loadAndMergeSession(currentUser),
      writeProfile(currentUser)
    ]);

    const time = new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit"
    });

    setSyncState(`已同步・${time}`, "ok");
    setText("[data-last-sync]", `最後同步：${time}`);
    if (showMessage) bridge?.toast?.("雲端學習紀錄同步完成");
  } catch (error) {
    console.error(error);
    const message = navigator.onLine
      ? `同步失敗：${error?.message || "請稍後再試"}`
      : "目前離線，紀錄已保存在本機，恢復網路後再同步。";
    setSyncState(message, "error");
    showAuthMessage(message, true);
  } finally {
    syncing = false;
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
    await commitOperations(operations);
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

window.firebaseQuizSync = {
  queueProgressSync,
  queueSessionSync,
  syncNow: () => syncAll(true),
  isSignedIn: () => Boolean(currentUser)
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
    button.addEventListener("click", () => syncAll(true));
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
        await syncAll(false);
        closeAuthModal();
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
