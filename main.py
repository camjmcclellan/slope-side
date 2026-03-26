import os
from pathlib import Path

from dotenv import load_dotenv

from sendemail import send_email
from checkinbox import check_inbox

load_dotenv(Path(__file__).with_name(".env"))

check_inbox()

# send_email(
#     receiver_email="crstall2004@gmail.com",
#     subject="Python Automation Test",
#     content="Hello! This is a test email sent from my Python script.",
# )
