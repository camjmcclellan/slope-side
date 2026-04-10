import email
import imaplib
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).with_name("data.db")


def strip_quoted_text(body: str) -> str:
    lines = body.splitlines()
    clean = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(">"):
            break
        if stripped.endswith("写道：") or stripped.endswith("wrote:") or stripped.endswith("wrote:\r"):
            break
        clean.append(line)
    return "\n".join(clean).strip()


def check_inbox():
    username = os.getenv("SENDER_EMAIL")
    password = os.getenv("SENDER_PASSWORD")

    if not username or not password:
        raise ValueError("Missing email environment variables: SENDER_EMAIL and SENDER_PASSWORD")

    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row

    # Build set of reply Message-IDs already logged to avoid duplicates
    already_logged = set()
    cursor = conn.cursor()
    cursor.execute("SELECT responses FROM history WHERE responses != '[]'")
    for row in cursor.fetchall():
        for r in json.loads(row["responses"] or "[]"):
            if r.get("message_id"):
                already_logged.add(r["message_id"])

    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(username, password)
    mail.select("inbox")

    since = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%d-%b-%Y")
    status, messages = mail.search(None, f'SINCE "{since}"')
    mail_ids = messages[0].split()

    if not mail_ids:
        mail.logout()
        conn.close()
        return {"processed": 0, "matched": 0, "log": ["No emails in the last 24 hours."]}

    log = []
    matched = 0

    for i in mail_ids:
        status, data = mail.fetch(i, "(RFC822)")
        for response_part in data:
            if not isinstance(response_part, tuple):
                continue

            msg = email.message_from_bytes(response_part[1])
            sender = msg["from"]
            subject = msg["subject"] or ""
            this_message_id = msg.get("Message-ID", "").strip()
            in_reply_to = msg.get("In-Reply-To", "").strip()
            received_at = datetime.now(timezone.utc).isoformat()

            # Skip if we already logged this reply
            if this_message_id and this_message_id in already_logged:
                log.append(f"Already logged: {subject} — skipping.")
                continue

            # Only process emails that are replies
            if not in_reply_to:
                log.append(f"Not a reply (no In-Reply-To): {subject} — skipping.")
                continue

            # Extract plain text body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode(errors="replace")
                        break
            else:
                body = msg.get_payload(decode=True).decode(errors="replace")

            log.append(f"Reply from {sender} | Subject: {subject} | In-Reply-To: {in_reply_to}")

            # Match by In-Reply-To -> history.message_id
            history_row = None
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM history WHERE message_id = ?", (in_reply_to,))
            history_row = cursor.fetchone()

            # Fallback: match by subject (strip Re:/RE: prefix)
            if not history_row:
                clean_subject = subject
                for prefix in ["Re: ", "RE: ", "re: ", "Fwd: ", "FWD: "]:
                    if clean_subject.startswith(prefix):
                        clean_subject = clean_subject[len(prefix):]
                        break
                cursor.execute("SELECT * FROM history WHERE subject = ? ORDER BY sent_at DESC LIMIT 1", (clean_subject,))
                history_row = cursor.fetchone()

            if not history_row:
                log.append(f"  -> No matching history entry found. Skipping.")
                continue

            history_row = dict(history_row)
            existing = json.loads(history_row["responses"] or "[]")
            existing.append({
                "message_id": this_message_id,
                "from": sender,
                "body": strip_quoted_text(body),
                "received_at": received_at,
            })
            conn.execute(
                "UPDATE history SET responses = ? WHERE id = ?",
                (json.dumps(existing), history_row["id"])
            )
            conn.commit()
            already_logged.add(this_message_id)
            matched += 1
            log.append(f"  -> Matched to history id={history_row['id']} ({history_row['subject']}). Response saved.")

    conn.close()
    mail.logout()

    return {"processed": len(mail_ids), "matched": matched, "log": log}
