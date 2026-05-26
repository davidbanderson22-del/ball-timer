// ==========================================
// 1. COMPONENT: SETUP SCREEN
// ==========================================
function SetupScreen({ onStart, onImport }) {
  const [awayTeam, setAwayTeam] = useState("Away Team");
  const [homeTeam, setHomeTeam] = useState("Home Team");
  const [innings, setInnings] = useState(7);

  const handleSubmit = (e) => {
    e.preventDefault();
    onStart({
      away: awayTeam,
      home: homeTeam,
      totalInnings: parseInt(innings, 10),
      league: "custom"
    });
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.config && data.events) {
          onImport(data);
        } else {
          alert("Invalid scorecard file format.");
        }
      } catch (err) {
        alert("Error reading file.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ maxWidth: "420px", margin: "40px auto", padding: "20px", fontFamily: "monospace", border: "2px solid #1a1a1a", background: "#fff", boxShadow: "4px 4px 0px #1a1a1a" }}>
      <h2 style={{ textTransform: "uppercase", letterSpacing: "1px", borderBottom: "2px solid #1a1a1a", paddingBottom: "10px", marginTop: 0 }}>
        📋 New Scorecard
      </h2>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "12px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", marginBottom: "4px" }}>AWAY TEAM</label>
          <input 
            type="text" 
            value={awayTeam} 
            onChange={e => setAwayTeam(e.target.value)}
            style={{ width: "100%", padding: "8px", boxSizing: "border-box", border: "1px solid #1a1a1a", fontFamily: "monospace" }}
          />
        </div>
        <div style={{ marginBottom: "12px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", marginBottom: "4px" }}>HOME TEAM</label>
          <input 
            type="text" 
            value={homeTeam} 
            onChange={e => setHomeTeam(e.target.value)}
            style={{ width: "100%", padding: "8px", boxSizing: "border-box", border: "1px solid #1a1a1a", fontFamily: "monospace" }}
          />
        </div>
        <div style={{ marginBottom: "20px" }}>
          <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", marginBottom: "4px" }}>SCHEDULED INNINGS</label>
          <input 
            type="number" 
            value={innings} 
            onChange={e => setInnings(e.target.value)}
            style={{ width: "100%", padding: "8px", boxSizing: "border-box", border: "1px solid #1a1a1a", fontFamily: "monospace" }}
          />
        </div>
        <button 
          type="submit" 
          style={{ width: "100%", padding: "12px", background: "#1a1a1a", color: "#fff", border: "none", fontWeight: "bold", cursor: "pointer", textTransform: "uppercase" }}
        >
          Play Ball
        </button>
      </form>

      <div style={{ marginTop: "20px", paddingTop: "20px", borderTop: "1px dashed #ccc", textAlign: "center" }}>
        <label style={{ fontSize: "11px", fontWeight: "bold", display: "block", marginBottom: "6px" }}>OR IMPORT SAVED GAME</label>
        <input type="file" accept=".json" onChange={handleFileChange} style={{ fontSize: "11px", fontFamily: "monospace" }} />
      </div>
    </div>
  );
}

// ==========================================
// 2. STATE MACHINE ENGINE
// ==========================================
function getLiveState(events, totalInnings) {
  let currentInning = 1;
  let currentPhase = PHASE.WARMUP_TOP;
  let outsInHalf = 0;

  const sorted = [...events].sort((a, b) => a.time - b.time);

  for (const ev of sorted) {
    if (ev.type === "OUT") {
      outsInHalf += ev.count;
      if (outsInHalf >= 3) {
        outsInHalf = 0;
        if (currentPhase === PHASE.TOP) {
          currentPhase = PHASE.WARMUP_BOT;
        } else if (currentPhase === PHASE.BOT) {
          currentInning += 1;
          currentPhase = PHASE.WARMUP_TOP;
        }
      }
    } else if (ev.type === "PHASE_START") {
      currentPhase = ev.phase;
    }
  }

  return { currentInning, currentPhase, outsInHalf };
}

// ==========================================
// 3. COMPONENT: LIVE TRACKER
// ==========================================
function GameTracker({ config, onNewGame, initialState }) {
  const { away, home, totalInnings } = config;

  const [events, setEvents] = useState(initialState?.events ?? []);
  const [score, setScore] = useState(initialState?.score ?? { home: 0, away: 0 });
  const [runsLog, setRunsLog] = useState(initialState?.runsLog ?? []);
  const [gameLog, setGameLog] = useState(initialState?.gameLog ?? []);
  const [entryTime, setEntryTime] = useState(nowHM());

  const { currentInning, currentPhase, outsInHalf } = getLiveState(events, totalInnings);

  const logEvent = (type, details = {}) => {
    const t = parseTime(entryTime) ?? parseTime(nowHM());
    const newEvent = {
      id: Date.now(),
      type,
      time: t,
      inning: currentInning,
      phase: currentPhase,
      ...details
    };

    const updatedEvents = [...events, newEvent];
    setEvents(updatedEvents);

    if (type === "OUT") {
      const displayOuts = outsInHalf + details.count;
      addLog(`🔴 Out #${displayOuts} logged in ${currentPhase} ${currentInning}`);
    } else if (type === "RUN") {
      const team = (currentPhase === PHASE.TOP || currentPhase === PHASE.WARMUP_TOP) ? "away" : "home";
      const teamName = team === "away" ? away : home;
      
      setScore(prev => {
        const nextScore = { ...prev, [team]: prev[team] + 1 };
        addLog(`🏃 ${teamName} scored a run (${nextScore[team]})`);
        return nextScore;
      });
      setRunsLog(prev => [...prev, { team, inning: currentInning, half: currentPhase, time: t }]);
    } else if (type === "PHASE_START") {
      addLog(`🟢 First pitch: Moving to active play (${details.phase})`);
    }
    
    setEntryTime(nowHM());
  };

  const addLog = msg => setGameLog(p => [...p, { msg, ts: nowHM() }]);

  const exportGameData = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ config, events, score, runsLog, gameLog }));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `scorecard_${away}_vs_${home}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "monospace", maxWidth: "440px", margin: "0 auto", padding: "16px", borderLeft: "2px dashed #ccc", borderRight: "2px dashed #ccc", boxSizing: "border-box" }}>
      
      {/* HEADER INFO */}
      <div style={{ border: "2px solid #1a1a1a", padding: "12px", background: "#fff", marginBottom: "16px", boxShadow: "4px 4px 0px #1a1a1a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", fontWeight: "bold", borderBottom: "1px solid #1a1a1a", paddingBottom: "6px" }}>
          <div>GAME TRACKER</div>
          <div>INN LIMIT: {totalInnings}</div>
        </div>
        
        {/* SCORE TABULATION */}
        <table style={{ width: "100%", marginTop: "8px", borderCollapse: "collapse", textAlign: "center" }}>
          <thead>
            <tr style={{ fontSize: "10px", color: "#666" }}>
              <th style={{ textAlign: "left" }}>TEAM</th>
              <th style={{ width: "40px", borderLeft: "1px solid #ccc" }}>R</th>
              <th style={{ width: "60px", borderLeft: "1px solid #ccc" }}>OUTS</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ fontSize: "16px", fontWeight: (currentPhase === PHASE.TOP || currentPhase === PHASE.WARMUP_TOP) ? "bold" : "normal" }}>
              <td style={{ textAlign: "left" }}>{(currentPhase === PHASE.TOP || currentPhase === PHASE.WARMUP_TOP) ? "► " : ""}{away}</td>
              <td style={{ borderLeft: "1px solid #ccc" }}>{score.away}</td>
              <td style={{ borderLeft: "1px solid #ccc", fontSize: "12px", letterSpacing: "2px" }}>
                {(currentPhase === PHASE.TOP) ? "●".repeat(outsInHalf) + "○".repeat(3 - outsInHalf) : "—"}
              </td>
            </tr>
            <tr style={{ fontSize: "16px", fontWeight: (currentPhase === PHASE.BOT || currentPhase === PHASE.WARMUP_BOT) ? "bold" : "normal" }}>
              <td style={{ textAlign: "left" }}>{(currentPhase === PHASE.BOT || currentPhase === PHASE.WARMUP_BOT) ? "► " : ""}{home}</td>
              <td style={{ borderLeft: "1px solid #ccc" }}>{score.home}</td>
              <td style={{ borderLeft: "1px solid #ccc", fontSize: "12px", letterSpacing: "2px" }}>
                {(currentPhase === PHASE.BOT) ? "●".repeat(outsInHalf) + "○".repeat(3 - outsInHalf) : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* STATE INDICATOR */}
      <div style={{ border: "2px solid #1a1a1a", padding: "10px", background: currentPhase.startsWith("W_") ? "#fff9e6" : "#e6f4ea", marginBottom: "16px", textAlign: "center", fontSize: "11px", fontWeight: "bold" }}>
        {currentPhase.startsWith("W_") ? (
          <div>⏳ FIELD WARMUP: {currentPhase === PHASE.WARMUP_TOP ? `Top ${currentInning}` : `Bot ${currentInning}`}</div>
        ) : (
          <div>⚾ LIVE ACTION: Inning {currentInning} ({currentPhase})</div>
        )}
      </div>

      {/* ACTION PANEL */}
      <div style={{ border: "2px solid #1a1a1a", padding: "14px", background: "#fff", marginBottom: "16px", boxShadow: "4px 4px 0px #1a1a1a" }}>
        <span style={{ fontSize: "11px", fontWeight: "bold", textTransform: "uppercase" }}>Quick Logger</span>
        
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", margin: "12px 0" }}>
          {currentPhase.startsWith("W_") ? (
            <button 
              onClick={() => logEvent("PHASE_START", { phase: currentPhase === PHASE.WARMUP_TOP ? PHASE.TOP : PHASE.BOT })}
              style={{ gridColumn: "1 / span 2", padding: "12px", background: "#1a1a1a", color: "#fff", border: "none", fontFamily: "monospace", fontWeight: "bold", cursor: "pointer" }}
            >
              🟢 First Pitch (Start Play)
            </button>
          ) : (
            <>
              <button 
                onClick={() => logEvent("OUT", { count: 1 })}
                style={{ padding: "14px", background: "#fff", border: "1px solid #1a1a1a", fontFamily: "monospace", fontWeight: "bold", cursor: "pointer" }}
              >
                ➕ Log Out
              </button>
              <button 
                onClick={() => logEvent("RUN")}
                style={{ padding: "14px", background: "#fff", border: "1px solid #1a1a1a", fontFamily: "monospace", fontWeight: "bold", cursor: "pointer" }}
              >
                🏃 Log Run
              </button>
            </>
          )}
        </div>

        {/* TIME SYNC ROW */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "12px", borderTop: "1px dashed #ccc", paddingTop: "12px" }}>
          <div style={{ flexGrow: 1 }}>
            <label style={{ fontSize: "9px", display: "block", marginBottom: "2px" }}>Timestamp</label>
            <input 
              value={entryTime} 
              onChange={e => setEntryTime(e.target.value)} 
              style={{ width: "100%", padding: "4px", border: "1px solid #1a1a1a", fontFamily: "monospace", boxSizing: "border-box" }} 
            />
          </div>
          <button onClick={() => setEntryTime(nowHM())} style={{ padding: "5px 10px", marginTop: "13px", background: "#eee", border: "1px solid #1a1a1a", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>Sync</button>
        </div>
      </div>

      {/* COMPACT RUN LEDGER */}
      <div style={{ border: "2px solid #1a1a1a", padding: "12px", background: "#fff", marginBottom: "16px" }}>
        <span style={{ fontSize: "10px", fontWeight: "bold" }}>Ledger Log</span>
        <div style={{ maxHeight: "100px", overflowY: "auto", fontSize: "11px", marginTop: "6px" }}>
          {gameLog.length === 0 ? (
            <span style={{ color: "#999" }}>Ready for first entry...</span>
          ) : (
            [...gameLog].reverse().map((e, i) => (
              <div key={i} style={{ borderBottom: "1px dashed #eee", padding: "2px 0" }}>
                <span style={{ color: "#666" }}>[{e.ts}]</span> {e.msg}
              </div>
            ))
          )}
        </div>
      </div>

      {/* DASHBOARD ACTIONS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
        <button onClick={exportGameData} style={{ padding: "8px", background: "#eee", border: "1px solid #1a1a1a", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>
          💾 Save Scorecard
        </button>
        <button onClick={onNewGame} style={{ padding: "8px", background: "#fff", border: "1px solid #f85149", color: "#f85149", fontFamily: "monospace", fontSize: "11px", cursor: "pointer" }}>
          🔄 Reset Board
        </button>
      </div>

    </div>
  );
}

// ==========================================
// 4. MAIN APP CONTAINER
// ==========================================
const { useState } = React;

export default function App() {
  const [screen, setScreen] = useState("setup");
  const [config, setConfig] = useState(null);
  const [initState, setInitState] = useState(null);
  const [key, setKey] = useState(0);

  const handleStart = cfg => { 
    setConfig(cfg); 
    setInitState(null); 
    setKey(k => k + 1); 
    setScreen("game"); 
  };

  const handleImport = data => {
    setConfig(data.config);
    setInitState({ 
      events: data.events, 
      score: data.score, 
      runsLog: data.runsLog, 
      gameLog: data.gameLog 
    });
    setKey(k => k + 1);
    setScreen("game");
  };

  if (screen === "game" && config) {
    return (
      <GameTracker 
        key={key} 
        config={config} 
        onNewGame={() => { if(confirm("Discard current game?")) setScreen("setup"); }} 
        initialState={initState} 
      />
    );
  }
  return <SetupScreen onStart={handleStart} onImport={handleImport} />;
}