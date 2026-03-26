import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

// --- Resend helper ---

async function sendViaResend(
  from: string,
  to: string,
  subject: string,
  text: string,
  replyTo?: string,
): Promise<{ id: string }> {
  const body: Record<string, unknown> = { from, to: [to], subject, text };
  if (replyTo) body.reply_to = [replyTo];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend send failed: ${JSON.stringify(data)}`);
  return { id: data.id };
}

// --- Template helpers ---

function resolveTemplate(
  template: string,
  lead: Record<string, string>,
  senderName: string,
): string {
  const replacements: Record<string, string> = {
    "{{first_name}}": lead.first_name || "",
    "{{last_name}}": lead.last_name || "",
    "{{company}}": lead.company || "",
    "{{title}}": lead.title || "",
    "{{industry}}": lead.industry || "",
    "{{company_size}}": lead.company_size || "",
    "{{sender_name}}": senderName,
  };
  let result = template;
  for (const [ph, val] of Object.entries(replacements)) {
    result = result.split(ph).join(val);
  }
  return result;
}

// --- OpenAI helper ---

async function classifyReplyWithOpenAI(
  replyText: string,
  leadContext: { first_name: string; company: string },
): Promise<{ classification: string; confidence: number; reasoning: string }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You classify cold email replies. Return JSON with exactly: {"classification": "interested"|"not_interested"|"out_of_office"|"unsubscribe"|"other", "confidence": 0.0-1.0, "reasoning": "brief explanation"}',
        },
        {
          role: "user",
          content: `Lead: ${leadContext.first_name} at ${leadContext.company}\nReply: ${replyText}`,
        },
      ],
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { classification: "other", confidence: 0, reasoning: "Failed to parse AI response" };
  }
}

// --- Job handlers ---

async function handleSendEmail(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const { lead_id, sequence_id, step_number, lead_sequence_state_id } = payload as {
    lead_id: string;
    sequence_id: string;
    step_number: number;
    lead_sequence_state_id: string;
  };

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", lead_id)
    .single();
  if (leadErr || !lead) throw new Error(`Lead not found: ${lead_id}`);

  const { data: step, error: stepErr } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("sequence_id", sequence_id)
    .eq("step_number", step_number)
    .single();
  if (stepErr || !step) throw new Error(`Step not found: seq=${sequence_id} step=${step_number}`);

  const { data: account, error: acctErr } = await supabase
    .from("email_accounts")
    .select("*")
    .eq("status", "active")
    .limit(1)
    .single();
  if (acctErr || !account) throw new Error("No active email account found");

  const now = new Date();
  const resetAt = new Date(account.sent_today_reset_at);
  let sentToday = account.sent_today;
  if (now.toDateString() !== resetAt.toDateString()) {
    sentToday = 0;
    await supabase
      .from("email_accounts")
      .update({ sent_today: 0, sent_today_reset_at: now.toISOString() })
      .eq("id", account.id);
  }
  if (sentToday >= account.daily_send_limit) {
    throw new Error(`Daily send limit reached (${account.daily_send_limit})`);
  }

  const subject = resolveTemplate(step.subject_template, lead, account.display_name);
  const body = resolveTemplate(step.body_template, lead, account.display_name);
  const fromAddress = `${account.display_name} <${account.email}>`;

  const resendResult = await sendViaResend(
    fromAddress,
    lead.email,
    subject,
    body,
    account.reply_to_email || undefined,
  );

  const { data: emailRecord } = await supabase
    .from("emails")
    .insert({
      lead_id,
      email_account_id: account.id,
      sequence_id,
      step_number,
      direction: "outbound",
      resend_id: resendResult.id,
      from_email: account.email,
      to_email: lead.email,
      subject,
      body_text: body,
      sent_at: now.toISOString(),
    })
    .select("id")
    .single();

  await supabase.from("events").insert({
    lead_id,
    sequence_id,
    step_number,
    event_type: "email_sent",
    email_id: emailRecord?.id,
    metadata: { resend_id: resendResult.id },
  });

  await supabase
    .from("leads")
    .update({ status: "active" })
    .eq("id", lead_id)
    .eq("status", "new");

  await supabase
    .from("email_accounts")
    .update({ sent_today: sentToday + 1 })
    .eq("id", account.id);

  const { data: totalSteps } = await supabase
    .from("sequence_steps")
    .select("step_number")
    .eq("sequence_id", sequence_id)
    .order("step_number", { ascending: false })
    .limit(1)
    .single();

  const maxStep = totalSteps?.step_number || step_number;

  if (step_number >= maxStep) {
    await supabase
      .from("lead_sequence_state")
      .update({
        status: "completed",
        completed_at: now.toISOString(),
        locked_until: null,
      })
      .eq("id", lead_sequence_state_id);
  } else {
    const { data: nextStep } = await supabase
      .from("sequence_steps")
      .select("step_number, delay_days")
      .eq("sequence_id", sequence_id)
      .eq("step_number", step_number + 1)
      .single();

    const nextActionAt = new Date(
      now.getTime() + (nextStep?.delay_days || 1) * 24 * 60 * 60 * 1000,
    ).toISOString();

    await supabase
      .from("lead_sequence_state")
      .update({
        current_step_number: step_number + 1,
        next_action_at: nextActionAt,
        locked_until: null,
      })
      .eq("id", lead_sequence_state_id);
  }

  console.log(`Sent email to ${lead.email} via Resend: step ${step_number}, id ${resendResult.id}`);
}

async function handleClassifyReply(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<void> {
  const { email_id } = payload as { email_id: string };

  const { data: email, error } = await supabase
    .from("emails")
    .select("*, leads:lead_id(*)")
    .eq("id", email_id)
    .single();
  if (error || !email) throw new Error(`Email not found: ${email_id}`);

  const lead = email.leads;
  const replyText = email.body_text || email.subject || "";

  const classification = await classifyReplyWithOpenAI(replyText, {
    first_name: lead.first_name,
    company: lead.company || "",
  });

  await supabase.from("events").insert({
    lead_id: email.lead_id,
    sequence_id: email.sequence_id,
    step_number: email.step_number,
    event_type: "reply_classified",
    email_id,
    metadata: classification,
  });

  const statusMap: Record<string, string> = {
    interested: "interested",
    not_interested: "not_interested",
    unsubscribe: "unsubscribed",
  };
  const newStatus = statusMap[classification.classification];
  if (newStatus) {
    await supabase.from("leads").update({ status: newStatus }).eq("id", email.lead_id);
  }

  if (classification.classification === "unsubscribe") {
    await supabase
      .from("lead_sequence_state")
      .update({ status: "opted_out" })
      .eq("lead_id", email.lead_id);
  }

  if (classification.classification === "interested") {
    const account = await supabase
      .from("email_accounts")
      .select("*")
      .eq("status", "active")
      .limit(1)
      .single();

    if (account.data) {
      const autoBody = `Hi ${lead.first_name},\n\nGreat to hear from you! I'd love to set up a quick 15-minute call to walk you through how ScaleMe works and see if it's a fit for ${lead.company || "your team"}.\n\nWould any time this week work for you? Just let me know what fits your schedule best and I'll send over an invite.\n\nLooking forward to it!\n${account.data.display_name}`;
      const fromAddress = `${account.data.display_name} <${account.data.email}>`;

      const resendResult = await sendViaResend(
        fromAddress,
        lead.email,
        `Re: ${email.subject || ""}`,
        autoBody,
        account.data.reply_to_email || undefined,
      );

      const { data: autoEmail } = await supabase
        .from("emails")
        .insert({
          lead_id: email.lead_id,
          email_account_id: account.data.id,
          sequence_id: email.sequence_id,
          step_number: email.step_number,
          direction: "outbound",
          resend_id: resendResult.id,
          from_email: account.data.email,
          to_email: lead.email,
          subject: `Re: ${email.subject || ""}`,
          body_text: autoBody,
          sent_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      await supabase.from("events").insert({
        lead_id: email.lead_id,
        sequence_id: email.sequence_id,
        step_number: email.step_number,
        event_type: "auto_response_sent",
        email_id: autoEmail?.id,
        metadata: { type: "interested_auto_response", resend_id: resendResult.id },
      });

      console.log(`Auto-responded to interested lead ${lead.email} via Resend`);
    }
  }

  console.log(`Classified reply from ${lead.email}: ${classification.classification} (${classification.confidence})`);
}

// --- Main handler ---

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

  const { data: pending } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .order("priority", { ascending: false })
    .order("scheduled_for", { ascending: true })
    .limit(10);

  let claimedJobs: typeof pending = [];
  if (pending && pending.length > 0) {
    const ids = pending.map((j: { id: string }) => j.id);
    await supabase
      .from("jobs")
      .update({ status: "claimed", claimed_at: new Date().toISOString(), claimed_by: "process-jobs" })
      .in("id", ids);
    claimedJobs = pending;
  }

  if (!claimedJobs || claimedJobs.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let processed = 0;
  let failed = 0;

  for (const job of claimedJobs) {
    try {
      switch (job.job_type) {
        case "send_email":
          await handleSendEmail(supabase, job.payload);
          break;
        case "classify_reply":
          await handleClassifyReply(supabase, job.payload);
          break;
        default:
          console.warn(`Unknown job type: ${job.job_type}`);
      }

      await supabase
        .from("jobs")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", job.id);
      processed++;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`Job ${job.id} (${job.job_type}) failed:`, errorMsg);

      const newRetryCount = (job.retry_count || 0) + 1;
      const maxRetries = job.max_retries || 3;

      await supabase
        .from("jobs")
        .update({
          status: newRetryCount >= maxRetries ? "failed" : "pending",
          error: errorMsg,
          retry_count: newRetryCount,
          claimed_at: null,
          claimed_by: null,
        })
        .eq("id", job.id);
      failed++;
    }
  }

  console.log(`Processed ${processed} jobs, ${failed} failed, from ${claimedJobs.length} claimed`);

  return new Response(
    JSON.stringify({ processed, failed, total: claimedJobs.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
