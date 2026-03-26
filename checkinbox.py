import imaplib
import email
import os

def check_inbox():
    username = os.getenv("SENDER_EMAIL")
    password = os.getenv("SENDER_PASSWORD")

    if not username or not password:
        raise ValueError("Missing email environment variables: SENDER_EMAIL and SENDER_PASSWORD")

    # Connect to Gmail's IMAP server
    mail = imaplib.IMAP4_SSL("imap.gmail.com")
    mail.login(username, password)
    
    # Select the folder you want to check (usually "inbox")
    mail.select("inbox")

    # Search for all "Unseen" (unread) emails
    # You can also search for specific subjects or senders
    status, messages = mail.search(None, 'UNSEEN')
    
    # Convert result to a list of email IDs
    mail_ids = messages[0].split()

    if not mail_ids:
        print("No new replies found.")
        return

    for i in mail_ids:
        # Fetch the email body (RFC822 is the standard format)
        status, data = mail.fetch(i, '(RFC822)')
        
        for response_part in data:
            if isinstance(response_part, tuple):
                # Parse the raw bytes into a readable email object
                msg = email.message_from_bytes(response_part[1])
                print(f"New Reply from: {msg['from']}")
                print(f"Subject: {msg['subject']}")
                
                # If you want to see the text content:
                if msg.is_multipart():
                    for part in msg.walk():
                        if part.get_content_type() == "text/plain":
                            print("Message:", part.get_payload(decode=True).decode())
                else:
                    print("Message:", msg.get_payload(decode=True).decode())

    mail.logout()

