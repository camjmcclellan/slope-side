import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

  const { data: leads, error } = await supabase
    .from("lead_sequence_state")
    .select(
      "id, lead_id, sequence_id, current_step_number",
    )
    .eq("status", "active")
    .lte("next_action_at", new Date().toISOString())
    .or("locked_until.is.null,locked_until.lt." + new Date().toISOString());

  if (error) {
    console.error("Error querying due leads:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!leads || leads.length === 0) {
    return new Response(JSON.stringify({ enqueued: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const lockUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let enqueued = 0;

  for (const lead of leads) {
    // Lock the lead to prevent double-queuing
    const { error: lockError } = await supabase
      .from("lead_sequence_state")
      .update({ locked_until: lockUntil })
      .eq("id", lead.id);

    if (lockError) {
      console.error(`Failed to lock lead_sequence_state ${lead.id}:`, lockError);
      continue;
    }

    // Create a send_email job
    const { error: jobError } = await supabase.from("jobs").insert({
      job_type: "send_email",
      payload: {
        lead_id: lead.lead_id,
        sequence_id: lead.sequence_id,
        step_number: lead.current_step_number,
        lead_sequence_state_id: lead.id,
      },
      status: "pending",
      scheduled_for: new Date().toISOString(),
    });

    if (jobError) {
      console.error(`Failed to create job for lead ${lead.lead_id}:`, jobError);
      // Unlock on failure
      await supabase
        .from("lead_sequence_state")
        .update({ locked_until: null })
        .eq("id", lead.id);
      continue;
    }

    enqueued++;
  }

  console.log(`Enqueued ${enqueued} send_email jobs from ${leads.length} due leads`);

  return new Response(JSON.stringify({ enqueued, total_due: leads.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
