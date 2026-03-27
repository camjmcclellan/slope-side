import os
import smtplib
from email.message import EmailMessage
from email.utils import make_msgid


def send_email(receiver_email: str, subject: str, content: str) -> str:
    sender_email = os.getenv("SENDER_EMAIL")
    app_password = os.getenv("SENDER_PASSWORD")

    if not sender_email or not app_password:
        raise ValueError(
            "Missing email environment variables: SENDER_EMAIL and SENDER_PASSWORD"
        )

    message_id = make_msgid()

    msg = EmailMessage()
    msg.set_content(content)
    msg["Subject"] = subject
    msg["From"] = sender_email
    msg["To"] = receiver_email
    msg["Message-ID"] = message_id

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(sender_email, app_password)
        server.send_message(msg)

    return message_id
