const { createApp, computed } = Vue;
const { useStorage, useDebouncedRefHistory } = VueUse;

const STORAGE_KEY = "time-tracker-data";
const HOUR_HEIGHT = 48; // 1時間あたりの高さ(px)
const SNAP_MIN = 15; // スナップ単位(分)
const DEFAULT_DUR = 30; // クリック作成時の既定長さ(分)

// --- ヘルパー ---
function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v) {
  return new Date(v).toISOString();
}

function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 当日0時からの経過分
function minutesOfDay(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// 保存データの正規化（壊れた/古い形式を整える）
function normalizeData(d) {
  if (!Array.isArray(d.projects)) d.projects = [];
  d.entries = (Array.isArray(d.entries) ? d.entries : [])
    .filter((e) => e && e.start)
    .map((e) => ({
      id: e.id || uuid(),
      description: e.description || "",
      projectId: e.projectId ?? null,
      tags: Array.isArray(e.tags) ? e.tags : [],
      start: e.start,
      end: e.end || new Date(new Date(e.start).getTime() + 30 * 60000).toISOString(),
    }));
}

createApp({
  // 永続化(localStorage)と履歴(undo/redo)を VueUse に委譲する。
  setup() {
    // localStorage と自動同期する反応的ストア
    const store = useStorage(
      STORAGE_KEY,
      { entries: [], projects: [] },
      localStorage,
      { mergeDefaults: true }
    );
    normalizeData(store.value);

    // 連続した変更を 400ms でまとめて1ステップにする undo/redo 履歴
    const {
      undo: histUndo,
      redo: histRedo,
      canUndo,
      canRedo,
      pause: histPause,
      resume: histResume,
    } = useDebouncedRefHistory(store, {
      deep: true,
      clone: true,
      debounce: 400,
      capacity: 100,
    });

    // 既存コードが this.entries / this.projects のまま使えるようにする
    const entries = computed({
      get: () => store.value.entries,
      set: (v) => { store.value.entries = v; },
    });
    const projects = computed({
      get: () => store.value.projects,
      set: (v) => { store.value.projects = v; },
    });

    return {
      entries,
      projects,
      canUndo,
      canRedo,
      _histUndo: histUndo,
      _histRedo: histRedo,
      _histPause: histPause,
      _histResume: histResume,
    };
  },

  data() {
    return {
      newProject: { name: "", color: "#4dabf7" },
      editingId: null,
      draftId: null, // 新規作成して未保存のエントリ(閉じたら破棄)
      editForm: { description: "", projectId: null, tagsText: "", start: "", end: "" },
      editorPos: { x: 0, y: 0 }, // ポップオーバーの表示位置
      activeTab: "calendar",
      reportRange: "today",
      viewDate: new Date(), // 表示中の週の基準日
      lastProjectId: null, // 直近に使ったプロジェクト
      drag: null, // ドラッグ中の状態
      preview: null, // 作成中のプレビュー
      hourHeight: HOUR_HEIGHT,
      _paused: false, // ドラフト編集中に履歴記録を止めているか
      tabs: [
        { key: "calendar", label: "カレンダー" },
        { key: "projects", label: "プロジェクト" },
        { key: "report", label: "レポート" },
        { key: "data", label: "データ" },
      ],
      ranges: [
        { key: "today", label: "今日" },
        { key: "week", label: "今週" },
        { key: "all", label: "全期間" },
      ],
    };
  },

  computed: {
    bodyHeight() {
      return 24 * this.hourHeight;
    },
    weekDays() {
      const base = this.viewDate;
      const offset = (base.getDay() + 6) % 7; // 月曜=0
      const monday = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
      return Array.from({ length: 7 }, (_, i) =>
        new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
      );
    },
    weekLabel() {
      const a = this.weekDays[0];
      const b = this.weekDays[6];
      const left = `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`;
      const right =
        a.getMonth() === b.getMonth()
          ? `${b.getDate()}日`
          : `${b.getMonth() + 1}月${b.getDate()}日`;
      return `${left} – ${right}`;
    },
    entriesByDay() {
      const keys = this.weekDays.map((d) => dateKey(d.toISOString()));
      const map = keys.map(() => []);
      for (const e of this.entries) {
        const idx = keys.indexOf(dateKey(e.start));
        if (idx >= 0) map[idx].push(e);
      }
      return map;
    },
    weekTotal() {
      let total = 0;
      for (const arr of this.entriesByDay) {
        for (const e of arr) total += this.durationOf(e);
      }
      return total;
    },
    previewStyle() {
      if (!this.preview) return {};
      const { startMin, endMin } = this.preview;
      return {
        top: (startMin / 60) * this.hourHeight + "px",
        height: Math.max(((endMin - startMin) / 60) * this.hourHeight, 2) + "px",
      };
    },
    previewLabel() {
      if (!this.preview) return "";
      return `${this.minToClock(this.preview.startMin)}–${this.minToClock(this.preview.endMin)}`;
    },
    popoverStyle() {
      const W = 320;
      const H = 380;
      const { x, y } = this.editorPos;
      let left = x + 12;
      if (left + W > window.innerWidth - 8) left = Math.max(8, x - W - 12);
      let top = Math.max(8, y);
      if (top + H > window.innerHeight - 8) top = Math.max(8, window.innerHeight - H - 8);
      return { left: left + "px", top: top + "px" };
    },
    // --- レポート ---
    reportEntries() {
      const { start, end } = this.rangeBounds(this.reportRange);
      return this.entries.filter((e) => {
        const s = new Date(e.start).getTime();
        return s >= start && s < end;
      });
    },
    reportTotal() {
      return this.reportEntries.reduce((sum, e) => sum + this.durationOf(e), 0);
    },
    reportRows() {
      const totals = {};
      for (const e of this.reportEntries) {
        const key = e.projectId || "__none__";
        totals[key] = (totals[key] || 0) + this.durationOf(e);
      }
      const grand = this.reportTotal || 1;
      return Object.entries(totals)
        .map(([key, total]) => {
          const p = key === "__none__" ? null : this.projects.find((x) => x.id === key);
          return {
            id: key,
            name: p ? p.name : "プロジェクトなし",
            color: p ? p.color : "#adb5bd",
            total,
            pct: Math.round((total / grand) * 100),
          };
        })
        .sort((a, b) => b.total - a.total);
    },
  },

  methods: {
    // --- 週ナビゲーション ---
    prevWeek() {
      const d = this.viewDate;
      this.viewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
    },
    nextWeek() {
      const d = this.viewDate;
      this.viewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
    },
    goToday() {
      this.viewDate = new Date();
    },
    isToday(d) {
      return dateKey(d.toISOString()) === dateKey(new Date().toISOString());
    },
    weekdayLabel(d) {
      return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
    },

    // --- 座標 ⇔ 時刻 ---
    yToMinutes(clientY) {
      const rect = this.$refs.cols.getBoundingClientRect();
      return ((clientY - rect.top) / this.hourHeight) * 60;
    },
    dayIndexFromX(clientX) {
      const rect = this.$refs.cols.getBoundingClientRect();
      const idx = Math.floor((clientX - rect.left) / (rect.width / 7));
      return Math.min(6, Math.max(0, idx));
    },
    snap(min) {
      return Math.round(min / SNAP_MIN) * SNAP_MIN;
    },
    clampMin(min) {
      return Math.max(0, Math.min(1440, min));
    },

    // --- ブロックの見た目 ---
    blockStyle(e) {
      const top = (minutesOfDay(e.start) / 60) * this.hourHeight;
      const height = (this.durationOf(e) / 3600000) * this.hourHeight;
      const p = this.projectOf(e);
      const color = (p && p.color) || "#4dabf7";
      return {
        top: top + "px",
        height: Math.max(height, 16) + "px",
        background: color + "22",
        borderLeftColor: color,
      };
    },

    // --- ドラッグ: 新規作成 ---
    onCreateDown(event, dayIndex) {
      event.preventDefault();
      const m = this.snap(this.clampMin(this.yToMinutes(event.clientY)));
      this.drag = { mode: "create", dayIndex, anchorMin: m, moved: false };
      this.preview = { dayIndex, startMin: m, endMin: m };
    },

    // --- ドラッグ: 移動 ---
    onBlockDown(event, entry, dayIndex) {
      event.preventDefault();
      const m = this.snap(this.clampMin(this.yToMinutes(event.clientY)));
      this.drag = {
        mode: "move",
        entryId: entry.id,
        dayIndex,
        grabMin: m,
        origStart: minutesOfDay(entry.start),
        origEnd: minutesOfDay(entry.start) + this.durationOf(entry) / 60000,
        moved: false,
      };
    },

    // --- ドラッグ: リサイズ ---
    onResizeDown(event, entry, dayIndex, edge) {
      event.preventDefault();
      this.drag = {
        mode: "resize-" + edge,
        entryId: entry.id,
        dayIndex,
        origStart: minutesOfDay(entry.start),
        origEnd: minutesOfDay(entry.start) + this.durationOf(entry) / 60000,
        moved: false,
      };
    },

    onDragMove(event) {
      if (!this.drag) return;
      const d = this.drag;
      const m = this.snap(this.clampMin(this.yToMinutes(event.clientY)));

      if (d.mode === "create") {
        d.moved = true;
        this.preview.startMin = Math.min(d.anchorMin, m);
        this.preview.endMin = Math.max(d.anchorMin, m);
        return;
      }

      const entry = this.entries.find((x) => x.id === d.entryId);
      if (!entry) return;

      if (d.mode === "move") {
        const delta = m - d.grabMin;
        const dur = d.origEnd - d.origStart;
        let ns = Math.max(0, Math.min(1440 - dur, d.origStart + delta));
        const di = this.dayIndexFromX(event.clientX);
        if (delta !== 0 || di !== d.dayIndex) d.moved = true;
        this.setEntryTime(entry, this.weekDays[di], ns, ns + dur);
      } else if (d.mode === "resize-top") {
        d.moved = true;
        const ns = Math.max(0, Math.min(m, d.origEnd - SNAP_MIN));
        this.setEntryTime(entry, this.weekDays[d.dayIndex], ns, d.origEnd);
      } else if (d.mode === "resize-bottom") {
        d.moved = true;
        const ne = Math.min(1440, Math.max(m, d.origStart + SNAP_MIN));
        this.setEntryTime(entry, this.weekDays[d.dayIndex], d.origStart, ne);
      }
    },

    onDragUp(event) {
      if (!this.drag) return;
      const d = this.drag;

      if (d.mode === "create") {
        let { startMin, endMin } = this.preview;
        if (endMin - startMin < SNAP_MIN) {
          // ほぼクリック → 既定長さのブロックを作成
          endMin = startMin + DEFAULT_DUR;
          if (endMin > 1440) {
            endMin = 1440;
            startMin = 1440 - DEFAULT_DUR;
          }
        }
        const entry = {
          id: uuid(),
          description: "",
          projectId: this.lastProjectId,
          tags: [],
          start: null,
          end: null,
        };
        this.setEntryTime(entry, this.weekDays[d.dayIndex], startMin, endMin);
        this.entries.push(entry);
        this.preview = null;
        this.openEditor(entry.id, event.clientX, event.clientY, true);
      } else if (d.mode === "move" && !d.moved) {
        // 動いていなければクリック扱い → 編集
        this.openEditor(d.entryId, event.clientX, event.clientY);
      }
      this.drag = null;
    },

    setEntryTime(entry, dateObj, startMin, endMin) {
      entry.start = this.atMinutes(dateObj, startMin);
      entry.end = this.atMinutes(dateObj, endMin);
    },
    atMinutes(dateObj, min) {
      const dt = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 0, 0, 0, 0);
      dt.setMinutes(min);
      return dt.toISOString();
    },

    // --- 編集モーダル ---
    openEditor(id, x, y, isDraft) {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) return;
      this.discardDraft(); // 直前の未保存ドラフトがあれば破棄
      if (typeof x === "number" && typeof y === "number") this.editorPos = { x, y };
      this.editingId = id;
      this.draftId = isDraft ? id : null;
      this.editForm = {
        description: entry.description,
        projectId: entry.projectId,
        tagsText: (entry.tags || []).join(", "),
        start: toLocalInput(entry.start),
        end: toLocalInput(entry.end),
      };
      // ドラフト確定までは履歴に記録しない
      if (isDraft) this.pauseHistory();
    },
    saveEdit() {
      const e = this.entries.find((x) => x.id === this.editingId);
      if (!e) return;
      const start = fromLocalInput(this.editForm.start);
      const end = fromLocalInput(this.editForm.end);
      if (new Date(end) <= new Date(start)) {
        alert("終了時刻は開始時刻より後にしてください。");
        return;
      }
      e.description = this.editForm.description.trim();
      e.projectId = this.editForm.projectId;
      e.tags = this.parseTags(this.editForm.tagsText);
      e.start = start;
      e.end = end;
      this.lastProjectId = e.projectId;
      const wasDraft = this.draftId === this.editingId;
      this.draftId = null;
      this.editingId = null;
      // ドラフトの作成+保存は1ステップとして履歴に確定する
      if (wasDraft) this.resumeHistory(true);
    },
    deleteEditing() {
      // ドラフトの削除は破棄と同じ(履歴に残さない)
      if (this.draftId === this.editingId) {
        this.closeEditor();
        return;
      }
      this.entries = this.entries.filter((e) => e.id !== this.editingId);
      this.closeEditor();
    },
    closeEditor() {
      this.discardDraft();
      this.editingId = null;
    },
    // 未保存の新規エントリを取り消す
    discardDraft() {
      if (!this.draftId) {
        this.resumeHistory(false); // 念のため: 一時停止だけ残っていれば解除
        return;
      }
      const id = this.draftId;
      this.draftId = null;
      this.entries = this.entries.filter((e) => e.id !== id);
      this.resumeHistory(false); // 破棄は履歴に記録しない
    },
    onOutsidePointer(event) {
      if (!this.editingId) return;
      const el = this.$refs.popover;
      if (el && !el.contains(event.target)) this.closeEditor();
    },
    onKey(event) {
      if (event.key === "Escape" && this.editingId) {
        this.closeEditor();
        return;
      }
      // 入力フィールド編集中はブラウザ既定の取り消しに任せる
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        event.shiftKey ? this.redo() : this.undo();
      } else if (mod && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        this.redo();
      }
    },

    // --- 履歴(undo/redo) ---
    pauseHistory() {
      if (this._paused) return;
      this._histPause();
      this._paused = true;
    },
    resumeHistory(commitNow) {
      if (!this._paused) return;
      this._histResume(commitNow);
      this._paused = false;
    },
    undo() {
      this._histUndo();
      this.closeEditor();
    },
    redo() {
      this._histRedo();
      this.closeEditor();
    },

    // --- プロジェクト ---
    addProject() {
      const name = this.newProject.name.trim();
      if (!name) return;
      this.projects.push({ id: uuid(), name, color: this.newProject.color });
      this.newProject.name = "";
    },
    removeProject(id) {
      this.projects = this.projects.filter((p) => p.id !== id);
      for (const e of this.entries) {
        if (e.projectId === id) e.projectId = null;
      }
      if (this.lastProjectId === id) this.lastProjectId = null;
    },
    projectOf(e) {
      return this.projects.find((p) => p.id === e.projectId) || null;
    },
    entryCountOf(projectId) {
      return this.entries.filter((e) => e.projectId === projectId).length;
    },

    // --- 集計ヘルパー ---
    durationOf(e) {
      return Math.max(0, new Date(e.end).getTime() - new Date(e.start).getTime());
    },
    rangeBounds(range) {
      const now = new Date();
      if (range === "all") return { start: 0, end: Infinity };
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (range === "today") {
        const end = new Date(startOfDay);
        end.setDate(end.getDate() + 1);
        return { start: startOfDay.getTime(), end: end.getTime() };
      }
      const day = (startOfDay.getDay() + 6) % 7;
      const start = new Date(startOfDay);
      start.setDate(start.getDate() - day);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start: start.getTime(), end: end.getTime() };
    },
    parseTags(text) {
      return text
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    },

    // --- フォーマット ---
    formatDuration(ms) {
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      return `${h}:${pad(m)}`;
    },
    formatClock(iso) {
      const d = new Date(iso);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    minToClock(min) {
      const h = Math.floor(min / 60) % 24;
      return `${pad(h)}:${pad(min % 60)}`;
    },
    pad2(n) {
      return pad(n);
    },

    // --- インポート/エクスポート ---
    exportJSON() {
      const data = JSON.stringify({ entries: this.entries, projects: this.projects }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `time-tracker-${dateKey(new Date().toISOString())}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    importJSON(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!Array.isArray(data.entries) || !Array.isArray(data.projects)) {
            throw new Error("形式が正しくありません");
          }
          if (!confirm("現在のデータを置き換えます。よろしいですか？")) return;
          this.projects = data.projects;
          this.entries = data.entries;
        } catch (err) {
          alert("インポートに失敗しました: " + err.message);
        } finally {
          event.target.value = "";
        }
      };
      reader.readAsText(file);
    },
  },

  mounted() {
    this._onMove = this.onDragMove.bind(this);
    this._onUp = this.onDragUp.bind(this);
    this._onOutside = this.onOutsidePointer.bind(this);
    this._onKey = this.onKey.bind(this);
    window.addEventListener("mousemove", this._onMove);
    window.addEventListener("mouseup", this._onUp);
    window.addEventListener("mousedown", this._onOutside);
    window.addEventListener("keydown", this._onKey);
    // 7:00 あたりが見えるようにスクロール
    this.$nextTick(() => {
      if (this.$refs.scroll) this.$refs.scroll.scrollTop = 7 * this.hourHeight;
    });
  },

  unmounted() {
    window.removeEventListener("mousemove", this._onMove);
    window.removeEventListener("mouseup", this._onUp);
    window.removeEventListener("mousedown", this._onOutside);
    window.removeEventListener("keydown", this._onKey);
  },
}).mount("#app");
