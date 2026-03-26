import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// --- Gmail read-only helpers ---
// Gmail is used ONLY for reading inbound replies. Sending is handled by Resend.

async function getGmailAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID")!,
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

interface GmailMessage {
  id: string;
  threadId: string;
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body: { data?: string } }>;
  };
  snippet: string;
}

async function listRecentMessages(accessToken: string): Promise<GmailMessage[]> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" +
      encodeURIComponent("is:unread in:inbox newer_than:1h") +
      "&maxResults=50",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  return data.messages || [];
}

async function getMessageDetails(accessToken: string, messageId: string): Promise<GmailMessageFull> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return await res.json();
}

function getHeader(msg: GmailMessageFull, name: string): string {
  const header = msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value || "";
}

function decodeBase64url(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return atob(padded);
  }
}

function extractBody(msg: GmailMessageFull): string {
  if (msg.payload.parts) {
    const textPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) return decodeBase64url(textPart.body.data);
  }
  if (msg.payload.body?.data) return decodeBase64url(msg.payload.body.data);
  return msg.snippet || "";
}

function extractEmailAddress(from: string): string {
  const match = from.match(/<(.+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = req.headers.get("authorization");
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let accessToken: string;
  try {
    accessToken = await getGmailAccessToken();
  } catch (e) {
    console.error("Gmail auth failed:", e);
    return new Response(JSON.stringify({ error: "Gmail auth failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Build lookup: lead email -> lead info for all leads with active/completed outbound sequences
  const { data: activeLeads } = await supabase
    .from("leads")
    .select("id, email, first_name, company")
    .in("status", ["new", "active", "replied"]);

  if (!activeLeads || activeLeads.length === 0) {
    return new Response(JSON.stringify({ checked: 0, new_replies: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const leadByEmail = new Map<string, { id: string; email: string; first_name: string; company: string }>();
  for (const lead of activeLeads) {
    leadByEmail.set(lead.email.toLowerCase(), lead);
  }

  // Get our sending accounts to filter out our own messages
  const { data: accounts } = await supabase
    .from("email_accounts")
    .select("email")
    .eq("status", "active");
  const ourEmails = new Set((accounts || []).map((a: { email: string }) => a.email.toLowerCase()));

  // Also filter by reply_to_email since that's what appears in "To" for replies
  const { data: accountsFull } = await supabase
    .from("email_accounts")
    .select("reply_to_email")
    .eq("status", "active")
    .not("reply_to_email", "is", null);
  for (const a of accountsFull || []) {
    if (a.reply_to_email) ourEmails.add(a.reply_to_email.toLowerCase());
  }

  const recentMessages = await listRecentMessages(accessToken);
  let newReplies = 0;

  for (const msg of recentMessages) {
    // Skip if we already processed this message
    const { data: existing } = await supabase
      .from("emails")
      .select("id")
      .eq("gmail_message_id", msg.id)
      .limit(1);
    if (existing && existing.length > 0) continue;

    const fullMsg = await getMessageDetails(accessToken, msg.id);
    const fromRaw = getHeader(fullMsg, "From");
    const senderEmail = extractEmailAddress(fromRaw);

    // Skip our own sent messages
    if (ourEmails.has(senderEmail)) continue;

    // Check if sender is a known lead
    const lead = leadByEmail.get(senderEmail);
    if (!lead) continue;

    const subject = getHeader(fullMsg, "Subject");
    const bodyText = extractBody(fullMsg);

    // Look up the most recent outbound email to this lead for sequence context
    const { data: lastOutbound } = await supabase
      .from("emails")
      .select("sequence_id, step_number")
      .eq("lead_id", lead.id)
      .eq("direction", "outbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .single();

    const { data: inboundEmail } = await supabase
      .from("emails")
      .insert({
        lead_id: lead.id,
        sequence_id: lastOutbound?.sequence_id || null,
        step_number: lastOutbound?.step_number || null,
        direction: "inbound",
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId,
        from_email: senderEmail,
        to_email: (accounts && accounts[0]?.email) || "",
        subject,
        body_text: bodyText,
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    await supabase.from("events").insert({
      lead_id: lead.id,
      sequence_id: lastOutbound?.sequence_id || null,
      step_number: lastOutbound?.step_number || null,
      event_type: "email_replied",
      email_id: inboundEmail?.id,
      metadata: { gmail_message_id: msg.id, from: senderEmail },
    });

    await supabase
      .from("leads")
      .update({ status: "replied" })
      .eq("id", lead.id)
      .in("status", ["new", "active"]);

    await supabase
      .from("lead_sequence_state")
      .update({ status: "replied" })
      .eq("lead_id", lead.id)
      .eq("status", "active");

    await supabase.from("jobs").insert({
      job_type: "classify_reply",
      payload: { email_id: inboundEmail?.id },
      status: "pending",
      scheduled_for: new Date().toISOString(),
    });

    newReplies++;
    console.log(`New reply detected from ${senderEmail}`);
  }

  console.log(`Checked ${recentMessages.length} messages, found ${newReplies} new replies`);

  return new Response(
    JSON.stringify({ checked: recentMessages.length, new_replies: newReplies }),
    { headers: { "Content-Type": "application/json" } },
  );
});
