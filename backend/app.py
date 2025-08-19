from flask import Flask, request, Response, jsonify
from flask_cors import CORS
import os
import logging
import requests
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
CORS(app, resources={
    r"/api/*": {
        "origins": [FRONTEND_ORIGIN],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    }
})

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("realtime-backend")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY not set")
    raise EnvironmentError("OPENAI_API_KEY environment variable not set")

# OpenAI Realtime endpoints
OPENAI_SESSION_URL = "https://api.openai.com/v1/realtime/sessions"
OPENAI_RTC_URL     = "https://api.openai.com/v1/realtime"

# Models & voice
MODEL_ID = os.getenv("OPENAI_REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17")
VOICE    = os.getenv("OPENAI_REALTIME_VOICE", "alloy")

# Temperature: API minimum currently enforces >= 0.6 in your logs — default to 0.7
def _safe_temp():
    try:
        t = float(os.getenv("OPENAI_TEMPERATURE", "0.7"))
    except ValueError:
        t = 0.7
    return max(0.6, min(t, 1.5))
TEMPERATURE = _safe_temp()

TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")

# Supported transcription language labels (ISO-639-1 codes)
LANG_LABELS = {
    "af": "Afrikaans", "ar": "Arabic", "az": "Azerbaijani", "be": "Belarusian", "bg": "Bulgarian",
    "bs": "Bosnian", "ca": "Catalan", "cs": "Czech", "cy": "Welsh", "da": "Danish", "de": "German",
    "el": "Greek", "en": "English", "es": "Spanish", "et": "Estonian", "fa": "Persian",
    "fi": "Finnish", "fr": "French", "gl": "Galician", "he": "Hebrew", "hi": "Hindi",
    "hr": "Croatian", "hu": "Hungarian", "hy": "Armenian", "id": "Indonesian", "is": "Icelandic",
    "it": "Italian", "ja": "Japanese", "kk": "Kazakh", "kn": "Kannada", "ko": "Korean",
    "lt": "Lithuanian", "lv": "Latvian", "mi": "Maori", "mk": "Macedonian", "mr": "Marathi",
    "ms": "Malay", "ne": "Nepali", "nl": "Dutch", "no": "Norwegian", "pl": "Polish",
    "pt": "Portuguese", "ro": "Romanian", "ru": "Russian", "sk": "Slovak", "sl": "Slovenian",
    "sr": "Serbian", "sv": "Swedish", "sw": "Swahili", "ta": "Tamil", "th": "Thai",
    "tl": "Tagalog", "tr": "Turkish", "uk": "Ukrainian", "ur": "Urdu", "vi": "Vietnamese", "zh": "Chinese (Mandarin)"
}
SUPPORTED = set(LANG_LABELS.keys())

def ensure_lang(code: str, fallback: str = "en") -> str:
    code = (code or "").lower()
    return code if code in SUPPORTED else fallback

def build_instructions(rec_lang_code: str, pat_lang_code: str, rec_label: str, pat_label: str) -> str:
    return f"""
ROLE: Real-time two-party hospital interpreter at the front desk.

PARTIES:
- Receptionist: speaks {rec_label} ({rec_lang_code})
- Patient: speaks {pat_label} ({pat_lang_code})

OBJECTIVE:
- Mediate turn-by-turn conversation WITHOUT overlap.
- Translate ONLY what was spoken; NO added meaning, advice, or hallucinations.
- Be concise, polite, neutral, and medically appropriate.

ANTI-HALLUCINATION:
- Do not speak until detecting a completed human utterance via VAD.
- Never greet or start on your own. Stay silent between turns.

TURN LOGIC:
- If CURRENT_SPEAKER is Patient → OUTPUT: [[TO_RECEPTIONIST]] <{rec_label} translation>
- If CURRENT_SPEAKER is Receptionist → OUTPUT: [[TO_PATIENT]] <{pat_label} translation>

TRANSCRIPT LOG:
- The client listens for user transcripts from conversation.item.input_audio_transcription.* events.
- The client listens for assistant output from response.text.delta.

STRICT OUTPUT FORMAT:
- Newline-delimited frames only.
- Allowed tags: [[TO_PATIENT]], [[TO_RECEPTIONIST]], [[SUMMARY]]
- Exactly one tagged translation per completed turn.
""".strip()

@app.route("/", methods=["GET"])
def home():
    return "Realtime Translator API is running", 200

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_ID, "temperature": TEMPERATURE}), 200

@app.route("/api/rtc-connect", methods=["POST"])
def rtc_connect():
    """
    Exchanges SDP with OpenAI Realtime API using an ephemeral token.
    Query params:
      - recLang: receptionist language code (e.g., 'en')
      - patLang: patient language code (e.g., 'zh')
    """
    try:
        client_sdp = request.get_data(as_text=True)
        if not client_sdp:
            return Response("No SDP provided", status=400)

        # Validate languages (no 'auto')
        rec_lang = ensure_lang(request.args.get("recLang"), "en")
        pat_lang = ensure_lang(request.args.get("patLang"), "zh")
        rec_label = LANG_LABELS[rec_lang]
        pat_label = LANG_LABELS[pat_lang]

        instructions = build_instructions(rec_lang, pat_lang, rec_label, pat_label)

        # 1) Create Realtime session (ephemeral token)
        session_payload = {
            "model": MODEL_ID,
            "voice": VOICE,
            "modalities": ["audio", "text"],
            "temperature": TEMPERATURE,  # >= 0.6
            "instructions": instructions,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.70,
                "prefix_padding_ms": 250,
                "silence_duration_ms": 700
            },
            "input_audio_transcription": {
                "model": TRANSCRIBE_MODEL,
                "language": rec_lang  # valid ISO-639-1
            }
        }

        headers_json = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json"
        }
        session_resp = requests.post(
            OPENAI_SESSION_URL,
            headers=headers_json,
            json=session_payload,
            timeout=30
        )
        if not session_resp.ok:
            logger.error("Session create failed: %s", session_resp.text)
            # Return upstream error body for easier diagnosing
            return Response(session_resp.text, status=502, mimetype="application/json")

        token = session_resp.json().get("client_secret", {}).get("value")
        if not token:
            logger.error("Ephemeral token missing in session create response")
            return Response("Missing ephemeral token", status=502)

        # 2) Exchange SDP with the ephemeral token
        headers_sdp = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/sdp"
        }
        params = {"model": MODEL_ID, "voice": VOICE}

        sdp_resp = requests.post(
            OPENAI_RTC_URL,
            headers=headers_sdp,
            params=params,
            data=client_sdp,
            timeout=60
        )
        if not sdp_resp.ok:
            logger.error("SDP exchange failed: %s", sdp_resp.text)
            return Response(sdp_resp.text, status=502, mimetype="application/json")

        return Response(sdp_resp.content, status=200, mimetype="application/sdp")

    except requests.Timeout:
        logger.exception("Timeout during rtc-connect")
        return Response("Upstream timeout", status=504)
    except Exception as e:
        logger.exception("RTC connection error")
        return Response(f"Error: {e}", status=500)

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8813"))
    app.run(host="0.0.0.0", port=port, debug=True)




