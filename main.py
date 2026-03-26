import json
import os
import random
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, Response, stream_with_context

from createdb import init_db
from queryllm import query_llm
from sendemail import send_email

load_dotenv(Path(__file__).with_name(".env"))
init_db()

DB_PATH = Path(__file__).with_name("data.db")

SYSTEM_INSTRUCTION = (
    "You are an expert AI SDR for ScaleMe. Your goal is to write a personalized, "
    "low-pressure email to the contact provided. "
    "Context: ScaleMe helps US-based businesses hire entry-level team members from "
    "overseas to handle repetitive tasks at a fraction of the cost."
)

MODEL = "google/gemini-3-flash-preview"

app = Flask(__name__)


def leads_to_json():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM leads")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def build_prompt(lead: dict) -> str:
    return f"""Write a personalized outreach email to the contact below on behalf of ScaleMe.

Guidelines:
- Keep it under 100 words
- Mention a specific detail from their keywords or industry to show research
- Focus on how offshore staff can handle entry-level operations so they can focus on their core work
- Use a conversational, non-salesy tone
- End with a soft call to action

[data]
{json.dumps(lead, indent=2)}

Task: Write the email for {lead['first_name']}.

Output your response as JSON with the following structure:
{{"subject": "<email subject line>", "body": "<email body>"}}"""


def generate_email(lead: dict) -> tuple[str, str, str]:
    prompt = build_prompt(lead)
    response = query_llm(model=MODEL, system=SYSTEM_INSTRUCTION, prompt=prompt)
    data = json.loads(response[response.index('{'):response.rindex('}')+1])
    return data["subject"], data["body"], prompt


def run_morning_review(log):
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=24)).isoformat()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    log("Pulling history from the last 24 hours...")
    cursor.execute("SELECT * FROM history WHERE sent_at >= ?", (cutoff,))
    recent_history = [dict(r) for r in cursor.fetchall()]
    log(f"Found {len(recent_history)} email(s) sent in the last 24 hours.")

    default_instruction = SYSTEM_INSTRUCTION
    if recent_history:
        log("Building review prompt from yesterday's emails...")
        history_summary = json.dumps([
            {"subject": r["subject"], "body": r["body"]} for r in recent_history
        ], indent=2)
        review_prompt = f"""You are optimizing a cold email outreach system for ScaleMe.

Yesterday's emails (last 24 hours):
{history_summary}

Based on these results, generate two distinct system instruction variants (A and B) for an AI SDR.
Each should take a different angle or tone to enable A/B testing.
Both must instruct the AI to output JSON with the structure: {{"subject": "...", "body": "..."}}

Output as JSON:
{{"variant_a": "<full system instruction for A>", "variant_b": "<full system instruction for B>"}}"""
    else:
        log("No history found — generating cold-start A/B variants from default prompt...")
        review_prompt = f"""You are setting up a cold email outreach system for ScaleMe for the first time.

Default system instruction:
{default_instruction}

Generate two distinct system instruction variants (A and B) based on this default, each taking a different angle or tone for A/B testing.
Both must instruct the AI to output JSON with the structure: {{"subject": "...", "body": "..."}}

Output as JSON:
{{"variant_a": "<full system instruction for A>", "variant_b": "<full system instruction for B>"}}"""

    log("Calling LLM to generate Variant A and Variant B system instructions...")
    response = query_llm(
        model=MODEL,
        system="You are an AI system optimizer. Output only valid JSON.",
        prompt=review_prompt,
    )
    variants = json.loads(response[response.index('{'):response.rindex('}')+1])
    log("Variants generated successfully.")
    log(f"Variant A: {variants['variant_a'][:120]}...")
    log(f"Variant B: {variants['variant_b'][:120]}...")

    created_at = now.isoformat()
    cursor.execute(
        "INSERT INTO prompts (variant, system_instruction, created_at) VALUES (?, ?, ?)",
        ("A", variants["variant_a"], created_at)
    )
    prompt_a_id = cursor.lastrowid
    cursor.execute(
        "INSERT INTO prompts (variant, system_instruction, created_at) VALUES (?, ?, ?)",
        ("B", variants["variant_b"], created_at)
    )
    prompt_b_id = cursor.lastrowid
    log(f"Saved Variant A (id={prompt_a_id}) and Variant B (id={prompt_b_id}) to prompts table.")

    cursor.execute("SELECT * FROM leads")
    all_leads = [dict(r) for r in cursor.fetchall()]
    random.shuffle(all_leads)
    selected = all_leads[:len(all_leads) // 2]
    midpoint = len(selected) // 2
    group_a = selected[:midpoint]
    group_b = selected[midpoint:]
    log(f"Selected {len(selected)} leads (50% of {len(all_leads)}) — {len(group_a)} for Variant A, {len(group_b)} for Variant B.")

    total = len(selected)
    window_minutes = 8 * 60
    interval = window_minutes / max(total - 1, 1)

    plan_rows = []
    all_assignments = (
        [(l, prompt_a_id, "A", variants["variant_a"]) for l in group_a] +
        [(l, prompt_b_id, "B", variants["variant_b"]) for l in group_b]
    )
    for i, (lead, prompt_id, variant, system_instr) in enumerate(all_assignments):
        scheduled_at = (now + timedelta(minutes=5 + i * interval)).isoformat()
        log(f"[{i+1}/{total}] Generating email for {lead['first_name']} {lead['last_name']} ({lead['company']}) — Variant {variant}...")
        email_response = query_llm(
            model=MODEL,
            system=system_instr,
            prompt=build_prompt(lead),
        )
        email_data = json.loads(email_response[email_response.index('{'):email_response.rindex('}')+1])
        log(f"  Subject: {email_data['subject']}")
        log(f"  Scheduled at: {scheduled_at}")
        plan_rows.append((
            lead["id"], prompt_id, variant,
            email_data["subject"], email_data["body"],
            scheduled_at, "pending", created_at
        ))

    cursor.executemany(
        "INSERT INTO plan (lead_id, prompt_id, variant, subject, body, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        plan_rows
    )
    conn.commit()
    conn.close()

    log(f"Done. {len(plan_rows)} emails written to plan table.")
    return {
        "leads_scheduled": len(plan_rows),
        "variant_a_count": len(group_a),
        "variant_b_count": len(group_b),
        "history_reviewed": len(recent_history),
    }


def log_history(lead_id: int, receiver: str, subject: str, body: str, prompt: str):
    from datetime import datetime, timezone
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO history (lead_id, receiver, subject, body, prompt, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
        (lead_id, receiver, subject, body, prompt, datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def send_message_to_random_lead():
    leads = leads_to_json()
    lead = leads[random.randint(0, len(leads) - 1)]
    subject, body, prompt = generate_email(lead)
    receiver = "crstall2004@gmail.com"
    send_email(receiver_email=receiver, subject=subject, content=body)
    log_history(lead_id=lead["id"], receiver=receiver, subject=subject, body=body, prompt=prompt)
    return lead, subject, body


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/leads")
def leads():
    return jsonify(leads_to_json())


@app.route("/history")
def history():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM history ORDER BY sent_at DESC")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route("/plan")
def plan():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM plan ORDER BY scheduled_at ASC")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route("/review", methods=["GET", "POST"])
def review():
    import threading, time

    def stream():
        logs = []
        summary = [None]
        error = [None]

        def log(msg):
            logs.append(msg)

        def worker():
            try:
                summary[0] = run_morning_review(log)
            except Exception as e:
                error[0] = str(e)

        t = threading.Thread(target=worker)
        t.start()

        sent = 0
        while t.is_alive() or sent < len(logs):
            while sent < len(logs):
                yield f"data: {json.dumps({'type': 'log', 'msg': logs[sent]})}\n\n"
                sent += 1
            time.sleep(0.1)

        if error[0]:
            yield f"data: {json.dumps({'type': 'error', 'msg': error[0]})}\n\n"
        else:
            yield f"data: {json.dumps({'type': 'done', **summary[0]})}\n\n"

    return Response(stream_with_context(stream()), mimetype="text/event-stream")


@app.route("/send", methods=["POST"])
def send():
    try:
        lead, subject, body = send_message_to_random_lead()
        return jsonify({"success": True, "lead": lead, "subject": subject, "body": body})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
