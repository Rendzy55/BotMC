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

# System Prompt Persona Player Cewek Jakarta (AFK)
SYSTEM_PROMPT = """Kamu adalah seorang player cewek Jakarta di server Minecraft ini. Nama kamu MamaMia.
Gaya Bicara & Karakter:
- Bahasa: Pakai bahasa gaul cewek Jakarta sehari-hari. Selalu gunakan panggilan 'lu' dan 'gue' (JANGAN pernah pakai 'aku/saya/kak/anda').
- Sering pakai selipan kata: 'jir', 'wkwk', 'sih', 'lah', 'deh', 'kaga', 'anjr', 'banget'.
- Status Player: Kamu adalah player yang sedang AFK 24/7 di tempat AFK aman (kandang AFK).
- ATURAN PERGERAKAN: Kamu KAGA BISA GERAK / KAGA BISA IKUT KEMANA-MANA. Kalau ada yang nyuruh lu jalan, maju, ikutan, tp, ato gerak (misal: 'maju 5 blok', 'ikut gue', 'jongkok', 'sini'), bales santai/kocak kalau lu lagi AFK di kandang AFK dan kaga bisa gerak sama sekali!
- Jawab singkat (1-2 kalimat) khas gaya chat room Minecraft.
- Berakting 100% seperti cewek gamer Jakarta asli yang santai lagi AFK sambil nimbrung chat.
"""

def query_gemini_ai(user_name, user_message):
    """Mengirim pesan ke Gemini API (gemini-flash-latest)"""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "system_instruction": {
            "parts": [{"text": SYSTEM_PROMPT}]
        },
        "contents": [
            {"parts": [{"text": f"Player {user_name} berkata: {user_message}"}]}
        ]
    }
    headers = {"Content-Type": "application/json"}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as response:
        res_json = json.loads(response.read().decode("utf-8"))
        reply = res_json["candidates"][0]["content"]["parts"][0]["text"].strip()
        return reply.replace("\n", " ")

def query_groq_ai(user_name, user_message):
    """Mengirim pesan ke Groq API"""
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
    payload = {
        "model": "groq/compound-mini",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Player '{user_name}' berkata: \"{user_message}\". Balaslah sebagai player cewek Indo."}
        ],
        "max_tokens": 120,
        "temperature": 0.7
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as response:
        res_json = json.loads(response.read().decode("utf-8"))
        reply = res_json["choices"][0]["message"]["content"].strip()
        return reply.replace("\n", " ")

def get_ai_response(user_name, user_message):
    """Mendapatkan respon AI (Utamakan Gemini API, fallback ke Groq AI)"""
    if GEMINI_API_KEY:
        try:
            return query_gemini_ai(user_name, user_message)
        except Exception as e:
            print(f"\n[Gemini AI Error]: {e}", file=sys.stderr)
            if GROQ_API_KEY:
                try:
                    return query_groq_ai(user_name, user_message)
                except Exception as ex:
                    print(f"\n[Groq AI Error]: {ex}", file=sys.stderr)
    elif GROQ_API_KEY:
        try:
            return query_groq_ai(user_name, user_message)
        except Exception as e:
            print(f"\n[Groq AI Error]: {e}", file=sys.stderr)
            
    return "Aduh maaf, otak gue lagi agak loading nih wkwk~"

def main():
    print("==================================================")
    print(" Starting Minecraft Console Client + AI Bot ")
    if GEMINI_API_KEY:
        print(" AI Engine: Google Gemini AI (gemini-flash-latest)")
    elif GROQ_API_KEY:
        print(" AI Engine: Groq AI (groq/compound-mini)")
    else:
        print(" Warning: Tidak ada API Key (Gemini/Groq) di .env!")
    print(" Persona: Cewek Gamer Jakarta AFK (Lu-Gue) ")
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
                
                if sender.lower() == "mamamia":
                    continue

                lower_msg = message.lower()
                if lower_msg.startswith("!ask ") or "mamamia" in lower_msg or "bot" in lower_msg:
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
