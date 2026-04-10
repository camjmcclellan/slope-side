import email
import imaplib
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

username = os.getenv("SENDER_EMAIL")
password = os.getenv("SENDER_PASSWORD")

mail = imaplib.IMAP4_SSL("imap.gmail.com")
mail.login(username, password)
mail.select("inbox")

from datetime import datetime, timedelta
since = (datetime.now() - timedelta(hours=24)).strftime("%d-%b-%Y")
status, messages = mail.search(None, f'SINCE "{since}"')
mail_ids = messages[0].split()

print(f"Total emails in inbox: {len(mail_ids)}\n")

for i in mail_ids:
    status, data = mail.fetch(i, "(RFC822)")
    for response_part in data:
        if not isinstance(response_part, tuple):
            continue
        msg = email.message_from_bytes(response_part[1])
        print(f"From:        {msg['from']}")
        print(f"Subject:     {msg['subject']}")
        print(f"Date:        {msg['date']}")
        print(f"Message-ID:  {msg['message-id']}")
        print(f"In-Reply-To: {msg.get('in-reply-to', 'N/A')}")

        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body = part.get_payload(decode=True).decode(errors="replace")
                    break
        else:
            body = msg.get_payload(decode=True).decode(errors="replace")

        print(f"Body:\n{body.strip()}")
        print("-" * 60)

mail.logout()
