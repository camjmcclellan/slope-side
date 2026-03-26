import os
from pathlib import Path

from dotenv import load_dotenv

from test import send_email

load_dotenv(Path(__file__).with_name(".env"))

send_email(
    receiver_email="crstall2004@gmail.com",
    subject="Python Automation Test",
    content="Hello! This is a test email sent from my Python script.",
)
