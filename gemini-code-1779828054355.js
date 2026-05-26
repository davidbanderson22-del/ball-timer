import { useState, useCallback, useEffect, useRef, useMemo } from "react";

// ── Fonts ─────────────────────────────────────────────────────────────────────
const FONT = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&display=swap";

// ── League presets ────────────────────────────────────────────────────────────
const LEAGUES = {
  hs:       { label: "High School",         halfInning: 10,  warmup: 3.0, innings: 7, mercy: 10, mercyAfter: 5 },
  college:  { label: "College / NCAA",      halfInning: 11,  warmup: 2.5, innings: 9, mercy: 10, mercyAfter: 7 },
  rec:      { label: "Adult Rec / Amateur", halfInning: 13,  warmup: 3.0, innings: 7, mercy: 10, mercyAfter: 5 },
  mlb:      { label: "MLB / Pro",           halfInning: 10,  warmup: 2.0, innings: 9, mercy: null, mercyAfter: null },
  softball: { label: "Softball",            halfInning: 9,   warmup: 2.5, innings: 7, mercy: 10, mercyAfter: 5 },
  custom:   { label: "Custom",              halfInning: 11,  warmup: 3.0, innings: 7, mercy: 10, mercyAfter: 5 },
};

// ── Phase constants ───────────────────────────────────────────────────────────
const EV = { START: "start", TOP: "top", MID: "mid", BOT: "bot" };
const PHASE_ORDER = [EV.START, EV.TOP, EV.MID, EV.BOT];
const isWarmup = p => p === EV.START || p === EV.MID;

function phaseLabel(inning, phase) {
  const m = { start: `Pre-${inning} Warmup`, top: `Top ${inning}`, mid: `Mid-${inning} Warmup`, bot: `Bot ${inning}` };
  return m[phase] ?? "";
}
function phaseDesc(phase) {
  const m = { start: "Between-inning warmup begins", top: "Top half (away at bat) begins", mid: "Mid-inning warmup begins", bot: "Bottom half (home at bat) begins" };
  return m[phase] ?? "";
}

// ── Time utils ────────────────────────────────────────────────────────────────
function parseTime(str) {
  if (!str) return null;
  const [h, m] = str.trim().split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
function formatTime(min) {
  if (min == null || isNaN(min)) return "—";
  const t = ((Math.round(min)) % 1440 + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function formatDur(min) {
  if (min == null || isNaN(min)) return "—";
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function nowHM() {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Next phase logic ──────────────────────────────────────────────────────────
function getNextPhase(events, totalInnings) {
  if (!events.length) return { inning: 1, phase: EV.START, needsScorePrompt: false };
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const last = sorted[sorted.length - 1];
  const idx = PHASE_ORDER.indexOf(last.phase);
  if (idx < 3) {
    const nextPhase = PHASE_ORDER[idx + 1];
    const needsScore = nextPhase === EV.MID;
    return { inning: last.inning, phase: nextPhase, needsScorePrompt: needsScore, scoringTeam: needsScore ? "away" : null, prevHalfInning: needsScore ? last.inning : null };
  }
  return { inning: last.inning + 1, phase: EV.START, needsScorePrompt: true, scoringTeam: "home", prevHalfInning: last.inning };
}

function isGamePotentiallyOver(events, score, totalInnings, mercyAfter, mercyRuns) {
  if (!events.length) return false;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const last = sorted[sorted.length - 1];
  const lastCompleted = sorted.filter(e => e.phase === EV.BOT).reduce((mx, e) => Math.max(mx, e.inning), 0);
  const diff = Math.abs(score.home - score.away);
  if (mercyAfter && mercyRuns && lastCompleted >= mercyAfter && diff >= mercyRuns && last.phase === EV.BOT) return true;
  if (last.inning === totalInnings && last.phase === EV.MID && score.home > score.away) return true;
  if (lastCompleted >= totalInnings && last.phase === EV.BOT) return true;
  return false;
}

// ── Monte Carlo probability engine ───────────────────────────────────────────
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-Math.min(lambda, 20));
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function computeProbs({ score, runsLog, totalInnings, mercyAfter, mercyRuns, lastCompletedInning, halfDurCount }) {
  if (halfDurCount < 2) return null;
  const prior = 0.8, pw = 2;
  const awayRuns   = runsLog.filter(r => r.team === "away").reduce((s, r) => s + r.runs, 0);
  const homeRuns   = runsLog.filter(r => r.team === "home").reduce((s, r) => s + r.runs, 0);
  const awayHalves = Math.max(1, runsLog.filter(r => r.half === "top").length);
  const homeHalves = Math.max(1, runsLog.filter(r => r.half === "bot").length);
  const awayRate   = (awayRuns + pw * prior) / (awayHalves + pw);
  const homeRate   = (homeRuns + pw * prior) / (homeHalves + pw);
  const remAway = Math.max(0, totalInnings - Math.ceil(halfDurCount / 2));
  const remHome = Math.max(0, totalInnings - lastCompletedInning);
  const N = 4000;
  let mercy = 0, endTop = 0, endBot = 0, extra = 0;
  for (let i = 0; i < N; i++) {
    let a = score.away, h = score.home;
    for (let j = 0; j < remAway; j++) a += poissonSample(awayRate);
    for (let j = 0; j < remHome; j++) h += poissonSample(homeRate);
    const diff = Math.abs(a - h);
    if (mercyAfter && mercyRuns && diff >= mercyRuns && lastCompletedInning >= mercyAfter - 1) mercy++;
    if (h > a) endTop++; else if (a > h) endBot++; else extra++;
  }
  return {
    mercy:       clamp(mercy / N, 0, 0.97),
    endAfterTop: clamp(endTop / N, 0, 0.97),
    endAfterBot: clamp(endBot / N, 0, 0.97),
    extra:       clamp(extra / N, 0, 0.97),
    awayRate, homeRate,
  };
}

// ── Core estimate engine ──────────────────────────────────────────────────────
function computeEstimate({ events, score, totalInnings, mercyAfter, mercyRuns, fallbackHalf, fallbackWarmup, runsLog }) {
  if (!events.length) return null;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const halfDurs = [], warmupDurs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const c = sorted[i], n = sorted[i + 1];
    const d = n.time - c.time;
    if (d < 0 || d > 90) continue;
    if (c.phase === EV.START && n.phase === EV.TOP  && n.inning === c.inning)      warmupDurs.push(d);
    if (c.phase === EV.MID  && n.phase === EV.BOT  && n.inning === c.inning)      warmupDurs.push(d);
    if (c.phase === EV.TOP  && n.phase === EV.MID  && n.inning === c.inning)      halfDurs.push(d);
    if (c.phase === EV.BOT  && n.phase === EV.START && n.inning === c.inning + 1) halfDurs.push(d);
  }
  const measuredHalf   = avg(halfDurs);
  const measuredWarmup = avg(warmupDurs);
  const avgHalf   = measuredHalf   ?? fallbackHalf;
  const avgWarmup = measuredWarmup ?? fallbackWarmup;
  const minS = Math.min(halfDurs.length, warmupDurs.length);
  const confidence = minS === 0 ? null : minS === 1 ? "low" : minS <= 2 ? "fair" : minS <= 4 ? "good" : "strong";
  const canEstimate = warmupDurs.length >= 1;
  const last = sorted[sorted.length - 1];
  const lastCompleted = sorted.filter(e => e.phase === EV.BOT).reduce((mx, e) => Math.max(mx, e.inning), 0);
  const runDiff = Math.abs(score.home - score.away);
  const mercyEligible = !!(mercyAfter && mercyRuns && lastCompleted >= mercyAfter && runDiff >= mercyRuns);
  const homeLeading = score.home > score.away;
  const botFinalNeeded = !homeLeading;
  const inExtra = lastCompleted >= totalInnings;
  let remHalf = 0, remWarmup = 0;
  const effEnd = inExtra ? lastCompleted + 1 : totalInnings;
  for (let inn = 1; inn <= effEnd; inn++) {
    for (const ph of PHASE_ORDER) {
      if (inn === totalInnings && ph === EV.BOT && !botFinalNeeded && !inExtra) continue;
      if (inn === 1 && ph === EV.START) continue;
      if (sorted.some(e => e.inning === inn && e.phase === ph)) continue;
      if (ph === EV.TOP || ph === EV.BOT) remHalf++; else remWarmup++;
    }
  }
  if (inExtra) { remHalf += 2; remWarmup += 2; }
  const estimatedEnd = last.time + remHalf * avgHalf + remWarmup * avgWarmup;
  const probs = computeProbs({ score, runsLog, totalInnings, mercyAfter, mercyRuns, lastCompletedInning: lastCompleted, halfDurCount: halfDurs.length });
  return {
    avgHalf, avgWarmup, measuredHalf, measuredWarmup,
    halfDurs, warmupDurs, confidence, canEstimate,
    remHalf, remWarmup, estimatedEnd, last,
    mercyEligible, botFinalNeeded, inExtra,
    lastCompletedInning: lastCompleted, currentlyInWarmup: isWarmup(last.phase),
    probs, runDiff,
  };
}

// ── Import / Export helpers ───────────────────────────────────────────────────
const SAVE_VERSION = 1;

function exportGame(config, events, score, runsLog, gameLog, estimateHistory) {
  const data = {
    v: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    config, events, score, runsLog, gameLog, estimateHistory,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const ts   = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  a.href     = url;
  a.download = `game_${config.away}_vs_${config.home}_${ts}.json`.replace(/\s+/g, "_");
  a.click();
  URL.revokeObjectURL(url);
}

function exportGameText(config, events, score, runsLog, gameLog, estimateHistory) {
  const lines = [
    `GAME: ${config.away} @ ${config.home}`,
    `SAVED: ${new Date().toLocaleString()}`,
    `---`,
    JSON.stringify({ v: SAVE_VERSION, config, events, score, runsLog, gameLog, estimateHistory }),
  ];
  return lines.join("\n");
}

function parseImport(text) {
  try {
    // Try direct JSON parse first
    const data = JSON.parse(text.trim());
    if (data.v && data.config && data.events) return { ok: true, data };
    return { ok: false, error: "Unrecognized format" };
  } catch {
    // Try extracting JSON from text export (last line)
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        if (data.v && data.config && data.events) return { ok: true, data };
      } catch {}
    }
    return { ok: false, error: "Could not parse game data" };
  }
}

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0c0f0a", card: "#141914", border: "#1f261e", borderBright: "#2e3d2c",
  text: "#dde8d8", muted: "#6b7f66", faint: "#2e3d2c",
  green: "#4caf6e", greenDim: "#0d2016",
  red: "#e05c4b", redDim: "#2a0d09",
  yellow: "#d4a843", yellowDim: "#2a1f07",
  blue: "#5b9bd5", blueDim: "#0a1829",
  accent: "#a3e635", accentDim: "#1a2a06",
  orange: "#e8834a",
};
const DISPLAY = "'Bebas Neue', Impact, sans-serif";
const SERIF   = "'DM Serif Display', Georgia, serif";
const MONO    = "'DM Mono', 'Courier New', monospace";

// ── Micro components ──────────────────────────────────────────────────────────
function Label({ children, style: s }) {
  return <div style={{ fontSize: "9px", letterSpacing: "2.5px", textTransform: "uppercase", color: C.muted, fontFamily: MONO, marginBottom: "5px", ...s }}>{children}</div>;
}
function Inp({ value, onChange, placeholder, type = "text", style: s, autoFocus }) {
  return (
    <input autoFocus={autoFocus} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", color: C.text, padding: "9px 11px", fontSize: "13px", fontFamily: MONO, width: "100%", boxSizing: "border-box", outline: "none", WebkitAppearance: "none", ...s }} />
  );
}
function Sel({ value, onChange, children, style: s }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", color: C.text, padding: "9px 11px", fontSize: "13px", fontFamily: MONO, width: "100%", boxSizing: "border-box", outline: "none", WebkitAppearance: "none", ...s }}>
      {children}
    </select>
  );
}
function Btn({ children, onClick, variant = "primary", small, full, disabled, style: s }) {
  const vs = {
    primary:   { background: C.accent,  color: C.bg,   border: "none" },
    ghost:     { background: "transparent", color: C.muted, border: `1px solid ${C.border}` },
    danger:    { background: C.red,     color: "#fff", border: "none" },
    success:   { background: C.green,   color: C.bg,   border: "none" },
    highlight: { background: C.yellow,  color: C.bg,   border: "none" },
    blue:      { background: C.blue,    color: "#fff", border: "none" },
  };
  return (
    <button onClick={disabled ? undefined : onClick} style={{
      ...vs[variant], cursor: disabled ? "default" : "pointer",
      fontFamily: DISPLAY, borderRadius: "4px", letterSpacing: "1.5px",
      fontSize: small ? "13px" : "15px", padding: small ? "7px 13px" : "11px 20px",
      width: full ? "100%" : undefined, opacity: disabled ? 0.35 : 1, transition: "opacity 0.15s", ...s,
    }}>{children}</button>
  );
}
function Toggle({ on, onToggle, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <button onClick={onToggle} style={{ background: on ? C.accent : C.faint, border: "none", borderRadius: "3px", width: "38px", height: "22px", cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
        <div style={{ position: "absolute", top: "3px", left: on ? "19px" : "3px", width: "16px", height: "16px", background: on ? C.bg : C.muted, borderRadius: "2px", transition: "left 0.2s" }} />
      </button>
      <span style={{ fontSize: "11px", color: C.muted, fontFamily: MONO }}>{label}</span>
    </div>
  );
}
function ProbBar({ label, value, color }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <div style={{ marginBottom: "9px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "11px", color: C.muted, fontFamily: MONO }}>{label}</span>
        <span style={{ fontSize: "11px", color, fontFamily: MONO, fontWeight: 500 }}>{pct}%</span>
      </div>
      <div style={{ height: "3px", background: C.faint, borderRadius: "2px" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "2px", transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}
function ConfChip({ confidence }) {
  if (!confidence) return null;
  const map = { low: { label: "Low", color: C.red, bg: C.redDim }, fair: { label: "Fair", color: C.yellow, bg: C.yellowDim }, good: { label: "Good", color: C.blue, bg: C.blueDim }, strong: { label: "Strong", color: C.green, bg: C.greenDim } };
  const { label, color, bg } = map[confidence];
  return <span style={{ fontSize: "9px", letterSpacing: "1.5px", textTransform: "uppercase", color, background: bg, border: `1px solid ${color}`, borderRadius: "3px", padding: "2px 7px", fontFamily: MONO }}>{label}</span>;
}
function StatBox({ label, value, sub, color, dim }) {
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "8px 6px", textAlign: "center", opacity: dim ? 0.45 : 1, transition: "opacity 0.3s" }}>
      <Label style={{ marginBottom: "3px" }}>{label}</Label>
      <div style={{ fontSize: "20px", fontFamily: DISPLAY, letterSpacing: "1px", color: color ?? C.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: "9px", color: C.faint, fontFamily: MONO, marginTop: "2px" }}>{sub}</div>}
    </div>
  );
}
function Divider({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", margin: "13px 0 10px" }}>
      <div style={{ flex: 1, height: "1px", background: C.border }} />
      {label && <span style={{ fontSize: "9px", letterSpacing: "2px", textTransform: "uppercase", color: C.faint, fontFamily: MONO }}>{label}</span>}
      <div style={{ flex: 1, height: "1px", background: C.border }} />
    </div>
  );
}

// ── Linescore ─────────────────────────────────────────────────────────────────
function Linescore({ away, home, score, runsLog, totalInnings, lastCompletedInning }) {
  const cols = Array.from({ length: Math.max(totalInnings, lastCompletedInning) }, (_, i) => i + 1);
  const getRuns = (team, inning) => {
    const half = team === "away" ? "top" : "bot";
    const entries = runsLog.filter(r => r.team === team && r.inning === inning && r.half === half);
    const played = team === "away" ? inning <= Math.ceil((lastCompletedInning || 0) + 0.5) : inning <= (lastCompletedInning || 0);
    if (!entries.length) return played ? "0" : "·";
    return String(entries.reduce((s, r) => s + r.runs, 0));
  };
  const cell = val => ({ width: "26px", minWidth: "26px", textAlign: "center", fontSize: "12px", fontFamily: MONO, padding: "5px 2px", color: val === "·" ? C.faint : val !== "0" ? C.accent : C.text, borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` });
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <td style={{ width: "64px", fontSize: "9px", fontFamily: MONO, color: C.faint, padding: "3px 4px", borderBottom: `1px solid ${C.border}` }} />
            {cols.map(i => <td key={i} style={{ width: "26px", minWidth: "26px", textAlign: "center", fontSize: "9px", fontFamily: MONO, color: C.faint, padding: "3px 2px", borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>{i}{i > totalInnings ? "x" : ""}</td>)}
            <td style={{ width: "28px", textAlign: "center", fontSize: "9px", fontFamily: MONO, color: C.muted, padding: "3px 4px", borderBottom: `1px solid ${C.border}` }}>R</td>
          </tr>
        </thead>
        <tbody>
          {[["away", away], ["home", home]].map(([side, name]) => (
            <tr key={side}>
              <td style={{ fontSize: "10px", fontFamily: MONO, color: C.muted, padding: "5px 4px", maxWidth: "64px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` }}>{name}</td>
              {cols.map(inn => { const v = getRuns(side, inn); return <td key={inn} style={cell(v)}>{v}</td>; })}
              <td style={{ width: "28px", textAlign: "center", fontSize: "14px", fontFamily: DISPLAY, color: C.accent, padding: "5px 4px", borderBottom: `1px solid ${C.border}` }}>{score[side]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Accuracy Graph ────────────────────────────────────────────────────────────
function AccuracyGraph({ estimateHistory, endTime, config }) {
  const [xMode, setXMode] = useState("inning");   // "inning" | "time"
  const [yMode, setYMode] = useState("signed");   // "signed" | "absolute"
  const svgRef = useRef(null);

  const points = useMemo(() => {
    if (!endTime || !estimateHistory.length) return [];
    return estimateHistory
      .filter(h => h.estimate != null)
      .map(h => ({
        ...h,
        error: yMode === "signed" ? Math.round(h.estimate - endTime) : Math.round(Math.abs(h.estimate - endTime)),
        xVal:  xMode === "inning" ? h.inning + (h.phase === EV.MID || h.phase === EV.BOT ? 0.5 : 0) : h.wallTime,
      }));
  }, [estimateHistory, endTime, xMode, yMode]);

  if (!points.length) return null;

  const W = 320, H = 180, PL = 44, PR = 12, PT = 16, PB = 28;
  const IW = W - PL - PR, IH = H - PT - PB;

  const xs = points.map(p => p.xVal);
  const ys = points.map(p => p.error);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yAbsMax = Math.max(Math.abs(Math.min(...ys)), Math.abs(Math.max(...ys)), 5);
  const yMin = yMode === "signed" ? -yAbsMax : 0;
  const yMax = yAbsMax;

  const toSVG = (xv, yv) => ({
    x: PL + ((xv - xMin) / (xMax - xMin || 1)) * IW,
    y: PT + (1 - (yv - yMin) / (yMax - yMin || 1)) * IH,
  });

  const zeroY = PT + (1 - (0 - yMin) / (yMax - yMin || 1)) * IH;
  const pathD = points.map((p, i) => { const { x, y } = toSVG(p.xVal, p.error); return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");

  // Y-axis ticks
  const yTicks = [];
  const step = Math.ceil(yAbsMax / 3);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v);

  // X-axis ticks
  const xTicks = xMode === "inning"
    ? Array.from({ length: config.totalInnings }, (_, i) => i + 1).filter(v => v >= xMin && v <= xMax)
    : points.map(p => p.xVal);

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <Label style={{ marginBottom: 0 }}>Estimate Accuracy Over Game</Label>
        <div style={{ display: "flex", gap: "6px" }}>
          {[["signed", "±"], ["absolute", "|e|"]].map(([v, l]) => (
            <button key={v} onClick={() => setYMode(v)} style={{ background: yMode === v ? C.accent : C.bg, border: `1px solid ${yMode === v ? C.accent : C.border}`, color: yMode === v ? C.bg : C.muted, borderRadius: "3px", padding: "3px 8px", fontSize: "10px", fontFamily: MONO, cursor: "pointer" }}>{l}</button>
          ))}
          {[["inning", "Inn"], ["time", "Time"]].map(([v, l]) => (
            <button key={v} onClick={() => setXMode(v)} style={{ background: xMode === v ? C.blue : C.bg, border: `1px solid ${xMode === v ? C.blue : C.border}`, color: xMode === v ? "#fff" : C.muted, borderRadius: "3px", padding: "3px 8px", fontSize: "10px", fontFamily: MONO, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg ref={svgRef} width={W} height={H} style={{ display: "block", margin: "0 auto" }}>
          {/* Zero line */}
          {yMode === "signed" && (
            <line x1={PL} y1={zeroY} x2={W - PR} y2={zeroY} stroke={C.borderBright} strokeWidth="1" strokeDasharray="4,4" />
          )}
          {/* Grid lines */}
          {yTicks.map(v => {
            const y = PT + (1 - (v - yMin) / (yMax - yMin || 1)) * IH;
            return <line key={v} x1={PL} y1={y} x2={W - PR} y2={y} stroke={C.faint} strokeWidth="0.5" />;
          })}
          {/* Axes */}
          <line x1={PL} y1={PT} x2={PL} y2={PT + IH} stroke={C.border} strokeWidth="1" />
          <line x1={PL} y1={PT + IH} x2={W - PR} y2={PT + IH} stroke={C.border} strokeWidth="1" />
          {/* Y labels */}
          {yTicks.map(v => {
            const y = PT + (1 - (v - yMin) / (yMax - yMin || 1)) * IH;
            return <text key={v} x={PL - 4} y={y + 4} textAnchor="end" fontSize="8" fill={C.muted} fontFamily={MONO}>{v > 0 ? `+${v}` : v}m</text>;
          })}
          {/* X labels */}
          {xMode === "inning" ? xTicks.map(v => {
            const { x } = toSVG(v, 0);
            return <text key={v} x={x} y={H - 6} textAnchor="middle" fontSize="8" fill={C.muted} fontFamily={MONO}>{v}</text>;
          }) : points.map((p, i) => {
            if (i % Math.max(1, Math.floor(points.length / 5)) !== 0) return null;
            const { x } = toSVG(p.xVal, 0);
            return <text key={i} x={x} y={H - 6} textAnchor="middle" fontSize="7" fill={C.muted} fontFamily={MONO}>{formatTime(p.wallTime)}</text>;
          })}
          {/* Area fill */}
          {points.length > 1 && (
            <path d={`${pathD} L${toSVG(points[points.length - 1].xVal, yMin).x},${toSVG(points[points.length - 1].xVal, yMin).y} L${toSVG(points[0].xVal, yMin).x},${toSVG(points[0].xVal, yMin).y} Z`}
              fill={C.accentDim} opacity="0.5" />
          )}
          {/* Line */}
          {points.length > 1 && <path d={pathD} fill="none" stroke={C.accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {/* Points */}
          {points.map((p, i) => {
            const { x, y } = toSVG(p.xVal, p.error);
            const col = yMode === "signed"
              ? (p.error > 0 ? C.yellow : p.error < 0 ? C.blue : C.green)
              : (Math.abs(p.error) <= 5 ? C.green : Math.abs(p.error) <= 15 ? C.yellow : C.red);
            return <circle key={i} cx={x} cy={y} r="4" fill={col} stroke={C.bg} strokeWidth="1.5" />;
          })}
          {/* Axis labels */}
          <text x={PL + IW / 2} y={H} textAnchor="middle" fontSize="8" fill={C.faint} fontFamily={MONO}>{xMode === "inning" ? "Inning" : "Time"}</text>
          <text x={8} y={PT + IH / 2} textAnchor="middle" fontSize="8" fill={C.faint} fontFamily={MONO} transform={`rotate(-90,8,${PT + IH / 2})`}>Error (min)</text>
        </svg>
      </div>

      <div style={{ display: "flex", gap: "12px", justifyContent: "center", marginTop: "8px" }}>
        {yMode === "signed"
          ? [["Overestimate (ran long)", C.yellow], ["Underestimate (ran short)", C.blue], ["Exact", C.green]].map(([l, c]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: c }} />
              <span style={{ fontSize: "9px", color: C.faint, fontFamily: MONO }}>{l}</span>
            </div>
          ))
          : [["≤5m", C.green], ["≤15m", C.yellow], [">15m", C.red]].map(([l, c]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: c }} />
              <span style={{ fontSize: "9px", color: C.faint, fontFamily: MONO }}>{l}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Import modal ──────────────────────────────────────────────────────────────
function ImportModal({ onImport, onCancel, hasActiveGame, onExportFirst }) {
  const [text, setText]     = useState("");
  const [error, setError]   = useState(null);
  const [step, setStep]     = useState(hasActiveGame ? "warn" : "paste"); // "warn" | "paste"
  const fileRef             = useRef(null);

  const handleFile = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setText(ev.target.result);
    reader.readAsText(file);
  };

  const handleImport = () => {
    const result = parseImport(text);
    if (!result.ok) { setError(result.error); return; }
    onImport(result.data);
  };

  if (step === "warn") {
    return (
      <div style={overlayStyle}>
        <div style={modalStyle}>
          <div style={{ fontSize: "16px", fontFamily: DISPLAY, letterSpacing: "1px", color: C.accent, marginBottom: "10px" }}>ACTIVE GAME IN PROGRESS</div>
          <div style={{ fontSize: "12px", color: C.muted, fontFamily: MONO, marginBottom: "18px", lineHeight: "1.6" }}>
            You have an active game. Importing will replace it.<br />Save the current game first?
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Btn full variant="highlight" onClick={() => { onExportFirst(); setStep("paste"); }}>Save Current Game First</Btn>
            <Btn full variant="ghost"     onClick={() => setStep("paste")}>Discard & Import</Btn>
            <Btn full variant="ghost"     onClick={onCancel}>Cancel</Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{ fontSize: "16px", fontFamily: DISPLAY, letterSpacing: "1px", color: C.accent, marginBottom: "10px" }}>IMPORT GAME</div>
        <div style={{ fontSize: "11px", color: C.muted, fontFamily: MONO, marginBottom: "12px" }}>Upload a .json file or paste the exported text below.</div>
        <input ref={fileRef} type="file" accept=".json,text/plain" onChange={handleFile} style={{ display: "none" }} />
        <Btn full variant="ghost" small onClick={() => fileRef.current.click()} style={{ marginBottom: "10px" }}>📂 Choose File</Btn>
        <textarea
          value={text} onChange={e => setText(e.target.value)}
          placeholder="Or paste exported text here…"
          style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", color: C.text, padding: "10px", fontSize: "11px", fontFamily: MONO, width: "100%", height: "100px", boxSizing: "border-box", resize: "none", outline: "none" }}
        />
        {error && <div style={{ fontSize: "11px", color: C.red, fontFamily: MONO, marginTop: "6px" }}>{error}</div>}
        <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
          <Btn full variant="primary"   onClick={handleImport} disabled={!text.trim()}>Import →</Btn>
          <Btn full variant="ghost"     onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" };
const modalStyle   = { background: C.card, border: `1px solid ${C.borderBright}`, borderRadius: "10px", padding: "20px", width: "100%", maxWidth: "360px" };

// ── Copy-text modal ───────────────────────────────────────────────────────────
function CopyModal({ text, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(text).then(() => setCopied(true)); };
  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{ fontSize: "16px", fontFamily: DISPLAY, letterSpacing: "1px", color: C.accent, marginBottom: "10px" }}>COPY TO SAVE</div>
        <div style={{ fontSize: "11px", color: C.muted, fontFamily: MONO, marginBottom: "10px" }}>Copy this text and save it anywhere (Notes, email, etc.).</div>
        <textarea readOnly value={text} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", color: C.text, padding: "10px", fontSize: "10px", fontFamily: MONO, width: "100%", height: "80px", boxSizing: "border-box", resize: "none", outline: "none" }} />
        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
          <Btn full variant={copied ? "success" : "primary"} onClick={copy}>{copied ? "Copied ✓" : "Copy"}</Btn>
          <Btn full variant="ghost" onClick={onClose}>Done</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Summary Screen ────────────────────────────────────────────────────────────
function SummaryScreen({ config, events, score, runsLog, endTime, estimateHistory, onNewGame }) {
  const { away, home, totalInnings } = config;
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const startTime = sorted[0]?.time;
  const actualDuration = endTime && startTime ? endTime - startTime : null;
  const lastCompleted = sorted.filter(e => e.phase === EV.BOT).reduce((mx, e) => Math.max(mx, e.inning), 0);
  const halfDurs = [], warmupDurs = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const c = sorted[i], n = sorted[i + 1];
    const d = n.time - c.time;
    if (d < 0 || d > 90) continue;
    if (c.phase === EV.START && n.phase === EV.TOP  && n.inning === c.inning)      warmupDurs.push(d);
    if (c.phase === EV.MID  && n.phase === EV.BOT  && n.inning === c.inning)      warmupDurs.push(d);
    if (c.phase === EV.TOP  && n.phase === EV.MID  && n.inning === c.inning)      halfDurs.push(d);
    if (c.phase === EV.BOT  && n.phase === EV.START && n.inning === c.inning + 1) halfDurs.push(d);
  }
  const firstEst = estimateHistory.find(h => h.estimate != null);
  const firstEstError = firstEst && endTime ? Math.round(firstEst.estimate - endTime) : null;
  const winner = score.home > score.away ? home : score.away > score.home ? away : null;
  const [showCopy, setShowCopy] = useState(false);
  const exportText = exportGameText(config, events, score, runsLog, [], estimateHistory);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: SERIF, padding: "0 0 60px" }}>
      <link rel="stylesheet" href={FONT} />
      {showCopy && <CopyModal text={exportText} onClose={() => setShowCopy(false)} />}

      <div style={{ background: `linear-gradient(180deg,${C.accentDim} 0%,${C.bg} 100%)`, padding: "36px 20px 28px", borderBottom: `1px solid ${C.border}`, textAlign: "center" }}>
        <div style={{ fontSize: "11px", letterSpacing: "4px", color: C.muted, fontFamily: MONO, textTransform: "uppercase" }}>Final Score</div>
        <div style={{ fontSize: "56px", fontFamily: DISPLAY, letterSpacing: "4px", marginTop: "8px", lineHeight: 1 }}>{score.away} – {score.home}</div>
        <div style={{ fontSize: "13px", color: C.muted, fontFamily: MONO, marginTop: "6px" }}>{away} @ {home}</div>
        {winner ? <div style={{ marginTop: "10px", fontSize: "13px", color: C.accent, fontFamily: MONO, letterSpacing: "2px" }}>{winner.toUpperCase()} WIN</div>
                : <div style={{ marginTop: "10px", fontSize: "13px", color: C.yellow, fontFamily: MONO, letterSpacing: "2px" }}>TIE</div>}
      </div>

      <div style={{ padding: "20px 16px", maxWidth: "420px", margin: "0 auto" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "12px" }}>
          <Label>Linescore</Label>
          <Linescore away={away} home={home} score={score} runsLog={runsLog} totalInnings={totalInnings} lastCompletedInning={lastCompleted} />
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "12px" }}>
          <Label>Game Time</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
            <StatBox label="First Pitch" value={formatTime(startTime)} />
            <StatBox label="Final Out"   value={formatTime(endTime)} />
            <StatBox label="Duration"    value={formatDur(actualDuration)} />
            <StatBox label="Innings"     value={`${lastCompleted}`} sub={lastCompleted > totalInnings ? "extra innings" : "regulation"} />
          </div>
          <Divider label="Pace" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <StatBox label="Avg Half-Inn" value={formatDur(avg(halfDurs))}   sub={`${halfDurs.length} measured`} />
            <StatBox label="Avg Warmup"   value={formatDur(avg(warmupDurs))} sub={`${warmupDurs.length} measured`} />
          </div>
        </div>

        {firstEstError !== null && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "12px" }}>
            <Label>First Estimate Accuracy</Label>
            <div style={{ fontSize: "32px", fontFamily: DISPLAY, letterSpacing: "1px", color: Math.abs(firstEstError) <= 5 ? C.green : Math.abs(firstEstError) <= 15 ? C.yellow : C.red }}>
              {firstEstError > 0 ? "+" : ""}{firstEstError}m
            </div>
            <div style={{ fontSize: "10px", color: C.faint, fontFamily: MONO, marginTop: "4px" }}>
              {Math.abs(firstEstError) <= 5 ? "Excellent — within 5 minutes" : Math.abs(firstEstError) <= 15 ? "Good — within 15 minutes" : "Off — unusual game pace or scoring"}
            </div>
          </div>
        )}

        <AccuracyGraph estimateHistory={estimateHistory} endTime={endTime} config={config} />

        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
          <Btn full variant="primary" onClick={onNewGame}>New Game →</Btn>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <Btn full variant="ghost" small onClick={() => exportGame(config, events, score, runsLog, [], estimateHistory)}>⬇ Download .json</Btn>
            <Btn full variant="ghost" small onClick={() => setShowCopy(true)}>📋 Copy Text</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({ onStart, onImport }) {
  const [league, setLeague]         = useState("hs");
  const [away, setAway]             = useState("");
  const [home, setHome]             = useState("");
  const [innings, setInnings]       = useState(7);
  const [mercyAfter, setMercyAfter] = useState(5);
  const [mercyRuns, setMercyRuns]   = useState(10);
  const [useMercy, setUseMercy]     = useState(true);
  const [useTimeLimit, setUseTimeLimit] = useState(false);
  const [timeLimit, setTimeLimit]   = useState("120");
  const [startTime, setStartTime]   = useState(nowHM());
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    if (league === "custom") return;
    const p = LEAGUES[league];
    setInnings(p.innings);
    if (p.mercy) { setMercyRuns(p.mercy); setMercyAfter(p.mercyAfter); setUseMercy(true); } else setUseMercy(false);
  }, [league]);

  const preset = LEAGUES[league];
  const valid  = away.trim() && home.trim();

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: SERIF, padding: "0 0 48px" }}>
      <link rel="stylesheet" href={FONT} />
      {showImport && (
        <ImportModal
          hasActiveGame={false}
          onImport={data => { setShowImport(false); onImport(data); }}
          onCancel={() => setShowImport(false)}
          onExportFirst={() => {}}
        />
      )}
      <div style={{ background: `linear-gradient(180deg,#0f1a0c 0%,${C.bg} 100%)`, padding: "36px 20px 24px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: "10px", letterSpacing: "5px", color: C.muted, fontFamily: MONO, textTransform: "uppercase" }}>Official</div>
        <div style={{ fontSize: "52px", fontFamily: DISPLAY, letterSpacing: "3px", color: C.accent, lineHeight: 1, marginTop: "4px" }}>GAME TIME<br />ESTIMATOR</div>
        <div style={{ fontSize: "12px", color: C.muted, fontFamily: MONO, marginTop: "8px", letterSpacing: "1px" }}>Baseball · Softball · Any inning game</div>
      </div>
      <div style={{ padding: "20px 16px", maxWidth: "420px", margin: "0 auto" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "16px", marginBottom: "12px" }}>
          <Label>League / Level</Label>
          <Sel value={league} onChange={setLeague}>
            {Object.entries(LEAGUES).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </Sel>
          {league !== "custom" && <div style={{ marginTop: "8px", fontSize: "10px", color: C.faint, fontFamily: MONO }}>{preset.innings} inn · {preset.halfInning}min half · {preset.warmup}min warmup{preset.mercy ? ` · mercy ${preset.mercy}r/inn ${preset.mercyAfter}` : " · no mercy"}</div>}
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "16px", marginBottom: "12px" }}>
          <Label>Teams</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>AWAY</div><Inp value={away} onChange={setAway} placeholder="Visitors" /></div>
            <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>HOME</div><Inp value={home} onChange={setHome} placeholder="Home" /></div>
          </div>
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "16px", marginBottom: "12px" }}>
          <Label>Rules</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "14px" }}>
            <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>INNINGS</div>
              <Sel value={innings} onChange={v => setInnings(Number(v))}>{[5,6,7,9].map(n => <option key={n} value={n}>{n}</option>)}</Sel></div>
            <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>FIRST PITCH</div><Inp value={startTime} onChange={setStartTime} placeholder="H:MM" /></div>
          </div>
          <Toggle on={useMercy} onToggle={() => setUseMercy(v => !v)} label="Mercy rule" />
          {useMercy && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "10px" }}>
              <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>ELIGIBLE AFTER INN</div>
                <Sel value={mercyAfter} onChange={v => setMercyAfter(Number(v))}>{[3,4,5,6,7,8].map(n => <option key={n} value={n}>{n}</option>)}</Sel></div>
              <div><div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>RUN DIFF</div>
                <Sel value={mercyRuns} onChange={v => setMercyRuns(Number(v))}>{[5,8,10,12,15,20].map(n => <option key={n} value={n}>{n}</option>)}</Sel></div>
            </div>
          )}
          <div style={{ marginTop: "14px" }}>
            <Toggle on={useTimeLimit} onToggle={() => setUseTimeLimit(v => !v)} label="Time limit" />
            {useTimeLimit && (
              <div style={{ marginTop: "10px" }}>
                <div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginBottom: "4px" }}>LIMIT (MINUTES)</div>
                <Inp value={timeLimit} onChange={setTimeLimit} placeholder="e.g. 120" type="number" />
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <Btn full disabled={!valid} onClick={() => {
            const t = parseTime(startTime) ?? parseTime(nowHM());
            onStart({ away: away.trim(), home: home.trim(), totalInnings: innings, mercyAfter: useMercy ? mercyAfter : null, mercyRuns: useMercy ? mercyRuns : null, timeLimit: useTimeLimit ? Number(timeLimit) : null, gameStartTime: t, fallbackHalf: LEAGUES[league].halfInning, fallbackWarmup: LEAGUES[league].warmup, league });
          }}>Start Game →</Btn>
          <Btn full variant="ghost" onClick={() => setShowImport(true)}>⬆ Import Saved Game</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Game Tracker ──────────────────────────────────────────────────────────────
function GameTracker({ config, onNewGame, initialState }) {
  const { away, home, totalInnings, mercyAfter, mercyRuns, timeLimit, gameStartTime, fallbackHalf, fallbackWarmup } = config;

  const [events,          setEvents]          = useState(initialState?.events          ?? []);
  const [score,           setScore]           = useState(initialState?.score           ?? { home: 0, away: 0 });
  const [runsLog,         setRunsLog]         = useState(initialState?.runsLog         ?? []);
  const [gameLog,         setGameLog]         = useState(initialState?.gameLog         ?? []);
  const [estimateHistory, setEstimateHistory] = useState(initialState?.estimateHistory ?? []);

  const [awaitingScore,      setAwaitingScore]      = useState(false);
  const [pendingEvent,       setPendingEvent]        = useState(null);
  const [scorePromptTeam,    setScorePromptTeam]     = useState(null);
  const [scorePromptInning,  setScorePromptInning]   = useState(null);
  const [scorePromptHalf,    setScorePromptHalf]     = useState(null);
  const [scoreInput,         setScoreInput]          = useState("0");

  const [gameOverPrompt, setGameOverPrompt] = useState(false);
  const [endTimeInput,   setEndTimeInput]   = useState(nowHM());
  const [showSummary,    setShowSummary]    = useState(false);
  const [finalEndTime,   setFinalEndTime]   = useState(null);

  const [entryTime, setEntryTime] = useState(nowHM());
  const [showImport, setShowImport] = useState(false);
  const [showCopy, setShowCopy]   = useState(false);
  const [copyText, setCopyText]   = useState("");

  const logRef = useRef(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [gameLog]);

  const addLog = msg => setGameLog(p => [...p, { msg, ts: nowHM() }]);

  const next = getNextPhase(events, totalInnings);
  const est  = computeEstimate({ events, score, totalInnings, mercyAfter, mercyRuns, fallbackHalf, fallbackWarmup, runsLog });

  // Snapshot estimate history after each event
  useEffect(() => {
    if (!est?.canEstimate || !events.length) return;
    const lastEv = [...events].sort((a, b) => a.time - b.time).pop();
    setEstimateHistory(prev => {
      // Avoid duplicate snapshots for same event
      if (prev.length && prev[prev.length - 1].eventId === lastEv.id) return prev;
      return [...prev, {
        eventId:   lastEv.id,
        wallTime:  lastEv.time,
        inning:    lastEv.inning,
        phase:     lastEv.phase,
        estimate:  est.estimatedEnd,
        confidence: est.confidence,
      }];
    });
  }, [events.length, est?.estimatedEnd]);

  const potOver = isGamePotentiallyOver(events, score, totalInnings, mercyAfter, mercyRuns);
  useEffect(() => { if (potOver && !gameOverPrompt && !showSummary) { setGameOverPrompt(true); setEndTimeInput(nowHM()); } }, [potOver]);

  const inWarmup = est?.currentlyInWarmup ?? false;
  const lastCompleted = est?.lastCompletedInning ?? 0;
  const runDiff = Math.abs(score.home - score.away);
  const progressPct = Math.min(100, (lastCompleted / totalInnings) * 100);
  const timeLimitEnd = timeLimit ? gameStartTime + timeLimit : null;

  const doExport = () => exportGame(config, events, score, runsLog, gameLog, estimateHistory);
  const doCopyText = () => { setCopyText(exportGameText(config, events, score, runsLog, gameLog, estimateHistory)); setShowCopy(true); };

  const handleLogNow = (timeOverride) => {
    const t = parseTime(timeOverride ?? entryTime);
    if (t == null) return;
    if (next.needsScorePrompt) {
      setAwaitingScore(true);
      setPendingEvent({ inning: next.inning, phase: next.phase, time: t });
      setScorePromptTeam(next.scoringTeam);
      setScorePromptInning(next.prevHalfInning);
      setScorePromptHalf(next.scoringTeam === "away" ? "top" : "bot");
      setScoreInput("0");
    } else {
      commitEvent({ inning: next.inning, phase: next.phase, time: t });
    }
  };

  const commitEvent = ev => {
    setEvents(p => [...p, { ...ev, id: Date.now() }]);
    addLog(`📍 ${phaseLabel(ev.inning, ev.phase)} — ${formatTime(ev.time)}`);
    setEntryTime(nowHM());
  };

  const handleScoreConfirm = () => {
    const runs = Math.max(0, parseInt(scoreInput) || 0);
    if (runs > 0) {
      setScore(p => ({ ...p, [scorePromptTeam]: p[scorePromptTeam] + runs }));
      setRunsLog(p => [...p, { team: scorePromptTeam, runs, inning: scorePromptInning, half: scorePromptHalf }]);
      addLog(`🏃 ${scorePromptTeam === "home" ? home : away} scored ${runs} in ${scorePromptHalf === "top" ? "Top" : "Bot"} ${scorePromptInning}`);
    }
    commitEvent(pendingEvent);
    setAwaitingScore(false); setPendingEvent(null);
  };

  const handleUndo = () => {
    if (!events.length) return;
    const sorted = [...events].sort((a, b) => a.time - b.time);
    const last   = sorted[sorted.length - 1];
    setEvents(p => p.filter(e => e.id !== last.id));
    setEstimateHistory(p => p.filter(h => h.eventId !== last.id));
    const lastRun = runsLog[runsLog.length - 1];
    if (lastRun) { setScore(p => ({ ...p, [lastRun.team]: Math.max(0, p[lastRun.team] - lastRun.runs) })); setRunsLog(p => p.slice(0, -1)); }
    setGameLog(p => p.slice(0, -1));
    setGameOverPrompt(false);
  };

  const handleEndGame = () => {
    const t = parseTime(endTimeInput) ?? parseTime(nowHM());
    setFinalEndTime(t);
    addLog(`🏁 Final out — ${formatTime(t)}`);
    setShowSummary(true);
  };

  const handleImport = data => {
    setShowImport(false);
    // Full state restore
    setEvents(data.events ?? []);
    setScore(data.score ?? { home: 0, away: 0 });
    setRunsLog(data.runsLog ?? []);
    setGameLog(data.gameLog ?? []);
    setEstimateHistory(data.estimateHistory ?? []);
  };

  if (showSummary) {
    return <SummaryScreen config={config} events={events} score={score} runsLog={runsLog} endTime={finalEndTime} estimateHistory={estimateHistory} onNewGame={onNewGame} />;
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: SERIF, maxWidth: "440px", margin: "0 auto", paddingBottom: "48px" }}>
      <link rel="stylesheet" href={FONT} />

      {showCopy   && <CopyModal text={copyText} onClose={() => setShowCopy(false)} />}
      {showImport && (
        <ImportModal
          hasActiveGame={events.length > 0}
          onImport={handleImport}
          onCancel={() => setShowImport(false)}
          onExportFirst={doExport}
        />
      )}

      {/* ── Header ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "12px 14px 10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "9px", letterSpacing: "3px", color: C.muted, fontFamily: MONO, textTransform: "uppercase" }}>
              {totalInnings}inn · {LEAGUES[config.league]?.label ?? "Custom"}{mercyAfter ? ` · M${mercyRuns}/${mercyAfter}` : ""}{timeLimit ? ` · ${timeLimit}m` : ""}
            </div>
            <div style={{ fontSize: "22px", fontFamily: DISPLAY, letterSpacing: "1px", marginTop: "2px", lineHeight: 1.1 }}>
              {away} <span style={{ color: C.faint, fontSize: "16px" }}>@</span> {home}
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {events.length > 0 && <Btn small variant="ghost" onClick={handleUndo}>↩ Undo</Btn>}
            <Btn small variant="ghost" onClick={doExport}>⬇</Btn>
            <Btn small variant="ghost" onClick={doCopyText}>📋</Btn>
            <Btn small variant="ghost" onClick={() => setShowImport(true)}>⬆</Btn>
            <Btn small variant="ghost" onClick={onNewGame}>New</Btn>
          </div>
        </div>

        {/* Scoreboard */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 32px 1fr", alignItems: "center", margin: "12px 0 10px" }}>
          {[["away", away], ["home", home]].map(([side, name], i) => (
            <div key={side} style={{ textAlign: i === 0 ? "left" : "right" }}>
              <div style={{ fontSize: "9px", color: C.muted, fontFamily: MONO, letterSpacing: "2px" }}>{side.toUpperCase()}</div>
              <div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ fontSize: "58px", fontFamily: DISPLAY, lineHeight: 1, color: score[side] > score[side === "away" ? "home" : "away"] ? C.accent : C.text }}>{score[side]}</div>
            </div>
          ))}
          <div style={{ textAlign: "center", color: C.faint, fontFamily: DISPLAY, fontSize: "18px" }}>–</div>
        </div>

        <div>
          <div style={{ height: "3px", background: C.faint, borderRadius: "2px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progressPct}%`, background: C.accent, transition: "width 0.5s" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px" }}>
            {Array.from({ length: totalInnings }, (_, i) => <div key={i} style={{ fontSize: "8px", fontFamily: MONO, color: i < lastCompleted ? C.accent : C.faint }}>{i + 1}</div>)}
          </div>
        </div>
      </div>

      {/* Banners */}
      {est?.mercyEligible && <div style={{ background: C.redDim, borderLeft: `3px solid ${C.red}`, padding: "8px 14px", fontSize: "11px", fontFamily: MONO, color: C.red, letterSpacing: "1px" }}>⚠ MERCY ELIGIBLE — {score.home > score.away ? home : away} +{runDiff}</div>}
      {timeLimitEnd && est?.estimatedEnd > timeLimitEnd && <div style={{ background: C.yellowDim, borderLeft: `3px solid ${C.yellow}`, padding: "8px 14px", fontSize: "11px", fontFamily: MONO, color: C.yellow }}>⏱ Est. end {formatTime(est.estimatedEnd)} exceeds limit {formatTime(timeLimitEnd)}</div>}
      {inWarmup && <div style={{ background: C.accentDim, borderLeft: `3px solid ${C.accent}`, padding: "8px 14px", fontSize: "11px", fontFamily: MONO, color: C.accent }}>⏸ WARMUP — stats frozen, end time updating</div>}

      <div style={{ padding: "12px 14px 0" }}>

        {/* Score prompt */}
        {awaitingScore && (
          <div style={{ background: C.card, border: `2px solid ${C.accent}`, borderRadius: "8px", padding: "18px", marginBottom: "12px" }}>
            <Label>Runs Scored</Label>
            <div style={{ fontSize: "14px", color: C.text, fontFamily: MONO, marginBottom: "12px", lineHeight: "1.5" }}>
              How many runs did <span style={{ color: C.accent }}>{scorePromptTeam === "away" ? away : home}</span> score in {scorePromptHalf === "top" ? "Top" : "Bot"} {scorePromptInning}?
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "10px", alignItems: "end", marginBottom: "10px" }}>
              <Inp autoFocus value={scoreInput} onChange={setScoreInput} type="number" placeholder="0" style={{ fontSize: "24px", textAlign: "center", padding: "10px" }} />
              <Btn onClick={handleScoreConfirm} variant="primary">OK →</Btn>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              {[0,1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setScoreInput(String(n))} style={{ flex: 1, background: scoreInput === String(n) ? C.accent : C.bg, border: `1px solid ${scoreInput === String(n) ? C.accent : C.border}`, color: scoreInput === String(n) ? C.bg : C.muted, borderRadius: "4px", padding: "8px 4px", fontSize: "15px", fontFamily: DISPLAY, cursor: "pointer" }}>{n}</button>
              ))}
            </div>
          </div>
        )}

        {/* Game-over prompt */}
        {gameOverPrompt && !awaitingScore && (
          <div style={{ background: C.card, border: `2px solid ${C.yellow}`, borderRadius: "8px", padding: "18px", marginBottom: "12px" }}>
            <Label>Game Over?</Label>
            <div style={{ fontSize: "13px", color: C.text, fontFamily: MONO, marginBottom: "12px", lineHeight: "1.5" }}>The game should be over. Log end time to finalize.</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "8px", alignItems: "end" }}>
              <div><Label>End Time</Label><Inp value={endTimeInput} onChange={setEndTimeInput} placeholder="H:MM" /></div>
              <Btn onClick={handleEndGame} variant="highlight">End</Btn>
              <Btn onClick={() => setGameOverPrompt(false)} variant="ghost" small>More Inn.</Btn>
            </div>
          </div>
        )}

        {/* Estimate card */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "10px" }}>
          {!est?.canEstimate ? (
            <div style={{ padding: "8px 0" }}>
              <div style={{ fontSize: "13px", color: C.muted, fontFamily: MONO }}>Gathering data…</div>
              <div style={{ fontSize: "11px", color: C.faint, fontFamily: MONO, marginTop: "5px" }}>Log Pre-1 warmup → Top 1 → Mid-1 warmup to enable estimate</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <Label>Estimated End</Label>
                  <div style={{ fontSize: "42px", fontFamily: DISPLAY, letterSpacing: "2px", color: C.accent, lineHeight: 1 }}>{formatTime(est.estimatedEnd)}</div>
                  {est.inExtra && <div style={{ fontSize: "10px", color: C.orange, fontFamily: MONO, marginTop: "3px", letterSpacing: "1px" }}>EXTRA INNINGS</div>}
                  {timeLimitEnd && <div style={{ fontSize: "10px", color: C.yellow, fontFamily: MONO, marginTop: "2px" }}>Limit: {formatTime(timeLimitEnd)}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <ConfChip confidence={est.confidence} />
                  <div style={{ fontSize: "11px", color: C.muted, fontFamily: MONO, marginTop: "8px" }}>{est.last ? phaseLabel(est.last.inning, est.last.phase) : "—"}</div>
                  <div style={{ fontSize: "10px", color: C.faint, fontFamily: MONO, marginTop: "2px" }}>Bot {totalInnings}: {est.botFinalNeeded ? "▶ plays" : "◻ may skip"}</div>
                </div>
              </div>
              <Divider label="Pace" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "6px" }}>
                <StatBox label="½-Inn" value={formatDur(est.avgHalf)}   sub={est.measuredHalf   ? `${est.halfDurs.length}×`   : "fallback"} color={est.measuredHalf   ? C.text : C.muted} dim={inWarmup} />
                <StatBox label="Warmup" value={formatDur(est.avgWarmup)} sub={est.measuredWarmup ? `${est.warmupDurs.length}×` : "fallback"} color={est.measuredWarmup ? C.text : C.muted} dim={inWarmup} />
                <StatBox label="½-Inn Left" value={est.remHalf}   dim={inWarmup} />
                <StatBox label="Wrm Left"   value={est.remWarmup} dim={inWarmup} />
              </div>
            </>
          )}
        </div>

        {/* Probabilities */}
        {est?.probs && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "10px", opacity: inWarmup ? 0.5 : 1, transition: "opacity 0.3s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
              <Label style={{ marginBottom: 0 }}>Outcome Probabilities</Label>
              <span style={{ fontSize: "9px", color: C.faint, fontFamily: MONO }}>4k sim</span>
            </div>
            {mercyAfter && <ProbBar label="Mercy rule" value={est.probs.mercy} color={C.red} />}
            <ProbBar label={`Home wins (bot ${totalInnings} skipped)`} value={est.probs.endAfterTop} color={C.green} />
            <ProbBar label={`Away wins (full ${totalInnings} inn)`}    value={est.probs.endAfterBot} color={C.blue} />
            <ProbBar label="Extra innings" value={est.probs.extra} color={C.yellow} />
            <div style={{ fontSize: "9px", color: C.faint, fontFamily: MONO, marginTop: "6px" }}>{away}: {est.probs.awayRate?.toFixed(2)} r/half · {home}: {est.probs.homeRate?.toFixed(2)} r/half</div>
          </div>
        )}

        {/* Linescore */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "10px" }}>
          <Label>Linescore</Label>
          <Linescore away={away} home={home} score={score} runsLog={runsLog} totalInnings={totalInnings} lastCompletedInning={lastCompleted} />
          <Divider label="Run Stats" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "6px" }}>
            <StatBox label="Total R" value={score.away + score.home} dim={inWarmup} />
            <StatBox label="R / Inn"  value={lastCompleted > 0 ? ((score.away + score.home) / lastCompleted).toFixed(1) : "—"} dim={inWarmup} />
            <StatBox label="Diff"     value={runDiff} color={runDiff >= (mercyRuns ?? 999) ? C.red : C.text} dim={inWarmup} />
          </div>
        </div>

        {/* Log entry */}
        {!awaitingScore && !gameOverPrompt && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px", marginBottom: "10px" }}>
            <div style={{ marginBottom: "10px" }}>
              <Label>Next Phase</Label>
              <div style={{ fontSize: "20px", fontFamily: DISPLAY, letterSpacing: "1px", color: C.accent }}>{phaseLabel(next.inning, next.phase)}</div>
              <div style={{ fontSize: "10px", color: C.muted, fontFamily: MONO, marginTop: "2px" }}>{phaseDesc(next.phase)}</div>
              {next.needsScorePrompt && <div style={{ fontSize: "10px", color: C.yellow, fontFamily: MONO, marginTop: "3px" }}>↳ Will prompt for {next.scoringTeam === "away" ? away : home} runs</div>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "8px", alignItems: "end" }}>
              <div><Label>Time (H:MM)</Label><Inp value={entryTime} onChange={setEntryTime} placeholder="H:MM" /></div>
              <Btn variant="ghost" small onClick={() => { const t = nowHM(); setEntryTime(t); handleLogNow(t); }}>Now</Btn>
              <Btn variant="primary" onClick={() => handleLogNow()}>Log ↵</Btn>
            </div>
          </div>
        )}

        {/* Game log */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: "8px", padding: "14px" }}>
          <Label>Game Log</Label>
          <div ref={logRef} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "10px 12px", maxHeight: "160px", overflowY: "auto", fontFamily: MONO, fontSize: "11px", lineHeight: "1.9" }}>
            {gameLog.length === 0 ? <span style={{ color: C.faint }}>No events yet.</span>
              : gameLog.map((e, i) => <div key={i} style={{ color: i === gameLog.length - 1 ? C.text : C.muted }}><span style={{ color: C.faint }}>{e.ts} </span>{e.msg}</div>)}
          </div>
        </div>

        {events.length > 0 && !gameOverPrompt && (
          <div style={{ marginTop: "10px", textAlign: "center" }}>
            <button onClick={() => { setGameOverPrompt(true); setEndTimeInput(nowHM()); }} style={{ background: "none", border: "none", color: C.faint, fontSize: "11px", fontFamily: MONO, cursor: "pointer", textDecoration: "underline" }}>End game manually</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("setup"); // "setup" | "game"
  const [config,  setConfig]  = useState(null);
  const [initState, setInitState] = useState(null);
  const [key, setKey] = useState(0);

  const handleStart = cfg => { setConfig(cfg); setInitState(null); setKey(k => k + 1); setScreen("game"); };

  const handleImport = data => {
    setConfig(data.config);
    setInitState({ events: data.events, score: data.score, runsLog: data.runsLog, gameLog: data.gameLog, estimateHistory: data.estimateHistory ?? [] });
    setKey(k => k + 1);
    setScreen("game");
  };

  if (screen === "game" && config) {
    return <GameTracker key={key} config={config} onNewGame={() => setScreen("setup")} initialState={initState} />;
  }
  return <SetupScreen onStart={handleStart} onImport={handleImport} />;
}