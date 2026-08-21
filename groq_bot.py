#!/usr/bin/env python3
import os
import re
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error

# ==========================================
# LOAD API KEYS DARI ENV / .ENV
# ==========================================
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

if os.path.exists(".env"):
    with open(".env", "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY=") and not DEEPSEEK_API_KEY:
                DEEPSEEK_API_KEY = line.split("=", 1)[1].strip('"\'')
            elif line.startswith("GEMINI_API_KEY=") and not GEMINI_API_KEY:
                GEMINI_API_KEY = line.split("=", 1)[1].strip('"\'')
            elif line.startswith("GROQ_API_KEY=") and not GROQ_API_KEY:
                GROQ_API_KEY = line.split("=", 1)[1].strip('"\'')

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

def query_deepseek_ai(user_name, user_message):
    """Mengirim pesan ke DeepSeek API (deepseek-chat)"""
    url = "https://api.deepseek.com/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}"
    }
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Player '{user_name}' berkata: \"{user_message}\"."}
        ],
        "max_tokens": 50,
        "temperature": 0.7
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as response:
        res_json = json.loads(response.read().decode("utf-8"))
        reply = res_json["choices"][0]["message"]["content"].strip()
        return reply.replace("\n", " ")

def query_gemini_ai(user_name, user_message):
    """Mengirim pesan ke Gemini API dengan rotasi model internal (gemini-3.5-flash-lite -> gemini-3.1-flash-lite -> gemini-3.5-flash)"""
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
            print(f"\n[Gemini Model {m} Error/429]: {e}. Mencoba model Gemini berikutnya...", file=sys.stderr)
            
    raise last_err

def query_groq_ai(user_name, user_message):
    """Mengirim pesan ke Groq API dengan rotasi model internal (groq/compound-mini -> groq/compound)"""
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
            print(f"\n[Groq Model {model_name} Error/429]: {e}. Mencoba model Groq berikutnya...", file=sys.stderr)
            
    raise last_err

def check_smart_local_reply(user_message):
    """Pengecekan lokal cepat untuk pertanyaan umum agar menghemat kuota API 70%+"""
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
    """Mendapatkan respon AI dengan sistem Cooldown + Smart Local Check + Multi-Provider Fallback Chain"""
    global LAST_GLOBAL_QUERY_TIME, PLAYER_LAST_QUERY_TIME
    current_time = time.time()
    
    # 1. Cek Cooldown per-Player (Mencegah spam dari 1 player)
    player_key = user_name.lower()
    last_player_time = PLAYER_LAST_QUERY_TIME.get(player_key, 0)
    if current_time - last_player_time < PLAYER_COOLDOWN_SECONDS:
        print(f"\n[Rate Limit Protection]: {user_name} spamming, dikirim respon lokal.")
        return ". . . :v"

    # 2. Cek Fast Local Match (Hemat API call hingga 70%+)
    local_reply = check_smart_local_reply(user_message)
    if local_reply:
        print(f"\n[Fast Local Reply Triggered for {user_name}]: {local_reply}")
        PLAYER_LAST_QUERY_TIME[player_key] = current_time
        return local_reply

    # 3. Cek Cooldown Global (Jeda minimal antar API call untuk cegah HTTP 429)
    time_since_last_global = current_time - LAST_GLOBAL_QUERY_TIME
    if time_since_last_global < GLOBAL_COOLDOWN_SECONDS:
        time.sleep(GLOBAL_COOLDOWN_SECONDS - time_since_last_global)

    # Catat waktu query
    LAST_GLOBAL_QUERY_TIME = time.time()
    PLAYER_LAST_QUERY_TIME[player_key] = time.time()

    # 4. Eksekusi Rotasi API (DeepSeek -> Gemini -> Groq Pool [compound-mini, compound] -> Local Fallback)
    providers = []
    if DEEPSEEK_API_KEY:
        providers.append(("DeepSeek AI", lambda: query_deepseek_ai(user_name, user_message)))
    if GEMINI_API_KEY:
        providers.append(("Gemini AI", lambda: query_gemini_ai(user_name, user_message)))
    if GROQ_API_KEY:
        providers.append(("Groq AI Pool", lambda: query_groq_ai(user_name, user_message)))

    for name, func in providers:
        try:
            return func()
        except Exception as e:
            print(f"\n[{name} Error/429]: {e}. Mengalihkan ke provider berikutnya...", file=sys.stderr)

    return ". . . :v"

def main():
    print("==================================================")
    print(" Starting Minecraft Console Client + AI Bot ")
    if GEMINI_API_KEY:
        print(" Primary AI Engine: Google Gemini AI (gemini-3.5-flash-lite)")
    elif GROQ_API_KEY:
        print(" Primary AI Engine: Groq AI (groq/compound-mini)")
    else:
        print(" Warning: Tidak ada API Key (Gemini/Groq) di .env!")
    print(" Persona: Player Minecraft AFK (Mia) ")
    print(" Feature: Anti-Spam Cooldown & Long Question Dismissal ")
    print("==================================================")
    
    if not os.path.exists("./MinecraftClient"):
        print("[Error] Executable ./MinecraftClient tidak ditemukan. Jalankan ./setup.sh dulu!")
        sys.exit(1)

    process = subprocess.Popen(
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
        for line in iter(process.stdout.readline, ''):
            sys.stdout.write(line)
            sys.stdout.flush()

            clean_line = re.sub(r'\x1b\[[0-9;]*[mGKB]', '', line).strip()

            # 1. Private Message
            pm_match = regex_pm.search(clean_line)
            if pm_match:
                sender = pm_match.group(1)
                message = pm_match.group(2).strip()
                print(f"\n[AI PM Detected from {sender}]: {message}")
                
                ai_reply = get_ai_response(sender, message)
                cmd_send = f"/tell {sender} {ai_reply}\n"
                process.stdin.write(cmd_send)
                process.stdin.flush()
                continue

            # 2. Public Chat
            pub_match = regex_public.search(clean_line)
            if pub_match:
                sender = pub_match.group(1) or pub_match.group(2)
                message = pub_match.group(3).strip()
                
                if sender.lower() == "mia":
                    continue

                lower_msg = message.lower()
                if lower_msg.startswith("!ask ") or "mia" in lower_msg or "bot" in lower_msg:
                    clean_msg = re.sub(r'^!ask\s+', '', message, flags=re.IGNORECASE)
                    print(f"\n[AI Public Chat Detected from {sender}]: {clean_msg}")
                    
                    ai_reply = get_ai_response(sender, clean_msg)
                    cmd_send = f"{ai_reply}\n"
                    process.stdin.write(cmd_send)
                    process.stdin.flush()

    except KeyboardInterrupt:
        print("\nStopping AI Bot...")
        process.terminate()

if __name__ == "__main__":
    main()
