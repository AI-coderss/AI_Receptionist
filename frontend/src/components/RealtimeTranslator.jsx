/* eslint-disable no-unused-vars */
// src/components/RealtimeTranslator.jsx
// Patient card LEFT • Receptionist card RIGHT
// Robust tag-locked routing; no heuristic guessing needed
// Longer VAD tail to avoid clipping; clears routing when languages change

import React, { useEffect, useRef, useState } from "react";
import "../styles/RealtimeTranslator.css";

import ThemeSwitch from "./ThemeSwitch"; // your provided component
import BaseOrb from "./BaseOrb";
import useAudioForVisualizerStore from "../store/useAudioForVisualizerStore";
import { startVolumeMonitoring } from "./audioLevelAnalyzer";

const SIGNAL_URL = "https://ai-receptionist-webrtc-server.onrender.com/api/rtc-connect";

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

// Tag helpers
const TAG_RX = /\[\[(TO_PATIENT|TO_RECEPTIONIST|SUMMARY)\]\]/;
const TAG_STRIP_RX = /\s*\[\[(?:TO_PATIENT|TO_RECEPTIONIST|SUMMARY)\]\]\s*/g;
const stripTags = (s) => (s || "").replace(TAG_STRIP_RX, "").trim();

// Normalize for dup suppression
const norm = (s) =>
  (s || "").replace(/\s+/g, " ").replace(/[.?!،۔]+$/u, "").trim().toLowerCase();

// Classic hamburger
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
  // Theme
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return localStorage.getItem("rt2-theme") || "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("rt2-theme", theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  // UI state
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState("disconnected"); // disconnected | connecting | connected | error
  const [patientLang, setPatientLang] = useState("ar");
  const [receptionistLang, setReceptionistLang] = useState("en");
  const [listening, setListening] = useState(false);

  // WebRTC
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const [remoteStream, setRemoteStream] = useState(null);

  // Transcripts
  const [leftTranscript, setLeftTranscript] = useState(""); // Patient (LEFT)
  const [rightTranscript, setRightTranscript] = useState(""); // Receptionist (RIGHT)

  // Live partials
  const [liveUserLine, setLiveUserLine] = useState("");
  const [liveAssistLine, setLiveAssistLine] = useState("");
  const [liveAssistTarget, setLiveAssistTarget] = useState(null); // 'PATIENT' | 'RECEPTIONIST' | null

  // Duplicate suppression
  const recentMapRef = useRef(new Map());
  const RECENT_WINDOW_MS = 7000;

  // Routing state per response
  const responseMapRef = useRef(new Map()); // id -> { textBuf, audioBuf, target }
  const lastSpeakerRef = useRef("UNKNOWN"); // 'PATIENT' | 'RECEPTIONIST' | 'UNKNOWN'

  // Visualizer
  const setAudioScale = useAudioForVisualizerStore((s) => s.setAudioScale);
  const setVisualizerReady = useAudioForVisualizerStore((s) => s.setVisualizerReady);

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
  }, [remoteStream, setAudioScale, setVisualizerReady]);

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
- Detect which language each human utterance is in.
- Translate ONLY into the opposite language:
  • If utterance is in ${recL} → output [[TO_PATIENT]] <${patL} translation>
  • If utterance is in ${patL} → output [[TO_RECEPTIONIST]] <${recL} translation>

TURNING (VAD):
- Wait for end-of-speech before replying. Remain silent between turns.

STRICT STREAM FORMAT (VERY IMPORTANT):
- On the TEXT channel, the FIRST token of each assistant turn MUST be exactly one of:
  [[TO_PATIENT]]    or    [[TO_RECEPTIONIST]]
- Follow the tag with a single space, then the translation text. End with a newline.
- Do NOT emit any untagged text before or after the tagged line.
- The AUDIO must contain only the translation itself (no tags spoken).

NO ECHO:
- Do not re-translate your own synthetic speech.
`.trim();
  }

  function resetRoutingBuffers() {
    // Clears partials and routing locks to avoid misplacement across a language change.
    responseMapRef.current.clear();
    lastSpeakerRef.current = "UNKNOWN";
    setLiveUserLine("");
    setLiveAssistLine("");
    setLiveAssistTarget(null);
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
              // Relaxed tail so the assistant speech doesn't get clipped
              turn_detection: {
                type: "server_vad",
                threshold: 0.65,
                prefix_padding_ms: 800,
                silence_duration_ms: 1700,
              },
              input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
            },
          })
        );
      };

      const ensureResp = (id) => {
        const key = id || "default";
        const m = responseMapRef.current;
        if (!m.has(key)) m.set(key, { textBuf: "", audioBuf: "", target: null });
        return m.get(key);
      };

      dc.onmessage = (evt) => {
        // prune duplicate window
        const now = Date.now();
        const dup = recentMapRef.current;
        for (const [k, ts] of dup.entries())
          if (now - ts > RECENT_WINDOW_MS) dup.delete(k);

        try {
          const msg = JSON.parse(evt.data);
          const t = msg?.type;

          // USER ASR live
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

          // USER ASR done → remember who spoke last (rough, only for final fallback)
          if (
            t === "conversation.item.input_audio_transcription.completed" &&
            typeof msg.transcript === "string"
          ) {
            setLiveUserLine("");
            lastSpeakerRef.current =
              lastSpeakerRef.current === "PATIENT"
                ? "RECEPTIONIST"
                : "PATIENT";
            return;
          }

          // ASSISTANT TEXT stream (authoritative router)
          if (
            (t === "response.text.delta" ||
              t === "response.output_text.delta") &&
            typeof msg.delta === "string"
          ) {
            const r = ensureResp(msg.response_id);
            r.textBuf += msg.delta;

            // If target not locked yet, try to find the first tag anywhere in buffer
            if (!r.target) {
              const m = r.textBuf.match(TAG_RX);
              if (m && m[1]) {
                r.target = m[1] === "TO_PATIENT" ? "PATIENT" : "RECEPTIONIST";
                setLiveAssistTarget(r.target);
              }
            }

            // Show live partial in the correct box only
            const partial = stripTags(r.textBuf).trim();
            setLiveAssistLine(partial);
            return;
          }

          // ASSISTANT audio transcript (what was spoken)
          if (
            t === "response.audio_transcript.delta" &&
            typeof msg.delta === "string"
          ) {
            const r = ensureResp(msg.response_id);
            r.audioBuf += msg.delta;
            if (r.target) setLiveAssistTarget(r.target);
            setLiveAssistLine(stripTags(r.audioBuf).trim());
            return;
          }

          // Commit spoken content when audio transcript ends
          if (t === "response.audio_transcript.done") {
            const r = ensureResp(msg.response_id);
            const spoken = stripTags(r.audioBuf || "").trim();
            if (spoken) {
              if (r.target === "PATIENT") {
                setLeftTranscript((prev) => (prev ? `${prev}\n${spoken}` : spoken));
              } else if (r.target === "RECEPTIONIST") {
                setRightTranscript((prev) => (prev ? `${prev}\n${spoken}` : spoken));
              } else {
                // Last-resort: opposite side of last speaker
                if (lastSpeakerRef.current === "PATIENT") {
                  setRightTranscript((p) => (p ? `${p}\n${spoken}` : spoken));
                } else {
                  setLeftTranscript((p) => (p ? `${p}\n${spoken}` : spoken));
                }
              }
            }
            setLiveAssistLine("");
            setLiveAssistTarget(null);
            if (msg.response_id) responseMapRef.current.delete(msg.response_id);
            return;
          }

          // If we get a turn-complete but no audio transcript, commit text buffer
          if (t === "response.completed" || t === "response.done") {
            const r = ensureResp(msg.response_id);
            const text = stripTags(r.textBuf || "").trim();
            if (text) {
              if (r.target === "PATIENT") {
                setLeftTranscript((prev) => (prev ? `${prev}\n${text}` : text));
              } else if (r.target === "RECEPTIONIST") {
                setRightTranscript((prev) => (prev ? `${prev}\n${text}` : text));
              } else {
                if (lastSpeakerRef.current === "PATIENT") {
                  setRightTranscript((p) => (p ? `${p}\n${text}` : text));
                } else {
                  setLeftTranscript((p) => (p ? `${p}\n${text}` : text));
                }
              }
            }
            setLiveAssistLine("");
            setLiveAssistTarget(null);
            if (msg.response_id) responseMapRef.current.delete(msg.response_id);
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
        setLiveAssistLine("");
        setLiveAssistTarget(null);
      };
      dc.onerror = () => {
        setStatus("error");
        setListening(false);
        setTrackEnabled(false);
        responseMapRef.current.clear();
        setLiveAssistLine("");
        setLiveAssistTarget(null);
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

  async function toggleMic() {
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

  // Update instructions & fully reset routing buffers if languages change
  useEffect(() => {
    if (status === "connected" && dcRef.current?.readyState === "open") {
      const instructions = buildInstructions(receptionistLang, patientLang);
      // HARD RESET routing so next turn can't end up on the wrong side
      resetRoutingBuffers();
      dcRef.current.send(
        JSON.stringify({
          type: "session.update",
          session: {
            instructions,
            turn_detection: {
              type: "server_vad",
              threshold: 0.65,
              prefix_padding_ms: 800,
              silence_duration_ms: 1700,
            },
            input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          },
        })
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientLang, receptionistLang]);

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

  // Live partials appear ONLY on the targeted side
  const patientLive = liveAssistTarget === "PATIENT" ? liveAssistLine : "";
  const receptionistLive =
    liveAssistTarget === "RECEPTIONIST" ? liveAssistLine : "";

  return (
    <div className="rt2-app">
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        style={{ display: "none" }}
      />

      <header className="rt2-header">
        <div className="brand">
          {/* NEW: SVG icon from /public/assets/translator.svg */}
          <img
            src="/assets/translator.svg"
            alt="Translator"
            className="brand-icon"
            draggable="false"
          />
          <div>
            {/* NEW: animated title class */}
            <div className="brand-title animate-title">Real-Time Translator</div>
            <div className="brand-sub">AI-powered hospital interpreter</div>
          </div>
        </div>

        {/* Desktop language pickers (mobile uses drawer) */}
        <div className="langbar" role="group" aria-label="Languages">
          <label className="lang">
            <span className="lang-role">Receptionist</span>
            <div className="lang-input">
              <span className="lang-code">
                {(receptionistLang || "en").toUpperCase()}
              </span>
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

          <span className="lang-swap" aria-hidden>
            ↔
          </span>

          <label className="lang">
            <span className="lang-role">Patient</span>
            <div className="lang-input">
              <span className="lang-code">
                {(patientLang || "ar").toUpperCase()}
              </span>
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
          <ThemeSwitch
            checked={theme === "dark"}
            onChange={toggleTheme}
            ariaLabel="Toggle theme"
          />
          <StatusPill />
          <Hamburger open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} />
        </div>

        {/* Drawer (mobile) */}
        <div className={`drawer ${menuOpen ? "open" : ""}`}>
          <div className="drawer-panel">
            <div className="drawer-h">
              <div className="drawer-title">Menu</div>
              <button
                className="drawer-close"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              >
                ✕
              </button>
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
              className={`drawer-action ${
                status === "connected" ? "connected" : ""
              }`}
              onClick={toggleMic}
              disabled={status === "connecting" || status === "error"}
            >
              {status === "connected"
                ? listening
                  ? "Pause Mic"
                  : "Resume Mic"
                : "Start"}
            </button>
          </div>
          <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} />
        </div>
      </header>

      <main className="rt2-main">
        <div className="orb-row">
          <div className="orb-shell compact" aria-label="Audio visualizer">
            <BaseOrb />
          </div>
        </div>

        {/* LEFT: Patient • RIGHT: Receptionist */}
        <div className="cards raised">
          <section className="card" aria-live="polite">
            <div className="card-h">
              <div className="title">
                <span className="avatar" />
                Patient
              </div>
              <span className="chip">{labelOf(patientLang)}</span>
            </div>
            <div className="card-b">
              {leftTranscript ? (
                leftTranscript
              ) : patientLive ? (
                <span>{patientLive}</span>
              ) : liveUserLine ? (
                <span>{liveUserLine}</span>
              ) : (
                <span className="placeholder">
                  No transcription yet. Press the mic button to start.
                </span>
              )}
            </div>
          </section>

          <section className="card" aria-live="polite">
            <div className="card-h">
              <div className="title">
                <span className="avatar" />
                Receptionist
              </div>
              <span className="chip">{labelOf(receptionistLang)}</span>
            </div>
            <div className="card-b">
              {rightTranscript ? (
                rightTranscript
              ) : receptionistLive ? (
                <span>{receptionistLive}</span>
              ) : liveUserLine ? (
                <span>{liveUserLine}</span>
              ) : (
                <span className="placeholder">
                  No transcription yet. Press the mic button to start.
                </span>
              )}
            </div>
          </section>
        </div>
      </main>

      <div className="fab-wrap">
        <button
          className={`fab ${listening ? "on" : ""}`}
          onClick={toggleMic}
          disabled={status === "connecting" || status === "error"}
          aria-pressed={listening}
          title={
            status === "connected"
              ? listening
                ? "Pause mic"
                : "Resume mic"
              : "Start"
          }
        >
          <svg
            viewBox="0 0 24 24"
            role="img"
            aria-label="Mic"
            className="fab-icon"
          >
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
