/* eslint-disable no-unused-vars */
// src/components/RealtimeTranslator.jsx
// Soft glass UI (transparent), fully responsive, animated top bar & Connect button,
// mobile hamburger drawer, Push-To-Talk per party, real-time transcripts.

import React, { useEffect, useRef, useState } from "react";
import AudioWave from "./AudioWave";
import "../styles/RealtimeTranslator.css";

const SIGNAL_URL = "https://ai-receptionist-webrtc-server.onrender.com/api/rtc-connect";

// Public-folder logo path (place your file in /public)
// Example names: /hospital-logo.svg, /hospital-logo.png, etc.
const LOGO_PATH = "/logo.png";

const LANG_OPTS = [
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "de", label: "German" },
  { code: "zh", label: "Chinese (Mandarin)" },
  { code: "fr", label: "French" },
  { code: "hi", label: "Hindi" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "it", label: "Italian" },
  { code: "ur", label: "Urdu" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pt", label: "Portuguese" },
    { code: "tr", label: "Turkish" },
    { code: "pl", label: "Polish" },
    { code: "nl", label: "Dutch" },
    { code: "sv", label: "Swedish" },
    { code: "fi", label: "Finnish" },
    { code: "da", label: "Danish" },
    { code: "no", label: "Norwegian" },
    { code: "cs", label: "Czech" },
    { code: "sk", label: "Slovak" },
    { code: "hu", label: "Hungarian" },
    { code: "ro", label: "Romanian" },  
    { code: "bg", label: "Bulgarian" },
    { code: "el", label: "Greek" },
    


];
const labelOf = (c) => LANG_OPTS.find((x) => x.code === c)?.label || c;

export default function RealtimeTranslator() {
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [menuOpen, setMenuOpen] = useState(false); // mobile drawer

  // Theme
  const [theme, setTheme] = useState(() =>
    typeof window === "undefined"
      ? "dark"
      : localStorage.getItem("rt-theme") || "dark"
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("rt-theme", theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  // Languages
  const [patientLang, setPatientLang] = useState("de");
  const [receptionistLang, setReceptionistLang] = useState("ar");

  // PTT
  const [pttRole, setPttRole] = useState(null); // 'patient' | 'receptionist' | null
  const pendingRoleRef = useRef(null);

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Assistant audio for wave
  const [remoteStream, setRemoteStream] = useState(null);

  // Transcripts
  const [englishTranscript, setEnglishTranscript] = useState("");
  const [liveUserLine, setLiveUserLine] = useState("");
  const [liveAssistLine, setLiveAssistLine] = useState("");
  const transcriptRef = useRef(null);

  // Tagged translations + summary
  const [toPatientText, setToPatientText] = useState("");
  const [toReceptionistText, setToReceptionistText] = useState("");
  const [summaryText, setSummaryText] = useState("");

  // Patient details (optional from [[SUMMARY]])
  const [patientName, setPatientName] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [fileNumber, setFileNumber] = useState("");

  const mergeDetailsFromSummary = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.name && !patientName) setPatientName(obj.name);
    if (obj.age && !patientAge) setPatientAge(String(obj.age));
    if (obj.file_number && !fileNumber) setFileNumber(String(obj.file_number));
  };

  // Auto-scroll transcript
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [englishTranscript, liveUserLine, liveAssistLine]);

  // Instructions
  function buildInstructions(recLang, patLang) {
    const recL = labelOf(recLang),
      patL = labelOf(patLang);
    return `
ROLE: Real-time two-party hospital interpreter.

PARTIES:
- Receptionist: speaks ${recL} (${recLang})
- Patient: speaks ${patL} (${patLang})

OBJECTIVE:
- Mediate turn-by-turn without overlap.
- Translate ONLY what was spoken; no added meaning or advice.
- Be concise, polite, and neutral.

ANTI-HALLUCINATION:
- Do not speak until detecting a completed utterance via VAD.
- Never start on your own.

TURN LOGIC:
- If CURRENT_SPEAKER is Patient → [[TO_RECEPTIONIST]] <${recL}>
- If CURRENT_SPEAKER is Receptionist → [[TO_PATIENT]] <${patL}>

STRICT OUTPUT:
- Newline-delimited frames; only [[TO_PATIENT]], [[TO_RECEPTIONIST]], [[SUMMARY]] tags.
`.trim();
  }
  const speakerHint = (role) =>
    role === "patient"
      ? `\nCURRENT_SPEAKER: Patient\n- Translate to the Receptionist.\n`
      : role === "receptionist"
      ? `\nCURRENT_SPEAKER: Receptionist\n- Translate to the Patient.\n`
      : `\nCURRENT_SPEAKER: None\n- Remain silent until a PTT is active.\n`;

  useEffect(() => {
    return () => {
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
        pcRef.current?.close();
        dcRef.current?.close();
      } catch {}
      pcRef.current = null;
      dcRef.current = null;
      localStreamRef.current = null;
      setStatus("idle");
      setPttRole(null);
      setRemoteStream(null);
    };
  }, []);

  async function ensureLocalStream() {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // Start muted; unmute only during PTT
    stream.getAudioTracks().forEach((t) => (t.enabled = false));
    localStreamRef.current = stream;
    return stream;
  }

  async function startSession() {
    if (pcRef.current || status === "connecting") return;
    setStatus("connecting");

    try {
      const stream = await ensureLocalStream();

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });
      pcRef.current = pc;

      pc.addTransceiver("audio", { direction: "sendrecv" });
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (e) => {
        const rs = e.streams?.[0];
        if (!rs) return;
        setRemoteStream(rs);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = rs;
          remoteAudioRef.current.play().catch(() => {});
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "failed" || st === "disconnected" || st === "closed") {
          setStatus("error");
          setPttRole(null);
          localStreamRef.current
            ?.getAudioTracks()
            .forEach((t) => (t.enabled = false));
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          pc.close();
          setStatus("error");
          setPttRole(null);
          localStreamRef.current
            ?.getAudioTracks()
            .forEach((t) => (t.enabled = false));
        }
      };

      const dc = pc.createDataChannel("response", { ordered: true });
      dcRef.current = dc;

      let assistBuffer = "";
      const liveByItem = new Map(); // item_id -> partial user transcript

      dc.onopen = () => {
        setStatus("connected");

        const initialRole = pendingRoleRef.current ?? null;
        const instructions =
          buildInstructions(receptionistLang, patientLang) +
          speakerHint(initialRole);

        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions,
              turn_detection: {
                type: "server_vad",
                threshold: 0.7,
                prefix_padding_ms: 250,
                silence_duration_ms: 700,
              },
              input_audio_transcription: {
                model: "gpt-4o-mini-transcribe",
                language:
                  initialRole === "patient" ? patientLang : receptionistLang,
              },
            },
          })
        );

        if (initialRole) beginPTT(initialRole);
        pendingRoleRef.current = null;
      };

      dc.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          const t = msg?.type;

          if (
            t === "conversation.item.input_audio_transcription.delta" &&
            typeof msg.delta === "string"
          ) {
            const id = msg.item_id || "live";
            const cur = (liveByItem.get(id) || "") + msg.delta;
            liveByItem.set(id, cur);
            setLiveUserLine(cur);
            return;
          }
          if (
            t === "conversation.item.input_audio_transcription.completed" &&
            typeof msg.transcript === "string"
          ) {
            const id = msg.item_id || "live";
            const full = msg.transcript.trim();
            liveByItem.delete(id);
            setLiveUserLine("");
            if (full)
              setEnglishTranscript((prev) =>
                prev ? prev + "\n" + full : full
              );
            return;
          }

          if (t === "response.text.delta" && typeof msg.delta === "string") {
            assistBuffer += msg.delta;

            let nl;
            while ((nl = assistBuffer.indexOf("\n")) >= 0) {
              const line = assistBuffer.slice(0, nl).trim();
              assistBuffer = assistBuffer.slice(nl + 1);

              if (!line) continue;

              if (line.startsWith("[[TO_PATIENT]]")) {
                const content = line.slice("[[TO_PATIENT]]".length).trim();
                if (content)
                  setToPatientText((prev) =>
                    prev ? prev + "\n" + content : content
                  );
                continue;
              }
              if (line.startsWith("[[TO_RECEPTIONIST]]")) {
                const content = line.slice("[[TO_RECEPTIONIST]]".length).trim();
                if (content)
                  setToReceptionistText((prev) =>
                    prev ? prev + "\n" + content : content
                  );
                continue;
              }
              if (line.startsWith("[[SUMMARY]]")) {
                const jsonPart = line.slice("[[SUMMARY]]".length).trim();
                try {
                  const obj = JSON.parse(jsonPart);
                  const parts = [];
                  if (obj.reason_for_visit)
                    parts.push(`Reason: ${obj.reason_for_visit}`);
                  if (obj.department) parts.push(`Dept: ${obj.department}`);
                  if (obj.urgency) parts.push(`Urgency: ${obj.urgency}`);
                  if (obj.notes) parts.push(`Notes: ${obj.notes}`);
                  setSummaryText(parts.join(" • "));
                  mergeDetailsFromSummary(obj);
                } catch {}
                continue;
              }

              setEnglishTranscript((prev) =>
                prev ? prev + "\n" + line : line
              );
              setLiveAssistLine("");
            }

            setLiveAssistLine(assistBuffer.trim());
            return;
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      dc.onclose = () => {
        setStatus("idle");
        setPttRole(null);
        setLiveUserLine("");
        setLiveAssistLine("");
      };
      dc.onerror = () => {
        setStatus("error");
        setPttRole(null);
        setLiveUserLine("");
        setLiveAssistLine("");
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp || offer.sdp;

      const qs = new URLSearchParams({
        recLang: receptionistLang,
        patLang: patientLang,
      }).toString();
      const res = await fetch(`${SIGNAL_URL}?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: sdp,
      });
      if (!res.ok) throw new Error(`Signaling failed: ${res.status}`);
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      console.error("RTC setup failed", err);
      setStatus("error");
      setPttRole(null);
      localStreamRef.current
        ?.getAudioTracks()
        .forEach((t) => (t.enabled = false));
    }
  }

  // ---- PTT helpers ----
  function setTrackEnabled(on) {
    (localStreamRef.current?.getAudioTracks?.() || []).forEach(
      (t) => (t.enabled = !!on)
    );
  }
  function sendSpeakerHint(role) {
    if (!dcRef.current || dcRef.current.readyState !== "open") return;
    const instr =
      buildInstructions(receptionistLang, patientLang) + speakerHint(role);
    const lang =
      role === "patient"
        ? patientLang
        : role === "receptionist"
        ? receptionistLang
        : receptionistLang;

    dcRef.current.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: instr,
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            prefix_padding_ms: 250,
            silence_duration_ms: 700,
          },
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
            language: lang,
          },
        },
      })
    );
  }
  function beginPTT(role) {
    setPttRole(role);
    sendSpeakerHint(role);
    setTrackEnabled(true);
  }
  function endPTT(role) {
    if (pttRole !== role) return;
    setPttRole(null);
    setTrackEnabled(false);
    sendSpeakerHint(null);
  }

  async function handlePTTDown(role) {
    if (status !== "connected") {
      pendingRoleRef.current = role;
      await startSession();
      setMenuOpen(false);
      return;
    }
    beginPTT(role);
  }
  function handlePTTUp(role) {
    endPTT(role);
  }

  // Sync instructions when languages change mid-call
  useEffect(() => {
    if (status === "connected" && dcRef.current?.readyState === "open")
      sendSpeakerHint(pttRole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientLang, receptionistLang]);

  return (
    <div className="rt-page">
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        style={{ display: "none" }}
      />

      {/* Top Bar */}
      <div className="rt-topbar">
        <div className="rt-topbar-inner">
          {/* Brand with public-folder logo */}
          <div className="rt-brand">
            <img
              className="rt-logo"
              src={LOGO_PATH}
              alt="Hospital logo"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span>AI Receptionist</span>
          </div>

          {/* Desktop actions */}
          <div className="rt-actions">
            <div className="rt-actions-inline">
              <div className="rt-lang-pickers">
                <label>
                  Patient
                  <select
                    aria-label="Patient language"
                    value={patientLang}
                    onChange={(e) => setPatientLang(e.target.value)}
                    className="glass-select"
                  >
                    {LANG_OPTS.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="rt-xsep">↔</span>
                <label>
                  Receptionist
                  <select
                    aria-label="Receptionist language"
                    value={receptionistLang}
                    onChange={(e) => setReceptionistLang(e.target.value)}
                    className="glass-select"
                  >
                    {LANG_OPTS.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <button
                className={`rt-button rt-connect ${status}`}
                title={status === "connected" ? "Connected" : "Connect"}
                onClick={() => {
                  if (status !== "connecting") startSession();
                }}
                disabled={status === "connecting"}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                  <path
                    d="M3 12h6M15 12h6M9 12a3 3 0 0 1 6 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span>
                  {status === "connected"
                    ? "Connected"
                    : status === "connecting"
                    ? "Connecting…"
                    : "Connect"}
                </span>
              </button>

              <button
                className="rt-button rt-toggle"
                title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                onClick={toggleTheme}
              >
                {theme === "light" ? "☾ Dark" : "☀︎ Light"}
              </button>
            </div>

            {/* Hamburger (visible on mobile) */}
            <button
              className={`rt-hamburger ${menuOpen ? "open" : ""}`}
              aria-label="Menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        {/* Mobile drawer – mirrors all settings */}
        <div className={`rt-drawer ${menuOpen ? "open" : ""}`}>
          <div className="rt-drawer-inner">
            <div className="rt-drawer-row">
              <label>
                Patient
                <select
                  aria-label="Patient language"
                  value={patientLang}
                  onChange={(e) => setPatientLang(e.target.value)}
                  className="glass-select"
                >
                  {LANG_OPTS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Receptionist
                <select
                  aria-label="Receptionist language"
                  value={receptionistLang}
                  onChange={(e) => setReceptionistLang(e.target.value)}
                  className="glass-select"
                >
                  {LANG_OPTS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button
              className={`rt-button rt-connect mobile-large ${status}`}
              onClick={() => {
                if (status !== "connecting") startSession();
                setMenuOpen(false);
              }}
              disabled={status === "connecting"}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  d="M3 12h6M15 12h6M9 12a3 3 0 0 1 6 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <span style={{ marginLeft: 6 }}>
                {status === "connected" ? "Connected" : "Connecting…"}
              </span>
            </button>

            <button
              className="rt-button rt-toggle mobile-large"
              onClick={() => {
                toggleTheme();
                setMenuOpen(false);
              }}
            >
              {theme === "light" ? "☾ Dark" : "☀︎ Light"}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div
            className="rt-drawer-backdrop"
            onClick={() => setMenuOpen(false)}
          />
        )}
      </div>

      {/* Audio Wave */}
      <div className="rt-wavebar">
        <div className="rt-wavebar-inner">
          <div className="voice-stage-wave">
            <AudioWave stream={remoteStream} audioUrl={null} />
          </div>
        </div>
      </div>

      {/* Main */}
      <main className="rt-main">
        <div className="rt-container">
          <section className="rt-card animate-card">
            <div className="rt-card-section">
              <h3 className="rt-title">English transcript (log)</h3>
              <div className="rt-box rt-transcript" ref={transcriptRef}>
                {englishTranscript ? englishTranscript + "\n" : ""}
                {liveUserLine && (
                  <span>
                    {liveUserLine}
                    <span className="rt-live-line" aria-hidden />
                  </span>
                )}
                {!liveUserLine && liveAssistLine && (
                  <span>
                    {liveAssistLine}
                    <span className="rt-live-line" aria-hidden />
                  </span>
                )}
                {!englishTranscript && !liveUserLine && !liveAssistLine && (
                  <span className="rt-placeholder">Waiting…</span>
                )}
              </div>
            </div>

            <div className="rt-card-section">
              <h3 className="rt-title">Translation → Patient</h3>
              <div className="rt-box rt-summary">
                {toPatientText || (
                  <span className="rt-placeholder">Will appear here…</span>
                )}
              </div>
            </div>

            <div className="rt-card-section">
              <h3 className="rt-title">Translation → Receptionist</h3>
              <div className="rt-box rt-summary">
                {toReceptionistText || (
                  <span className="rt-placeholder">Will appear here…</span>
                )}
              </div>
            </div>

            <div className="rt-card-section">
              <h3 className="rt-title">Patient details (from summary)</h3>
              <div className="rt-details-row">
                <label className="rt-field rt-input">
                  <span>Name</span>
                  <input
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="Name"
                  />
                </label>
                <label className="rt-field rt-input">
                  <span>Age</span>
                  <input
                    value={patientAge}
                    onChange={(e) => setPatientAge(e.target.value)}
                    placeholder="Age"
                    inputMode="numeric"
                  />
                </label>
                <label className="rt-field rt-input">
                  <span>File Number</span>
                  <input
                    value={fileNumber}
                    onChange={(e) => setFileNumber(e.target.value)}
                    placeholder="File No."
                  />
                </label>
              </div>
              {summaryText && (
                <div className="rt-box rt-summary" style={{ marginTop: 8 }}>
                  {summaryText}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* PTT Controls */}
      <div className="rt-ptt-wrap">
        <div className="rt-ptt-grid">
          {/* PATIENT */}
          <button
            className={`rt-fab rt-fab--patient ${
              pttRole === "patient" ? "on" : "off"
            } ${status}`}
            title="Hold to speak (Patient)"
            onMouseDown={() => handlePTTDown("patient")}
            onMouseUp={() => handlePTTUp("patient")}
            onMouseLeave={() => handlePTTUp("patient")}
            onTouchStart={(e) => {
              e.preventDefault();
              handlePTTDown("patient");
            }}
            onTouchEnd={() => handlePTTUp("patient")}
            disabled={status === "connecting" || status === "error"}
            aria-pressed={pttRole === "patient"}
          >
            <svg viewBox="0 0 24 24" role="img" aria-label="Patient mic">
              <path
                className="mic-shape"
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2Z"
              />
            </svg>
            <span className="rt-fab-ring" aria-hidden />
          </button>

          {/* RECEPTIONIST */}
          <button
            className={`rt-fab rt-fab--receptionist ${
              pttRole === "receptionist" ? "on" : "off"
            } ${status}`}
            title="Hold to speak (Receptionist)"
            onMouseDown={() => handlePTTDown("receptionist")}
            onMouseUp={() => handlePTTUp("receptionist")}
            onMouseLeave={() => handlePTTUp("receptionist")}
            onTouchStart={(e) => {
              e.preventDefault();
              handlePTTDown("receptionist");
            }}
            onTouchEnd={() => handlePTTUp("receptionist")}
            disabled={status === "connecting" || status === "error"}
            aria-pressed={pttRole === "receptionist"}
          >
            <svg viewBox="0 0 24 24" role="img" aria-label="Receptionist mic">
              <path
                className="mic-shape"
                d="M8 9a4 4 0 1 1 8 0v2a4 4 0 1 1-8 0V9Z"
              />
            </svg>
            <span className="rt-fab-ring" aria-hidden />
          </button>
        </div>

        <div className={`rt-fab-status ${status}`}>
          {status === "connecting" ? "Connecting…" : status}
          {pttRole
            ? ` • ${
                pttRole === "patient"
                  ? "Patient speaking"
                  : "Receptionist speaking"
              }`
            : ""}
        </div>
      </div>
    </div>
  );
}
