import json
import os
import random
import sqlite3
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, Response, stream_with_context

from checkinbox import check_inbox
from createdb import init_db
from queryllm import query_llm
from sendemail import send_email

load_dotenv(Path(__file__).with_name(".env"))
init_db()

scheduler = BackgroundScheduler(misfire_grace_time=30)
scheduler.add_job(check_inbox, "interval", minutes=15)
scheduler.add_job(lambda: dispatch_scheduled_emails(), "interval", minutes=1)
scheduler.add_job(lambda: run_morning_review(lambda msg: print(f"[review] {msg}")), "cron", hour=8, minute=0)
scheduler.start()

DB_PATH = Path(__file__).with_name("data.db")


def extract_json(text: str) -> dict:
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    # Extract outermost JSON object
    start = text.index('{')
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i+1])
    raise ValueError("No valid JSON object found in LLM response")

SYSTEM_INSTRUCTION = (
    "You are an expert AI SDR for ScaleMe. Your goal is to write a personalized, "
    "low-pressure email to the contact provided. "
    "Context: ScaleMe helps US-based businesses hire entry-level team members from "
    "overseas to handle repetitive tasks at a fraction of the cost."
)

MODEL = "google/gemini-3-flash-preview"

app = Flask(__name__)


def leads_to_json():
    conn = sqlite3.connect(DB_PATH, timeout=30)
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


def query_llm_with_retry(model, system, prompt, retries=5):
    for attempt in range(1, retries + 1):
        try:
            response = query_llm(model=model, system=system, prompt=prompt)
            return extract_json(response)
        except Exception as e:
            if attempt == retries:
                raise
            print(f"[retry] Attempt {attempt} failed ({e}), retrying...")


def generate_email(lead: dict) -> tuple[str, str, str]:
    prompt = build_prompt(lead)
    data = query_llm_with_retry(model=MODEL, system=SYSTEM_INSTRUCTION, prompt=prompt)
    return data["subject"], data["body"], prompt


def run_morning_review(log):
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=24)).isoformat()

    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    log("Pulling history from the last 24 hours...")
    cursor.execute("SELECT * FROM history WHERE sent_at >= ?", (cutoff,))
    recent_history = [dict(r) for r in cursor.fetchall()]
    log(f"Found {len(recent_history)} email(s) sent in the last 24 hours.")

    # Pull the most recent A/B prompt pair
    cursor.execute("SELECT * FROM prompts ORDER BY created_at DESC LIMIT 2")
    recent_prompts = [dict(r) for r in cursor.fetchall()]

    if recent_history and recent_prompts:
        log("Building A/B performance report from last session's prompts...")

        def build_variant_report(prompt_row):
            pid = prompt_row["id"]
            variant = prompt_row["variant"]
            sends = [r for r in recent_history if r.get("prompt_id") == pid]
            responses = []
            for s in sends:
                replies = json.loads(s.get("responses") or "[]")
                responses.extend(replies)
            log(f"  Variant {variant} (prompt id={pid}): {len(sends)} sent, {len(responses)} response(s).")
            return {
                "variant": variant,
                "system_instruction": prompt_row["system_instruction"],
                "emails_sent": len(sends),
                "responses_received": len(responses),
                "responses": [{"from": r.get("from"), "body": r.get("body")} for r in responses],
            }

        reports = [build_variant_report(p) for p in recent_prompts]

        # Include unlinked sends (sent via random button, no prompt_id)
        unlinked = [r for r in recent_history if r.get("prompt_id") is None]
        if unlinked:
            unlinked_responses = []
            for r in unlinked:
                unlinked_responses.extend(json.loads(r.get("responses") or "[]"))
            log(f"  Unlinked (no variant): {len(unlinked)} sent, {len(unlinked_responses)} response(s).")
            reports.append({
                "variant": "unlinked",
                "system_instruction": SYSTEM_INSTRUCTION,
                "emails_sent": len(unlinked),
                "responses_received": len(unlinked_responses),
                "responses": [{"from": r.get("from"), "body": r.get("body")} for r in unlinked_responses],
            })

        report_json = json.dumps(reports, indent=2)

        review_prompt = f"""You are optimizing a cold email outreach system for ScaleMe.

Here is the A/B performance data from the last 24 hours:
{report_json}

Based on this data — what worked, what got responses, and what the responses said — generate two new improved system instruction variants (A and B) for an AI SDR.
Each should take a different angle or tone to enable continued A/B testing.
Both must instruct the AI to output JSON with the structure: {{"subject": "...", "body": "..."}}

Output as JSON:
{{"variant_a": "<full system instruction for A>", "variant_b": "<full system instruction for B>"}}"""

    else:
        log("No history found — generating cold-start A/B variants from default prompt...")
        review_prompt = f"""You are setting up a cold email outreach system for ScaleMe for the first time.

Default system instruction:
{SYSTEM_INSTRUCTION}

Generate two distinct system instruction variants (A and B) based on this default, each taking a different angle or tone for A/B testing.
Both must instruct the AI to output JSON with the structure: {{"subject": "...", "body": "..."}}

Output as JSON:
{{"variant_a": "<full system instruction for A>", "variant_b": "<full system instruction for B>"}}"""

    log("Calling LLM to generate Variant A and Variant B system instructions...")
    variants = query_llm_with_retry(
        model=MODEL,
        system="You are an AI system optimizer. Output only valid JSON.",
        prompt=review_prompt,
    )
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
        scheduled_at = (now + timedelta(minutes=1 + i * interval)).isoformat()
        log(f"[{i+1}/{total}] Generating email for {lead['first_name']} {lead['last_name']} ({lead['company']}) — Variant {variant}...")
        email_data = query_llm_with_retry(
            model=MODEL,
            system=system_instr,
            prompt=build_prompt(lead),
        )
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


def log_history(lead_id: int, receiver: str, subject: str, body: str, prompt: str, message_id: str = "", prompt_id: int = None):
    from datetime import datetime, timezone
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute(
        "INSERT INTO history (lead_id, prompt_id, receiver, subject, body, prompt, message_id, responses, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (lead_id, prompt_id, receiver, subject, body, prompt, message_id, "[]", datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def send_message_to_random_lead():
    leads = leads_to_json()
    lead = leads[random.randint(0, len(leads) - 1)]
    subject, body, prompt = generate_email(lead)
    receiver = "slopeside-test@mailinator.com"
    message_id = send_email(receiver_email=receiver, subject=subject, content=body)
    log_history(lead_id=lead["id"], receiver=receiver, subject=subject, body=body, prompt=prompt, message_id=message_id)
    return lead, subject, body


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/leads")
def leads():
    return jsonify(leads_to_json())


@app.route("/history")
def history():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT h.*, l.first_name, l.last_name, l.company, l.title
        FROM history h
        LEFT JOIN leads l ON h.lead_id = l.id
        ORDER BY h.sent_at DESC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route("/plan")
def plan():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.*, l.first_name, l.last_name, l.company, l.title
        FROM plan p
        LEFT JOIN leads l ON p.lead_id = l.id
        ORDER BY p.scheduled_at ASC
    """)
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


def execute_plan_row(plan_row: dict, conn, cursor):
    """Send one plan row, log to history, and delete from plan. Shared by route and scheduler."""
    cursor.execute("SELECT system_instruction FROM prompts WHERE id = ?", (plan_row["prompt_id"],))
    prompt_row = cursor.fetchone()
    system_instruction = prompt_row["system_instruction"] if prompt_row else SYSTEM_INSTRUCTION

    cursor.execute("SELECT * FROM leads WHERE id = ?", (plan_row["lead_id"],))
    lead = dict(cursor.fetchone())

    full_prompt = build_prompt(lead)
    receiver = "slopeside-test@mailinator.com"
    message_id = send_email(receiver_email=receiver, subject=plan_row["subject"], content=plan_row["body"])

    log_history(
        lead_id=plan_row["lead_id"],
        receiver=receiver,
        subject=plan_row["subject"],
        body=plan_row["body"],
        prompt=f"[System]\n{system_instruction}\n\n[User]\n{full_prompt}",
        message_id=message_id,
        prompt_id=plan_row["prompt_id"],
    )

    cursor.execute("DELETE FROM plan WHERE id = ?", (plan_row["id"],))
    conn.commit()


def dispatch_scheduled_emails():
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM plan WHERE scheduled_at <= ? AND status = 'pending'",
        (now,)
    )
    due = [dict(r) for r in cursor.fetchall()]
    for plan_row in due:
        try:
            execute_plan_row(plan_row, conn, cursor)
            print(f"[scheduler] Sent plan id={plan_row['id']} to {plan_row.get('lead_id')}")
        except Exception as e:
            print(f"[scheduler] Failed plan id={plan_row['id']}: {e}")
    conn.close()


@app.route("/send_plan/<int:plan_id>", methods=["POST"])
def send_plan(plan_id):
    try:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM plan WHERE id = ?", (plan_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({"success": False, "error": "Plan row not found"}), 404

        execute_plan_row(dict(row), conn, cursor)
        conn.close()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/reset_db", methods=["POST"])
def reset_db():
    try:
        DB_PATH.unlink(missing_ok=True)
        init_db()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/check_inbox", methods=["POST"])
def check_inbox_route():
    try:
        result = check_inbox()
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/intro")
def intro():
    return render_template("intro.html")


@app.route("/send", methods=["POST"])
def send():
    try:
        lead, subject, body = send_message_to_random_lead()
        return jsonify({"success": True, "lead": lead, "subject": subject, "body": body})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=2001)
