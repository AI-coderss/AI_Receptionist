/* eslint-disable no-unused-vars */
// src/components/RealtimeTranslator.jsx
// Soft glass UI, responsive, single "Listen" button (toggle), pure VAD turn-taking,
// bilingual auto-detect → translate to the opposite language, echo/duplicate suppression.

import React, { useEffect, useRef, useState } from "react";
import AudioWave from "./AudioWave";
import "../styles/RealtimeTranslator.css";
import ThemeSwitch from "./ThemeSwitch";

const SIGNAL_URL = "https://ai-receptionist-webrtc-server.onrender.com/api/rtc-connect";

// Public-folder logo path (place your file in /public)
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

// normalize a line to suppress near-duplicates
const norm = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .replace(/[.?!،۔]+$/u, "")
    .trim()
    .toLowerCase();

export default function RealtimeTranslator() {
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | error
  const [menuOpen, setMenuOpen] = useState(false);

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

  // Languages (two dropdowns)
  const [patientLang, setPatientLang] = useState("ar");
  const [receptionistLang, setReceptionistLang] = useState("en");

  // Single listen toggle (no push-to-talk)
  const [listening, setListening] = useState(false);

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

  // Duplicate/echo suppression (avoid repeating same line)
  const recentMapRef = useRef(new Map()); // normLine -> timestamp(ms)
  const RECENT_WINDOW_MS = 7000;

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

  // Instructions builder: auto-detect speaker language, translate to the OTHER one
  function buildInstructions(recLang, patLang) {
    const recL = labelOf(recLang),
      patL = labelOf(patLang);
    return `
ROLE: Real-time two-party hospital interpreter.

LANGUAGES:
- Language A: ${recL} (${recLang})
- Language B: ${patL} (${patLang})

OBJECTIVE:
- For each human utterance, DETECT which of the two languages it is in.
- Then translate ONLY into the OPPOSITE language:
  • If the utterance is in ${recL} → output [[TO_PATIENT]] <${patL} translation>
  • If the utterance is in ${patL} → output [[TO_RECEPTIONIST]] <${recL} translation>

TURNING & TIMING (VAD):
- Wait for a complete utterance (VAD end-of-speech) BEFORE replying.
- Never interrupt or speak during input; remain silent between turns.

STRICT OUTPUT:
- Newline-delimited frames.
- Allowed tags: [[TO_PATIENT]], [[TO_RECEPTIONIST]], [[SUMMARY]]
- Exactly ONE tagged translation per turn. No combined tags.
- Keep translations concise, faithful, and neutral. No added advice or content.

ECHO-LOOP AVOIDANCE:
- Do NOT re-translate your own synthetic speech or previous output.
- If the input matches your prior output (same content, opposite direction), ignore it.

OPTIONAL SUMMARY (only if explicitly stated by speakers):
- [[SUMMARY]] {"reason_for_visit":"...","department":"...","urgency":"...","file_number":"...","name":"...","age":0,"notes":"..."} — include only fields explicitly mentioned.

NO HALLUCINATIONS:
- Do not invent names, IDs, symptoms, or facts not spoken.
- If unclear, output nothing and wait for the next turn.
`.trim();
  }

  // Cleanup on unmount
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
      setRemoteStream(null);
    };
  }, []);

  function setTrackEnabled(on) {
    (localStreamRef.current?.getAudioTracks?.() || []).forEach(
      (t) => (t.enabled = !!on)
    );
  }

  async function ensureLocalStream() {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    // mic follows "listening" toggle
    stream.getAudioTracks().forEach((t) => (t.enabled = listening));
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
          setTrackEnabled(false);
          setListening(false);
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          pc.close();
          setStatus("error");
          setTrackEnabled(false);
          setListening(false);
        }
      };

      const dc = pc.createDataChannel("response", { ordered: true });
      dcRef.current = dc;

      // Live user transcripts keyed by item_id
      const liveByItem = new Map();
      let assistBuffer = "";

      dc.onopen = () => {
        setStatus("connected");

        // Initial session config (pure VAD; no language pinned → let STT auto-detect)
        const instructions = buildInstructions(receptionistLang, patientLang);

        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions,
              turn_detection: {
                type: "server_vad",
                threshold: 0.77,          // slightly stricter to avoid rushing
                prefix_padding_ms: 300,
                silence_duration_ms: 1000, // wait a bit longer before responding
              },
              input_audio_transcription: {
                model: "gpt-4o-mini-transcribe",
                // omit 'language' to allow bilingual auto-detection
              },
            },
          })
        );
      };

      dc.onmessage = (evt) => {
        // prune old duplicates window periodically
        const now = Date.now();
        const map = recentMapRef.current;
        for (const [k, ts] of map.entries()) {
          if (now - ts > RECENT_WINDOW_MS) map.delete(k);
        }

        // Handle events
        try {
          const msg = JSON.parse(evt.data);
          const t = msg?.type;

          // --- Live user transcription (partial) ---
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

          // --- User transcription completed ---
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

          // --- Assistant text stream ---
          if (t === "response.text.delta" && typeof msg.delta === "string") {
            assistBuffer += msg.delta;

            let nl;
            while ((nl = assistBuffer.indexOf("\n")) >= 0) {
              const line = assistBuffer.slice(0, nl).trim();
              assistBuffer = assistBuffer.slice(nl + 1);

              if (!line) continue;

              // Duplicate/echo suppression
              const nline = norm(line);
              if (nline && recentMapRef.current.has(nline)) {
                // Ignore duplicates seen very recently
                continue;
              }

              if (line.startsWith("[[TO_PATIENT]]")) {
                const content = line.slice("[[TO_PATIENT]]".length).trim();
                const nc = norm(content);
                if (nc) recentMapRef.current.set(nc, Date.now());
                if (content)
                  setToPatientText((prev) =>
                    prev ? prev + "\n" + content : content
                  );
                setLiveAssistLine("");
                continue;
              }

              if (line.startsWith("[[TO_RECEPTIONIST]]")) {
                const content = line
                  .slice("[[TO_RECEPTIONIST]]".length)
                  .trim();
                const nc = norm(content);
                if (nc) recentMapRef.current.set(nc, Date.now());
                if (content)
                  setToReceptionistText((prev) =>
                    prev ? prev + "\n" + content : content
                  );
                setLiveAssistLine("");
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
                setLiveAssistLine("");
                continue;
              }

              // Un-tagged log line
              const nlog = norm(line);
              if (nlog) recentMapRef.current.set(nlog, Date.now());
              setEnglishTranscript((prev) => (prev ? prev + "\n" + line : line));
              setLiveAssistLine("");
            }

            // show partials while waiting for newline
            setLiveAssistLine(assistBuffer.trim());
            return;
          }

          // --- A response was fully completed ---
          if (t === "response.completed") {
            setLiveAssistLine("");
            return;
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      dc.onclose = () => {
        setStatus("idle");
        setLiveUserLine("");
        setLiveAssistLine("");
        setListening(false);
        setTrackEnabled(false);
      };
      dc.onerror = () => {
        setStatus("error");
        setLiveUserLine("");
        setLiveAssistLine("");
        setListening(false);
        setTrackEnabled(false);
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
      setListening(false);
      setTrackEnabled(false);
    }
  }

  // Listen toggle
  async function toggleListening() {
    if (status !== "connected") {
      await startSession();
      // after connected, flip to listening on next tick
      setTimeout(() => {
        setListening(true);
        setTrackEnabled(true);
      }, 0);
      return;
    }
    setListening((prev) => {
      const next = !prev;
      setTrackEnabled(next);
      return next;
    });
  }

  // Sync instructions if languages change mid-call
  useEffect(() => {
    if (status === "connected" && dcRef.current?.readyState === "open") {
      const instructions = buildInstructions(receptionistLang, patientLang);
      dcRef.current.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions,
            turn_detection: {
              type: "server_vad",
              threshold: 0.77,
              prefix_padding_ms: 300,
              silence_duration_ms: 1000,
            },
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe",
              // keep language unspecified for auto-detect
            },
          },
        })
      );
    }
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
          {/* Brand */}
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

              <ThemeSwitch
                checked={theme === "dark"}
                onChange={toggleTheme}
                size="md"
                ariaLabel="Toggle theme"
              />
            </div>

            {/* Hamburger (mobile) */}
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

        {/* Mobile drawer */}
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

            <ThemeSwitch
              checked={theme === "dark"}
              onChange={toggleTheme}
              ariaLabel="Toggle theme"
            />
          </div>
        </div>
        {menuOpen && (
          <div
            className="rt-drawer-backdrop"
            onClick={() => setMenuOpen(false)}
          />
        )}
      </div>

      {/* Audio Wave (assistant output) */}
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
          </section>
        </div>
      </main>

      {/* Single Listen FAB */}
      <div className="rt-ptt-wrap">
        <div className="rt-ptt-grid">
          <button
            className={`rt-fab rt-fab--main ${
              listening ? "on" : "off"
            } ${status}`}
            title={listening ? "Listening (VAD on)" : "Click to start listening"}
            onClick={toggleListening}
            disabled={status === "connecting" || status === "error"}
            aria-pressed={listening}
          >
            <svg viewBox="0 0 24 24" role="img" aria-label="Mic">
              <path
                className="mic-shape"
                d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2Z"
              />
            </svg>
            <span className="rt-fab-ring" aria-hidden />
          </button>
        </div>

        <div className={`rt-fab-status ${status}`}>
          {status === "connecting" ? "Connecting…" : status}
          {status === "connected" ? (listening ? " • listening" : " • paused") : ""}
        </div>
      </div>
    </div>
  );
}
