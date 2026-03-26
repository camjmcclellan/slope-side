import json
import os
import random
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template

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


def generate_email(lead: dict) -> tuple[str, str]:
    prompt = build_prompt(lead)
    response = query_llm(model=MODEL, system=SYSTEM_INSTRUCTION, prompt=prompt)
    data = json.loads(response[response.index('{'):response.rindex('}')+1])
    return data["subject"], data["body"]


def log_history(lead_id: int, receiver: str, subject: str, body: str):
    from datetime import datetime, timezone
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO history (lead_id, receiver, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)",
        (lead_id, receiver, subject, body, datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def send_message_to_random_lead():
    leads = leads_to_json()
    lead = leads[random.randint(0, len(leads) - 1)]
    subject, body = generate_email(lead)
    receiver = "crstall2004@gmail.com"
    send_email(receiver_email=receiver, subject=subject, content=body)
    log_history(lead_id=lead["id"], receiver=receiver, subject=subject, body=body)
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


@app.route("/send", methods=["POST"])
def send():
    try:
        lead, subject, body = send_message_to_random_lead()
        return jsonify({"success": True, "lead": lead, "subject": subject, "body": body})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
