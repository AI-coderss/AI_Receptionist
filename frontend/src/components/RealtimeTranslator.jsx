/* eslint-disable no-unused-vars */
// src/components/RealtimeTranslator.jsx
// Clean, responsive UI with:
// - Cards above the (smaller-footprint) orb
// - Bright-green FAB pulse when active & smaller mic icon
// - Dark theme cyan particles + light theme transparent canvas
// - Mobile-only drawer for options; desktop inline pickers
// - Transcripts render WITHOUT [[TO_*]] tags

import React, { useEffect, useRef, useState } from "react";
import "../styles/RealtimeTranslator.css";

import ThemeSwitch from "./ThemeSwitch"; // your themed switch (imports ../styles/ThemeSwitch.css)
import BaseOrb from "./BaseOrb";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

const SIGNAL_URL =
  "https://ai-receptionist-webrtc-server.onrender.com/api/rtc-connect";

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

// Strip tags like [[TO_PATIENT]], [[TO_RECEPTIONIST]], [[SUMMARY]]
const TAG_TOKEN_RE = /\s*\[\[(?:TO_PATIENT|TO_RECEPTIONIST|SUMMARY)\]\]\s*/g;
const stripRealtimeTags = (s) => (s || "").replace(TAG_TOKEN_RE, "").trim();

// normalize to suppress near-duplicates
const norm = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .replace(/[.?!،۔]+$/u, "")
    .trim()
    .toLowerCase();

// quick language guess for fallback routing
function guessLangCode(s) {
  if (!s) return null;
  if (/[\u4E00-\u9FFF]/.test(s)) return "zh";
  if (/[\u0600-\u06FF]/.test(s)) return "ar";
  if (/[\u0400-\u04FF]/.test(s)) return "ru";
  return "latn";
}

function Hamburger({ open, onToggle }) {
  return (
    <button
      className={`hamburger ${open ? "open" : ""}`}
      aria-label="Menu"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span />
      <span />
      <span />
    </button>
  );
}

export default function RealtimeTranslator() {
  // Theme (drives [data-theme])
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem("rt2-theme") || "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("rt2-theme", theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  // Mobile drawer
  const [menuOpen, setMenuOpen] = useState(false);

  // Connection/UI state
  const [status, setStatus] = useState("disconnected"); // disconnected | connecting | connected | error
  const [patientLang, setPatientLang] = useState("ar");
  const [receptionistLang, setReceptionistLang] = useState("en");
  const [listening, setListening] = useState(false);

  // WebRTC refs
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Streams
  const [remoteStream, setRemoteStream] = useState(null);

  // Transcripts
  const [leftTranscript, setLeftTranscript] = useState("");  // → Receptionist
  const [rightTranscript, setRightTranscript] = useState(""); // → Patient
  const [liveUserLine, setLiveUserLine] = useState("");
  const [liveAssistLine, setLiveAssistLine] = useState("");

  // duplicate suppression
  const recentMapRef = useRef(new Map());
  const RECENT_WINDOW_MS = 7000;

  // response buffers (to tie text tag to spoken transcript)
  const responseMapRef = useRef(new Map()); // id -> { textBuf, audioBuf, target }

  // ORB store (assistant audio levels)
  const setAudioScale = useAudioForVisualizerStore((s) => s.setAudioScale);
  const setVisualizerReady = useAudioForVisualizerStore(
    (s) => s.setVisualizerReady
  );

  // attach remote stream to hidden audio + ORB monitor
  useEffect(() => {
    if (!remoteStream) return;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current
        .play()
        .then(() => {
          try {
            startVolumeMonitoring(remoteStream, setAudioScale);
            setVisualizerReady(true);
          } catch {}
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStream]);

  // Cleanup
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
      setRemoteStream(null);
      setStatus("disconnected");
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
    stream.getAudioTracks().forEach((t) => (t.enabled = listening));
    localStreamRef.current = stream;
    return stream;
  }

  function buildInstructions(recLang, patLang) {
    const recL = labelOf(recLang),
      patL = labelOf(patLang);
    return `
ROLE: Real-time two-party hospital interpreter.

LANGUAGES:
- Language A: ${recL} (${recLang})
- Language B: ${patL} (${patLang})

OBJECTIVE:
- Detect which of the two languages each human utterance is in.
- Translate ONLY into the opposite language:
  • If utterance is in ${recL} → output [[TO_PATIENT]] <${patL} translation>
  • If utterance is in ${patL} → output [[TO_RECEPTIONIST]] <${recL} translation>

TURNING (VAD):
- Wait for end-of-speech before replying. Remain silent between turns.

STRICT OUTPUT CHANNELS:
- Always send ONE newline-delimited tag on the TEXT channel: [[TO_PATIENT]] or [[TO_RECEPTIONIST]].
- Do NOT speak the tags; audio must contain only the translation.

NO ECHO:
- Do not re-translate your own synthetic speech.
`.trim();
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
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "failed" || st === "disconnected" || st === "closed") {
          setStatus("error");
          setTrackEnabled(false);
          setListening(false);
        }
      };

      const dc = pc.createDataChannel("response", { ordered: true });
      dcRef.current = dc;

      // live mic transcript chunks per item
      const liveByItem = new Map();

      dc.onopen = () => {
        setStatus("connected");
        const instructions = buildInstructions(receptionistLang, patientLang);
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions,
              turn_detection: {
                type: "server_vad",
                threshold: 0.77,
                prefix_padding_ms: 300,
                silence_duration_ms: 1000,
              },
              input_audio_transcription: {
                model: "gpt-4o-mini-transcribe",
              },
            },
          })
        );
      };

      const ensureResp = (id) => {
        const key = id || "default";
        const m = responseMapRef.current;
        if (!m.has(key))
          m.set(key, { textBuf: "", audioBuf: "", target: null });
        return m.get(key);
      };

      dc.onmessage = (evt) => {
        // prune duplicate window
        const now = Date.now();
        const dup = recentMapRef.current;
        for (const [k, ts] of dup.entries()) {
          if (now - ts > RECENT_WINDOW_MS) dup.delete(k);
        }

        try {
          const msg = JSON.parse(evt.data);
          const t = msg?.type;

          // mic STT delta
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

          // mic STT completed
          if (
            t === "conversation.item.input_audio_transcription.completed" &&
            typeof msg.transcript === "string"
          ) {
            liveByItem.delete(msg.item_id || "live");
            setLiveUserLine("");
            return;
          }

          // assistant text tag (stream)
          if (
            (t === "response.text.delta" || t === "response.output_text.delta") &&
            typeof msg.delta === "string"
          ) {
            const r = ensureResp(msg.response_id);
            r.textBuf += msg.delta;

            let nl;
            while ((nl = r.textBuf.indexOf("\n")) >= 0) {
              const line = r.textBuf.slice(0, nl).trim();
              r.textBuf = r.textBuf.slice(nl + 1);
              if (!line) continue;

              const nline = norm(line);
              if (nline && recentMapRef.current.has(nline)) continue;

              if (line.startsWith("[[TO_PATIENT]]")) {
                r.target = "PATIENT";
                const content = stripRealtimeTags(
                  line.slice("[[TO_PATIENT]]".length)
                );
                if (content)
                  setRightTranscript((prev) =>
                    prev ? `${prev}\n${content}` : content
                  );
                setLiveAssistLine("");
                continue;
              }
              if (line.startsWith("[[TO_RECEPTIONIST]]")) {
                r.target = "RECEPTIONIST";
                const content = stripRealtimeTags(
                  line.slice("[[TO_RECEPTIONIST]]".length)
                );
                if (content)
                  setLeftTranscript((prev) =>
                    prev ? `${prev}\n${content}` : content
                  );
                setLiveAssistLine("");
                continue;
              }
            }

            setLiveAssistLine(stripRealtimeTags(r.textBuf).trim());
            return;
          }

          // assistant spoken transcript (what the voice says)
          if (t === "response.audio_transcript.delta" && typeof msg.delta === "string") {
            const r = ensureResp(msg.response_id);
            r.audioBuf += msg.delta;
            setLiveAssistLine(stripRealtimeTags(r.audioBuf).trim());
            return;
          }

          if (t === "response.audio_transcript.done") {
            const r = ensureResp(msg.response_id);
            const spoken = stripRealtimeTags(r.audioBuf || "").trim();
            setLiveAssistLine("");

            if (spoken) {
              if (r.target === "PATIENT") {
                setRightTranscript((prev) =>
                  prev ? `${prev}\n${spoken}` : spoken
                );
              } else if (r.target === "RECEPTIONIST") {
                setLeftTranscript((prev) =>
                  prev ? `${prev}\n${spoken}` : spoken
                );
              } else {
                // fallback routing
                const g = guessLangCode(spoken);
                if (g === patientLang) {
                  setRightTranscript((prev) =>
                    prev ? `${prev}\n${spoken}` : spoken
                  );
                } else {
                  setLeftTranscript((prev) =>
                    prev ? `${prev}\n${spoken}` : spoken
                  );
                }
              }
            }
            if (msg.response_id) responseMapRef.current.delete(msg.response_id);
            return;
          }

          if (t === "response.done" || t === "response.completed") {
            setLiveAssistLine("");
            return;
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      dc.onclose = () => {
        setStatus("disconnected");
        setListening(false);
        setTrackEnabled(false);
        responseMapRef.current.clear();
      };
      dc.onerror = () => {
        setStatus("error");
        setListening(false);
        setTrackEnabled(false);
        responseMapRef.current.clear();
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

  // Mic toggle
  async function toggleMic() {
    if (status !== "connected") {
      await startSession();
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

  // Sync instructions when languages change mid-call
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
            },
          },
        })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientLang, receptionistLang]);

  // Live strings for cards, tags stripped
  const safeAssistLive = stripRealtimeTags(liveAssistLine);
  const safeUserLive = stripRealtimeTags(liveUserLine);

  const StatusPill = () => (
    <span
      className={`pill ${status}`}
      title={status === "connected" ? "Connected" : "Click mic to start"}
    >
      {status === "connected"
        ? "Connected"
        : status === "connecting"
        ? "Connecting…"
        : status === "error"
        ? "Error"
        : "Disconnected"}
    </span>
  );

  return (
    <div className="rt2-app">
      {/* hidden audio element for assistant voice */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="rt2-header">
        <div className="brand">
          <span className="logo" />
          <div>
            <div className="brand-title">Real-Time Translator</div>
            <div className="brand-sub">AI-powered hospital interpreter</div>
          </div>
        </div>

        {/* Desktop language pickers ONLY (mobile uses drawer) */}
        <div className="langbar" role="group" aria-label="Languages">
          <label className="lang">
            <span className="lang-role">Receptionist</span>
            <div className="lang-input">
              <span className="lang-code">{(receptionistLang || "en").toUpperCase()}</span>
              <select
                aria-label="Receptionist language"
                value={receptionistLang}
                onChange={(e) => setReceptionistLang(e.target.value)}
              >
                {LANG_OPTS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <span className="lang-swap" aria-hidden>↔</span>

          <label className="lang">
            <span className="lang-role">Patient</span>
            <div className="lang-input">
              <span className="lang-code">{(patientLang || "ar").toUpperCase()}</span>
              <select
                aria-label="Patient language"
                value={patientLang}
                onChange={(e) => setPatientLang(e.target.value)}
              >
                {LANG_OPTS.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </label>
        </div>

        <div className="hdr-right">
          {/* Hidden on mobile via CSS; shown in drawer on mobile */}
          <ThemeSwitch
            checked={theme === "dark"}
            onChange={toggleTheme}
            ariaLabel="Toggle theme"
          />
          <StatusPill />
          <Hamburger open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} />
        </div>

        {/* Mobile drawer */}
        <div className={`drawer ${menuOpen ? "open" : ""}`}>
          <div className="drawer-panel">
            <div className="drawer-h">
              <div className="drawer-title">Menu</div>
              <button className="drawer-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">✕</button>
            </div>

            <div className="drawer-section">
              <label className="drawer-row">
                <span>Receptionist</span>
                <select
                  aria-label="Receptionist language"
                  value={receptionistLang}
                  onChange={(e) => setReceptionistLang(e.target.value)}
                >
                  {LANG_OPTS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="drawer-row">
                <span>Patient</span>
                <select
                  aria-label="Patient language"
                  value={patientLang}
                  onChange={(e) => setPatientLang(e.target.value)}
                >
                  {LANG_OPTS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="drawer-row">
                <span>Theme</span>
                <ThemeSwitch
                  checked={theme === "dark"}
                  onChange={toggleTheme}
                  ariaLabel="Toggle theme"
                />
              </div>

              <div className="drawer-row">
                <span>Status</span>
                <StatusPill />
              </div>
            </div>

            <button
              className={`drawer-action ${status === "connected" ? "connected" : ""}`}
              onClick={toggleMic}
              disabled={status === "connecting" || status === "error"}
            >
              {status === "connected" ? (listening ? "Pause Mic" : "Resume Mic") : "Start"}
            </button>
          </div>
          <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="rt2-main">
        {/* Cards first (above the orb) */}
        <div className="cards raised">
          <section className="card" aria-live="polite">
            <div className="card-h">
              <div className="title">
                <span className="avatar" />
                Receptionist
              </div>
              <span className="chip">{labelOf(receptionistLang)}</span>
            </div>
            <div className="card-b">
              {leftTranscript || safeAssistLive || safeUserLive ? (
                <>
                  {leftTranscript}
                  {!leftTranscript && (safeAssistLive || safeUserLive) ? (
                    <span> {safeAssistLive || safeUserLive}</span>
                  ) : null}
                </>
              ) : (
                <span className="placeholder">No transcription yet. Press the mic button to start.</span>
              )}
            </div>
          </section>

          <section className="card" aria-live="polite">
            <div className="card-h">
              <div className="title">
                <span className="avatar" />
                Patient
              </div>
              <span className="chip">{labelOf(patientLang)}</span>
            </div>
            <div className="card-b">
              {rightTranscript || safeAssistLive || safeUserLive ? (
                <>
                  {rightTranscript}
                  {!rightTranscript && (safeAssistLive || safeUserLive) ? (
                    <span> {safeAssistLive || safeUserLive}</span>
                  ) : null}
                </>
              ) : (
                <span className="placeholder">No transcription yet. Press the mic button to start.</span>
              )}
            </div>
          </section>
        </div>

        {/* Orb below (shell size retained; inner canvas footprint smaller on mobile) */}
        <div className="orb-row">
          <div className="orb-shell small" aria-label="Audio visualizer">
            <BaseOrb />
          </div>
        </div>
      </main>

      {/* Bright-green Mic FAB (smaller icon, green pulse when active) */}
      <div className="fab-wrap">
        <button
          className={`fab ${listening ? "on" : ""}`}
          onClick={toggleMic}
          disabled={status === "connecting" || status === "error"}
          aria-pressed={listening}
          title={status === "connected" ? (listening ? "Pause mic" : "Resume mic") : "Start"}
        >
          <svg viewBox="0 0 24 24" role="img" aria-label="Mic" className="fab-icon">
            <path
              className="mic-shape"
              d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2Z"
              fill="currentColor"
            />
          </svg>
          <span className="rt-fab-ring" aria-hidden />
        </button>
      </div>
    </div>
  );
}
