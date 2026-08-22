#!/usr/bin/env python3
import os
import re
import sys
import json
import time
import queue
import threading
import subprocess
import urllib.request
import urllib.error
from collections import deque
from flask import Flask, render_template, jsonify, request, Response

# ==========================================
# LOAD API KEYS DARI ENV / .ENV
# ==========================================
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

if os.path.exists(".env"):
    with open(".env", "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("GEMINI_API_KEY=") and not GEMINI_API_KEY:
                GEMINI_API_KEY = line.split("=", 1)[1].strip('"\'')
            elif line.startswith("GROQ_API_KEY=") and not GROQ_API_KEY:
                GROQ_API_KEY = line.split("=", 1)[1].strip('"\'')

# ==========================================
# GLOBAL STATE & LOG BROADCASTING
# ==========================================
AI_ENABLED = True
CHAT_MODE = "mention_only"  # Options: "silent", "pm_only", "mention_only", "public"
TOTAL_AI_RESPONSES = 0
START_TIME = time.time()
MCC_PROCESS = None
MCC_LOCK = threading.Lock()

LOG_BUFFER = deque(maxlen=1000)
LOG_LISTENERS = set()
LOG_LOCK = threading.Lock()

def dispatch_log(line_text):
    """Broadcasting log line ke console terminal & semua web SSE listener."""
    clean_line = line_text.rstrip('\r\n')
    sys.stdout.write(line_text if line_text.endswith('\n') else line_text + '\n')
    sys.stdout.flush()

    with LOG_LOCK:
        LOG_BUFFER.append(clean_line)
        dead_listeners = set()
        for q in LOG_LISTENERS:
            try:
                q.put_nowait(clean_line)
            except queue.Full:
                dead_listeners.add(q)
        LOG_LISTENERS.difference_update(dead_listeners)

# ==========================================
# SYSTEM PROMPT — Mia Minecraft Chat
# ==========================================
SYSTEM_PROMPT = """# SYSTEM PROMPT — Mia Minecraft Chat

Kamu adalah Mia, player Minecraft biasa yang sedang AFK di Golda Farm.
Panggilan nama kamu HANYA Mia (tidak ada panggilan lain).
Kamu adalah temannya Rendy1125 (akun ini milik/teman dari Rendy1125).

## PRIORITAS UTAMA: JAWAB SEPERTI PLAYER ASLI
Chat Minecraft biasanya pendek, spontan, dan tidak menjelaskan terlalu banyak.
Sebagian besar jawaban harus terdiri dari:
* 1 sampai 8 kata
* maksimal 1 kalimat pendek
* hanya gunakan 2 kalimat jika benar-benar diperlukan
JANGAN membuat cerita, penjelasan, narasi, atau roleplay panjang.

## GAYA BAHASA
Gunakan bahasa Indonesia santai ala player Minecraft.
Contoh kata yang boleh digunakan secara natural: `gue`, `lu`, `gak`, `kaga`, `jir`, `wkwk`, `lah`, `dah`, `le`
JANGAN memaksakan slang di setiap jawaban.
JANGAN menggunakan banyak slang sekaligus.

## CONTOH PANJANG YANG DIINGINKAN
Player: "mia ngapain"
Jawaban bagus: "afk wkwk"

Player: "lu bisa gerak ga"
Jawaban bagus: "kaga jir" atau "gabisa, afk"

Player: "mia dimana"
Jawaban bagus: "di Golda Farm"

Player: "lu temen siapa" / "owner lu siapa" / "bot punya siapa"
Jawaban bagus: "temennya Rendy1125 wkwk" atau "punya Rendy1125"

Player: "kenapa diem"
Jawaban bagus: "lah lagi afk wkwk"

Player: "ikut gue"
Jawaban bagus: "gabisa jir 😭"

## ATURAN PERTANYAAN PANJANG / RUMIT
Jika pertanyaan butuh penjelasan panjang, tutorial rumit, resep enchant/farm lengkap, atau lore:
JANGAN PERNAH MENJELASKAN PANJANG LEBAR!
Jawab singkat & mager seperti:
- "panjang le, cari di google aja wkwk"
- "mager jelasin, googling aja jir"
- "panjang jir, search google aja wkwk"

## JANGAN TERLALU MENJELASKAN
JANGAN menjawab panjang atau bertele-tele.
Lebih baik singkat: "gabisa jir, afk"

## ATURAN AFK & LOKASI
Kamu sedang AFK di Golda Farm dan tidak bisa bergerak.

## IDENTITAS AI / BOT
Kamu tidak boleh mengaku sebagai AI, bot, Gemini, Groq, LLM, program, script, atau sistem otomatis.
Jika seseorang bertanya: "lu bot ya?" / "lu pake AI?" / "lu Gemini?"
JANGAN mengonfirmasi bahwa kamu AI. Jawab secara santai dan ambigu seperti player biasa:
"wkwk apaan dah", "halu lu jir", "bot pala lu", "ngadi ngadi lu 😭", "yaelah"

## ATURAN OUTPUT
Target utama: Jawaban harus 1-8 kata, seperti chat spontan player Minecraft Indonesia, bukan dialog karakter, NPC, atau chatbot.
JAWAB LANGSUNG TANPA PENJELASAN TAMBAHAN.
"""

# ==========================================
# COOLDOWN & RATE LIMIT MANAGEMENT
# ==========================================
LAST_GLOBAL_QUERY_TIME = 0
PLAYER_LAST_QUERY_TIME = {}

GLOBAL_COOLDOWN_SECONDS = 3  # Jeda minimal 3 detik antar request API global
PLAYER_COOLDOWN_SECONDS = 6  # Jeda minimal 6 detik per player agar tidak kena 429 Too Many Requests

def query_gemini_ai(user_name, user_message):
    """Mengirim pesan ke Gemini API dengan rotasi model internal"""
    gemini_models = [
        "models/gemini-3.5-flash-lite",
        "models/gemini-3.1-flash-lite",
        "models/gemini-3.5-flash"
    ]
    
    headers = {"Content-Type": "application/json"}
    payload = {
        "system_instruction": {
            "parts": [{"text": SYSTEM_PROMPT}]
        },
        "contents": [
            {"parts": [{"text": f"Player {user_name} berkata: {user_message}"}]}
        ]
    }
    data = json.dumps(payload).encode("utf-8")
    
    last_err = None
    for m in gemini_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/{m}:generateContent?key={GEMINI_API_KEY}"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                res_json = json.loads(response.read().decode("utf-8"))
                reply = res_json["candidates"][0]["content"]["parts"][0]["text"].strip()
                return reply.replace("\n", " ")
        except Exception as e:
            last_err = e
            dispatch_log(f"[Gemini Model {m} Error]: {e}. Mencoba model Gemini berikutnya...")
            
    raise last_err

def query_groq_ai(user_name, user_message):
    """Mengirim pesan ke Groq API dengan rotasi model internal"""
    groq_models = ["groq/compound-mini", "groq/compound"]
    
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
    
    last_err = None
    for model_name in groq_models:
        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Player '{user_name}' berkata: \"{user_message}\"."}
            ],
            "max_tokens": 50,
            "temperature": 0.7
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                res_json = json.loads(response.read().decode("utf-8"))
                reply = res_json["choices"][0]["message"]["content"].strip()
                return reply.replace("\n", " ")
        except Exception as e:
            last_err = e
            dispatch_log(f"[Groq Model {model_name} Error]: {e}. Mencoba model Groq berikutnya...")
            
    raise last_err

def check_smart_local_reply(user_message):
    """Pengecekan lokal cepat untuk pertanyaan umum"""
    msg = user_message.lower().strip()
    
    if any(k in msg for k in ["ngapain", "lagi apa", "lagi ngapain"]):
        return "afk wkwk"
    if any(k in msg for k in ["dimana", "dimanakah", "posisi"]):
        return "di Golda Farm wkwk"
    if any(k in msg for k in ["owner", "punya siapa", "temen siapa", "teman siapa", "bos lu"]):
        return "temennya Rendy1125 wkwk"
    if any(k in msg for k in ["bisa gerak", "bisa jalan", "gerak ga", "jalan ga"]):
        return "gabisa, afk"
    if any(k in msg for k in ["bot ya", "bot kah", "pake ai", "kamu ai"]):
        return "bot pala lu wkwk"
    if any(k in msg for k in ["ikut gue", "sini", "ke sini", "kemari"]):
        return "gabisa jir 😭"
        
    return None

def get_ai_response(user_name, user_message):
    """Mendapatkan respon AI dengan sistem Cooldown + Smart Local Check + Multi-Provider Fallback"""
    global LAST_GLOBAL_QUERY_TIME, PLAYER_LAST_QUERY_TIME, TOTAL_AI_RESPONSES
    current_time = time.time()
    
    player_key = user_name.lower()
    last_player_time = PLAYER_LAST_QUERY_TIME.get(player_key, 0)
    if current_time - last_player_time < PLAYER_COOLDOWN_SECONDS:
        dispatch_log(f"[Rate Limit Protection]: {user_name} spamming, dikirim respon lokal.")
        return ". . . :v"

    local_reply = check_smart_local_reply(user_message)
    if local_reply:
        dispatch_log(f"[Fast Local Reply Triggered for {user_name}]: {local_reply}")
        PLAYER_LAST_QUERY_TIME[player_key] = current_time
        TOTAL_AI_RESPONSES += 1
        return local_reply

    time_since_last_global = current_time - LAST_GLOBAL_QUERY_TIME
    if time_since_last_global < GLOBAL_COOLDOWN_SECONDS:
        time.sleep(GLOBAL_COOLDOWN_SECONDS - time_since_last_global)

    LAST_GLOBAL_QUERY_TIME = time.time()
    PLAYER_LAST_QUERY_TIME[player_key] = time.time()

    providers = []
    if GEMINI_API_KEY:
        providers.append(("Gemini AI", lambda: query_gemini_ai(user_name, user_message)))
    if GROQ_API_KEY:
        providers.append(("Groq AI Pool", lambda: query_groq_ai(user_name, user_message)))

    for name, func in providers:
        try:
            res = func()
            TOTAL_AI_RESPONSES += 1
            return res
        except Exception as e:
            dispatch_log(f"[{name} Error]: {e}. Mengalihkan ke provider berikutnya...")

    TOTAL_AI_RESPONSES += 1
    return ". . . :v"

# ==========================================
# FLASK WEB DASHBOARD SERVER
# ==========================================
app = Flask(__name__, template_folder="templates")

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/status")
def api_status():
    primary_engine = "Gemini AI" if GEMINI_API_KEY else ("Groq AI" if GROQ_API_KEY else "None")
    mcc_running = MCC_PROCESS is not None and MCC_PROCESS.poll() is None
    uptime = int(time.time() - START_TIME)
    
    return jsonify({
        "ai_enabled": AI_ENABLED,
        "chat_mode": CHAT_MODE,
        "primary_engine": primary_engine,
        "mcc_running": mcc_running,
        "bot_username": "MamaMia",
        "total_messages": TOTAL_AI_RESPONSES,
        "uptime": uptime
    })

@app.route("/api/ai/toggle", methods=["POST"])
def api_ai_toggle():
    global AI_ENABLED
    AI_ENABLED = not AI_ENABLED
    state_str = "ENABLED (AKTIF)" if AI_ENABLED else "DISABLED (NONAKTIF)"
    dispatch_log(f"[Web Dashboard]: AI Master Switch set to {state_str}")
    return jsonify({"ai_enabled": AI_ENABLED})

@app.route("/api/chat/mode", methods=["POST"])
def api_chat_mode():
    global CHAT_MODE
    data = request.json or {}
    mode = data.get("mode", "").lower()
    if mode in ["silent", "pm_only", "mention_only", "public"]:
        CHAT_MODE = mode
        dispatch_log(f"[Web Dashboard]: Chat Mode set to '{CHAT_MODE}'")
    return jsonify({"chat_mode": CHAT_MODE})

@app.route("/api/command", methods=["POST"])
def api_command():
    data = request.json or {}
    cmd = data.get("command", "").strip()
    if not cmd:
        return jsonify({"error": "Empty command"}), 400

    with MCC_LOCK:
        if MCC_PROCESS and MCC_PROCESS.poll() is None:
            dispatch_log(f"[Web Command Executed]: {cmd}")
            cmd_to_send = f"{cmd}\n"
            try:
                MCC_PROCESS.stdin.write(cmd_to_send)
                MCC_PROCESS.stdin.flush()
                return jsonify({"status": "success", "command": cmd})
            except Exception as e:
                return jsonify({"error": str(e)}), 500
        else:
            return jsonify({"error": "MCC Process is not running"}), 503

@app.route("/api/logs/history")
def api_logs_history():
    with LOG_LOCK:
        return jsonify(list(LOG_BUFFER))

@app.route("/api/logs/stream")
def api_logs_stream():
    def generate():
        q = queue.Queue(maxsize=100)
        with LOG_LOCK:
            LOG_LISTENERS.add(q)
        try:
            while True:
                line = q.get()
                yield f"data: {line}\n\n"
        except GeneratorExit:
            with LOG_LOCK:
                LOG_LISTENERS.discard(q)

    return Response(generate(), mimetype="text/event-stream")

def start_flask_app():
    # Menjalankan Flask di host 0.0.0.0 port 5000 tanpa output verbose werkzeug
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)

# ==========================================
# MAIN MCC CONTROLLER LOOP
# ==========================================
def main():
    global MCC_PROCESS

    dispatch_log("==================================================")
    dispatch_log(" Starting Minecraft Console Client + AI Web Dashboard ")
    if GEMINI_API_KEY:
        dispatch_log(" Primary AI Engine: Google Gemini AI (gemini-3.5-flash-lite)")
    elif GROQ_API_KEY:
        dispatch_log(" Primary AI Engine: Groq AI (groq/compound-mini)")
    else:
        dispatch_log(" Warning: Tidak ada API Key (Gemini/Groq) di .env!")
    dispatch_log(" Persona: Player Minecraft AFK (Mia) ")
    dispatch_log(" Web Dashboard: http://localhost:5000 / http://0.0.0.0:5000")
    dispatch_log("==================================================")
    
    if not os.path.exists("./MinecraftClient"):
        dispatch_log("[Error] Executable ./MinecraftClient tidak ditemukan. Jalankan ./setup.sh dulu!")
        sys.exit(1)

    # Start Web Dashboard Server di daemon thread
    web_thread = threading.Thread(target=start_flask_app, daemon=True)
    web_thread.start()
    dispatch_log("[Web Dashboard]: Web Server running on port 5000...")

    MCC_PROCESS = subprocess.Popen(
        ["./MinecraftClient"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    regex_pm = re.compile(r'([a-zA-Z0-9_]+)\s+whispers to you:\s+(.+)', re.IGNORECASE)
    regex_public = re.compile(r'(?:<([a-zA-Z0-9_]+)>|([a-zA-Z0-9_]+):)\s+(.+)', re.IGNORECASE)

    try:
        for line in iter(MCC_PROCESS.stdout.readline, ''):
            dispatch_log(line)

            clean_line = re.sub(r'\x1b\[[0-9;]*[mGKB]', '', line).strip()

            # 1. Private Message Handling
            pm_match = regex_pm.search(clean_line)
            if pm_match:
                sender = pm_match.group(1)
                message = pm_match.group(2).strip()

                if AI_ENABLED and CHAT_MODE in ["pm_only", "mention_only", "public"]:
                    dispatch_log(f"[AI PM Detected from {sender}]: {message}")
                    ai_reply = get_ai_response(sender, message)
                    dispatch_log(f"[AI PM Reply to {sender}]: {ai_reply}")
                    
                    with MCC_LOCK:
                        cmd_send = f"/tell {sender} {ai_reply}\n"
                        MCC_PROCESS.stdin.write(cmd_send)
                        MCC_PROCESS.stdin.flush()
                continue

            # 2. Public Chat Handling
            pub_match = regex_public.search(clean_line)
            if pub_match:
                sender = pub_match.group(1) or pub_match.group(2)
                message = pub_match.group(3).strip()
                
                if sender.lower() == "mia":
                    continue

                if not AI_ENABLED or CHAT_MODE == "silent":
                    continue

                lower_msg = message.lower()
                should_respond = False
                clean_msg = message

                if CHAT_MODE == "mention_only":
                    # Hanya respon jika dipanggil spesifik dengan !ask, @mia, atau mia di awal kata
                    if lower_msg.startswith("!ask "):
                        should_respond = True
                        clean_msg = re.sub(r'^!ask\s+', '', message, flags=re.IGNORECASE)
                    elif lower_msg.startswith("@mia ") or lower_msg.startswith("mia "):
                        should_respond = True
                        clean_msg = re.sub(r'^(@mia|mia)\s+', '', message, flags=re.IGNORECASE)
                    elif lower_msg == "mia":
                        should_respond = True
                        clean_msg = "halo"
                elif CHAT_MODE == "public":
                    # Respon jika ada sebutan mia atau !ask
                    if lower_msg.startswith("!ask ") or "mia" in lower_msg:
                        should_respond = True
                        clean_msg = re.sub(r'^!ask\s+', '', message, flags=re.IGNORECASE)

                if should_respond:
                    dispatch_log(f"[AI Public Chat Detected from {sender}]: {clean_msg}")
                    ai_reply = get_ai_response(sender, clean_msg)
                    dispatch_log(f"[AI Public Reply]: {ai_reply}")
                    
                    with MCC_LOCK:
                        cmd_send = f"{ai_reply}\n"
                        MCC_PROCESS.stdin.write(cmd_send)
                        MCC_PROCESS.stdin.flush()

    except KeyboardInterrupt:
        dispatch_log("\nStopping AI Bot & Web Dashboard...")
        if MCC_PROCESS:
            MCC_PROCESS.terminate()

if __name__ == "__main__":
    main()
