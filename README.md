

# AI Receptionist — Realtime, Two-Party Translator

A soft-glass, responsive web app that mediates conversations between a **receptionist** and a **patient** using the OpenAI **Realtime** API (WebRTC). It supports **Push-To-Talk** per party, real-time **English logs**, streaming **translations** to each side, and a sleek audio **frequency-bar visualizer**.

> **Quick links**
>
> * Frontend: `src/components/RealtimeTranslator.jsx`, `src/components/AudioWave.jsx`
> * Styles: `src/styles/RealtimeTranslator.css`, `src/styles/AudioWave.css`
> * Backend: `app.py` (signaling bridge), `system_prompt.txt` (optional)
> * Default signaling endpoint: `POST /api/rtc-connect`

---

## ✨ Features

* **Two-party interpreting** with strict routing:

  * **English transcript (log)** (always in English)
  * **Translation → Patient** (patient’s language)
  * **Translation → Receptionist** (receptionist’s language)
* **Push-To-Talk (PTT)** buttons — one per party (no cross-talk)
* **Realtime** streaming transcripts & assistant text (character-by-character)
* **Language pickers** for each party (desktop + mobile drawer)
* **Soft glass UI**, animated **Connect** button (states: idle/connecting/connected)
* **Audio visualizer** (frequency bars) sized to the main card width
* **Dark / Light** theme toggle
* **Responsive** layout (desktop → mobile)
* Optional **patient details** capture (from \[\[SUMMARY]] tags)
* Clean **anti-hallucination** guardrails (server VAD + strict output tags)

---

## 🧱 Architecture

```
Browser (React)
 ├─ RealtimeTranslator.jsx  ← WebRTC peer (RTCPeerConnection + DataChannel)
 ├─ AudioWave.jsx           ← Frequency bars visualizer (WebAudio + Canvas)
 ├─ RealtimeTranslator.css  ← Soft-glass UI + animations
 └─ AudioWave.css           ← Visualizer styles

Backend (Python/Flask or similar)
 └─ app.py                  ← /api/rtc-connect: accepts SDP offer, returns answer
    └─ Uses OpenAI Realtime API via WebRTC server-side session
    └─ Injects system prompt + session parameters (VAD, transcription language)
```

**Call flow (high level)**

1. Frontend creates a `RTCPeerConnection`, adds microphone track (muted until PTT).
2. Sends SDP **offer** to `POST /api/rtc-connect?recLang=XX&patLang=YY`.
3. Backend creates a Realtime session with OpenAI, sets **VAD** + **transcription language** (must be a supported code), returns SDP **answer**.
4. Once the **DataChannel** (`"response"`) opens, the app:

   * Streams **live user transcripts** into the **English log**
   * Parses **assistant delta text** into fields by tags:

     * `[[TO_PATIENT]] ...`
     * `[[TO_RECEPTIONIST]] ...`
     * `[[SUMMARY]] {json}`
5. PTT updates the session with a **speaker hint** and switches the **transcription language** accordingly.

---

## 📁 Directory & Files

```
.
├─ backend/
│  ├─ app.py                   # Flask (or similar) signaling endpoint
│  └─ system_prompt.txt        # Optional: long-form prompt text
├─ public/
│  └─ hospital-logo.svg        # Your logo (served as /hospital-logo.svg)
├─ src/
│  ├─ components/
│  │  ├─ RealtimeTranslator.jsx
│  │  └─ AudioWave.jsx
│  └─ styles/
│     ├─ RealtimeTranslator.css
│     └─ AudioWave.css
└─ README.md
```

---

## 🔧 Requirements

* **Node.js** 18+ for the frontend dev server
* **Python** 3.10+ for the backend (Flask or FastAPI will work)
* **OpenAI API key** with access to a **Realtime** model
* A browser with **WebRTC** & **getUserMedia** (Chrome, Edge, Safari, etc.)
* **HTTPS** in production (microphone access + WebRTC work best over HTTPS)
* A **STUN/TURN** server for NAT traversal in production (local STUN is fine for dev)

---

## 🛠️ Setup

### 1) Backend

Install deps and set environment:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt                      # Flask + any OpenAI client used
export OPENAI_API_KEY=your_key_here
export OPENAI_REALTIME_MODEL=gpt-4o-realtime        # or the current realtime model id
export TEMPERATURE=0.7                               # must be >= 0.6 (per API validation)
```

Run the server (example Flask):

```bash
python app.py
# Exposes: POST http://127.0.0.1:8813/api/rtc-connect?recLang=ar&patLang=de
```

**app.py responsibilities**

* Accept browser **SDP offer** (`Content-Type: application/sdp`)
* Create OpenAI Realtime session (WebRTC) with:

  * `turn_detection`: `server_vad` + thresholds
  * `input_audio_transcription.language`: **must be a supported code**
  * `temperature`: **≥ 0.6**
  * your **system prompt**
* Return the **SDP answer** text

> ✅ If you saw errors like
>
> * *“Invalid value: 'auto' … param: input\_audio\_transcription.language”* → set a real code (e.g., `ar`, `de`, `en`, …).
> * *“temperature below minimum value”* → ensure `TEMPERATURE >= 0.6`.

### 2) Frontend

```bash
# from project root
npm install
npm run dev
# Open http://localhost:5173 (or your dev server port)
```

Set the signaling URL if you host the backend elsewhere:

```js
// in RealtimeTranslator.jsx
const SIGNAL_URL = "http://127.0.0.1:8813/api/rtc-connect";
```

**Logo**: place your file at `public/hospital-logo.svg`.
The JSX references `/hospital-logo.svg`. Change that filename in code if needed.

---

## 🗣️ Languages

Use **two-letter** codes supported by the transcription model. Examples include:

```
af ar az be bg bs ca cs cy da de el en es et fa fi fr gl he hi hr hu hy
id is it ja kk kn ko lt lv mi mk mr ms ne nl no pl pt ro ru sk sl sr sv
sw ta th tl tr uk ur vi zh
```

You’ll pass them via querystring:

```
/api/rtc-connect?recLang=ar&patLang=de
```

The frontend also updates the active **speaker hint** and **transcription language** during PTT.

---

## 🧭 How It Works (Key Details)

* **PTT & VAD**
  PTT enables the local mic track only while pressed. The server’s **VAD** decides when to finalize an utterance. We send **speaker hints** (`Patient` or `Receptionist`) to route outputs.

* **Tag Parsing**
  Assistant text is streamed; we buffer and split by newline. Lines beginning with:

  * `[[TO_PATIENT]] …` → “Translation → Patient”
  * `[[TO_RECEPTIONIST]] …` → “Translation → Receptionist”
  * `[[SUMMARY]] {json}` → patient details & summary chip

* **English Transcript**
  Live partial user transcripts go into the **English log** (with a blinking caret); finalized transcriptions are appended.

* **UI/UX**

  * Soft, transparent glass design with subtle shadows
  * Animated **Connect** button (pulse on “connecting”)
  * **Hamburger drawer** on mobile mirrors all settings (language pickers, connect button, theme toggle)
  * **Visualizer** is a clean **bar graph** on a black strip, sized to the card width

---

## ⚙️ Configuration

Most behavior can be tuned in these places:

* **`RealtimeTranslator.jsx`**

  * `SIGNAL_URL`
  * `LANG_OPTS` (labels for dropdowns)
  * VAD thresholds (`prefix_padding_ms`, `silence_duration_ms`, `threshold`)
  * Build-time instructions (`buildInstructions()` + `speakerHint()`)

* **`app.py`**

  * Realtime model id
  * `temperature` (≥ 0.6)
  * `input_audio_transcription.language` (must be set; not `auto`)
  * System prompt (inline or loaded from `system_prompt.txt`)
  * CORS & HTTPS

* **Styling**

  * CSS tokens in `RealtimeTranslator.css` (`--container-max`, `--wave-h`, radii, shadows)
  * Dark/light via `data-theme` attribute

---

## 🚀 Production Notes

* **HTTPS**: Required on most browsers to access the microphone. Use a real certificate.
* **TURN server**: For users behind restrictive NATs/firewalls, add TURN (not just STUN).
* **CORS**: Allow your frontend origin to POST `/api/rtc-connect`.
* **Rate limits**: Throttle connect attempts; clean up RTCPeerConnections on unmount.
* **Logging/PII**: By default, do not persist audio/transcripts. If you choose to store, comply with privacy/health regulations.

---

## 🧩 Common Troubleshooting

**Logo not visible**

* Ensure the file truly exists at `/public/hospital-logo.svg` (or update the JSX path).
* Hard refresh (DevTools → Disable cache + reload).

**“Invalid value: 'auto' … input\_audio\_transcription.language”**

* Pass a real code (e.g., `ar`, `de`, `en`); we set it based on PTT role and language pickers.

**“temperature … below minimum value”**

* Set `TEMPERATURE >= 0.6` in backend before creating the session.

**Empty mic / no audio**

* Browser blocked mic: check permissions.
* Backend served over HTTP but frontend over HTTPS (or vice versa): align schemes.
* NAT issues: add a TURN server in your WebRTC config for production.

**No streaming text**

* Verify DataChannel “response” is **open**.
* Ensure the backend passes through the Realtime **event stream** and isn’t buffering.

**Excess scrollbars or crowded layout**

* Tokens are in `RealtimeTranslator.css` (`--container-max`, `--wave-h`, margins). Adjust responsibly.

---

## 🧪 Test Plan (suggested)

* Desktop Chrome/Edge + Safari on macOS
* iOS Safari / Android Chrome
* Mic permission denied / allowed
* PTT press & release (mouse + touch)
* RecLang/PatLang changes mid-call
* Dark ↔ Light toggle
* Drawer on < 720px width
* Network drop & reconnection

---

## 🗺️ Roadmap

* Voice activity **bars** per speaker (who’s talking)
* **Conversation history** export (PDF/CSV)
* **User roles & auth**
* **Patient record** integration (MRN lookup)
* **Automatic language detection** (when model allows)
* **Server-side recording** with secure storage & retention policy
* **Accessibility**: higher contrast mode, larger touch targets

---

## 🔒 Security & Privacy

* Do **not** expose API keys to the browser.
* Keep PHI/PII off logs by default.
* Add explicit consent & retention policies if you store audio or transcripts.

---

## 📜 License

Choose a license appropriate for your organization (e.g., MIT for open source, or a proprietary license). Include it at the repo root as `LICENSE`.

---

## 🙋 Support

Open an issue with:

* Browser + OS
* Exact error text from console/server
* Steps to reproduce
* Backend logs (redact sensitive info)

---

**Tip:** If you change your logo file name, just update the one line in `RealtimeTranslator.jsx`:

```js
const LOGO_PATH = "/hospital-logo.svg"; // set to your public path
```

That’s it—happy shipping!
