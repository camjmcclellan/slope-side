import csv
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).with_name("data.db")
CSV_PATH = Path(__file__).with_name("leads.csv")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT,
            last_name TEXT,
            email TEXT,
            contact_owner TEXT,
            account_owner TEXT,
            secondary_email TEXT,
            title TEXT,
            company TEXT,
            industry TEXT,
            keywords TEXT,
            city TEXT,
            state TEXT,
            website TEXT,
            linkedin_url TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER,
            receiver TEXT,
            subject TEXT,
            body TEXT,
            sent_at TEXT,
            FOREIGN KEY (lead_id) REFERENCES leads(id)
        )
    """)

    # Only seed leads if the table is empty
    cursor.execute("SELECT COUNT(*) FROM leads")
    if cursor.fetchone()[0] == 0:
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                cursor.execute("""
                    INSERT INTO leads (first_name, last_name, email, contact_owner, account_owner, secondary_email, title, company, industry, keywords, city, state, website, linkedin_url)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    row["First Name"],
                    row["Last Name"],
                    row["Email"],
                    row["Contact Owner"],
                    row["Account Owner"],
                    row["Secondary Email"],
                    row["Title"],
                    row["Company Name"],
                    row["Industry"],
                    row["Keywords"],
                    row["City"],
                    row["State"],
                    row["Website"],
                    row["Person Linkedin Url"],
                ))
        print("Leads seeded from CSV.")

    conn.commit()
    conn.close()
    print(f"Database ready at {DB_PATH}")


if __name__ == "__main__":
    init_db()
