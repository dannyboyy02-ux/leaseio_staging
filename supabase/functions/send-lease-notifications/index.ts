import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// Secure CORS configuration
const ALLOWED_ORIGINS = [
  'https://theleaseio.com',
  'https://www.theleaseio.com',
  'https://app.theleaseio.com',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isLovablePreview = requestOrigin && (
    requestOrigin.includes('lovableproject.com') ||
    requestOrigin.includes('lovable.app')
  );
  const isProductionDomain = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin);
  const isAllowed = isProductionDomain || isLovablePreview;
  
  const origin = isAllowed ? requestOrigin : ALLOWED_ORIGINS[0];
    
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

// Default CORS headers for backwards compatibility
const corsHeaders = getCorsHeaders(null);

interface LeaseNotificationRecord {
  id: string;
  lease_id: string;
  event_type: string;
  event_date: string;
  event_description: string | null;
  notify_days_before: number[];
  notify_email: boolean;
  is_confirmed: boolean;
  last_notified_at: string | null;
}

interface LeaseWithProfile {
  id: string;
  filename: string;
  extracted_json: { property_address?: string } | null;
  user_id: string;
  profiles: { email: string } | null;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    console.log("Starting user-approved lease notification scan...");
    console.log(`Today's date: ${today.toISOString()}`);

    // Fetch all CONFIRMED notifications with email enabled
    const { data: notifications, error: notifError } = await supabase
      .from("lease_notifications")
      .select(`
        id,
        lease_id,
        event_type,
        event_date,
        event_description,
        notify_days_before,
        notify_email,
        is_confirmed,
        last_notified_at
      `)
      .eq("is_confirmed", true)
      .eq("notify_email", true);

    if (notifError) {
      console.error("Error fetching notifications:", notifError);
      throw notifError;
    }

    console.log(`Found ${notifications?.length || 0} confirmed notifications with email enabled`);

    const emailsToSend: Array<{
      notification: LeaseNotificationRecord;
      lease: LeaseWithProfile;
      daysUntilEvent: number;
    }> = [];

    // Check each notification to see if it matches a notification window
    for (const notification of (notifications || []) as LeaseNotificationRecord[]) {
      const eventDate = new Date(notification.event_date);
      eventDate.setHours(0, 0, 0, 0);
      
      const daysUntilEvent = Math.ceil(
        (eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );

      console.log(`Notification ${notification.id}: ${notification.event_type} on ${notification.event_date}, ${daysUntilEvent} days away`);

      // Check if today matches one of the notification windows
      if (notification.notify_days_before.includes(daysUntilEvent)) {
        // Check if we already notified for this window
        if (notification.last_notified_at) {
          const lastNotified = new Date(notification.last_notified_at);
          const daysSinceLastNotification = Math.ceil(
            (today.getTime() - lastNotified.getTime()) / (1000 * 60 * 60 * 24)
          );
          
          // Don't notify again if we notified within the last day
          if (daysSinceLastNotification < 1) {
            console.log(`Skipping ${notification.id}: already notified today`);
            continue;
          }
        }

        // Fetch lease and user details
        const { data: lease, error: leaseError } = await supabase
          .from("leases")
          .select(`
            id,
            filename,
            extracted_json,
            user_id,
            profiles!leases_user_id_fkey (
              email
            )
          `)
          .eq("id", notification.lease_id)
          .single();

        if (leaseError || !lease) {
          console.error(`Error fetching lease ${notification.lease_id}:`, leaseError);
          continue;
        }

        const typedLease = lease as unknown as LeaseWithProfile;
        if (!typedLease.profiles?.email) {
          console.log(`Skipping ${notification.id}: no user email found`);
          continue;
        }

        emailsToSend.push({
          notification,
          lease: typedLease,
          daysUntilEvent,
        });
      }
    }

    console.log(`Found ${emailsToSend.length} notifications to send today`);

    // Send emails
    const emailResults = [];
    for (const { notification, lease, daysUntilEvent } of emailsToSend) {
      const propertyAddress =
        (lease.extracted_json as any)?.property_address ||
        lease.filename ||
        "Your Property";

      const subject = generateSubject(notification.event_type, daysUntilEvent, propertyAddress);
      const html = generateEmailHtml(
        notification.event_type,
        notification.event_description,
        notification.event_date,
        daysUntilEvent,
        propertyAddress
      );

      try {
        const result = await resend.emails.send({
          from: "LeaseIO <notifications@resend.dev>",
          to: [lease.profiles!.email],
          subject,
          html,
        });

        console.log(`Email sent to ${lease.profiles!.email}:`, result);

        // Update last_notified_at
        await supabase
          .from("lease_notifications")
          .update({ last_notified_at: new Date().toISOString() })
          .eq("id", notification.id);

        emailResults.push({ success: true, notificationId: notification.id, result });
      } catch (emailError) {
        console.error(`Failed to send email for notification ${notification.id}:`, emailError);
        emailResults.push({ success: false, notificationId: notification.id, error: emailError });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        notificationsProcessed: emailsToSend.length,
        results: emailResults,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in send-lease-notifications:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
});

function generateSubject(eventType: string, daysUntil: number, property: string): string {
  switch (eventType) {
    case "expiration":
      return `⚠️ Lease Expiring in ${daysUntil} Days - ${property}`;
    case "escalation":
      return `📈 Rent Escalation in ${daysUntil} Days - ${property}`;
    case "renewal_window":
      return `🔄 Renewal Window Reminder - ${property}`;
    case "commencement":
      return `📅 Lease Commencement in ${daysUntil} Days - ${property}`;
    case "custom":
      return `📌 Reminder: ${property} - ${daysUntil} Days`;
    default:
      return `Lease Notification - ${property}`;
  }
}

function generateEmailHtml(
  eventType: string,
  description: string | null,
  eventDate: string,
  daysUntil: number,
  property: string
): string {
  const formattedDate = new Date(eventDate).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const baseStyles = `
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    line-height: 1.6;
    color: #333;
  `;

  let headerColor = "#2563eb";
  let icon = "📅";
  let title = "Lease Notification";

  switch (eventType) {
    case "expiration":
      headerColor = "#dc2626";
      icon = "⚠️";
      title = "Lease Expiration Alert";
      break;
    case "escalation":
      headerColor = "#2563eb";
      icon = "📈";
      title = "Rent Escalation Notice";
      break;
    case "renewal_window":
      headerColor = "#059669";
      icon = "🔄";
      title = "Renewal Window Reminder";
      break;
    case "commencement":
      headerColor = "#7c3aed";
      icon = "📅";
      title = "Lease Commencement Reminder";
      break;
    case "custom":
      headerColor = "#6b7280";
      icon = "📌";
      title = "Custom Reminder";
      break;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="${baseStyles} background-color: #f9fafb; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <h2 style="color: ${headerColor};">${icon} ${title}</h2>
        <p><strong>Property:</strong> ${property}</p>
        <p><strong>Date:</strong> ${formattedDate}</p>
        <p><strong>Days Remaining:</strong> ${daysUntil} days</p>
        ${description ? `<p><strong>Details:</strong> ${description}</p>` : ""}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #6b7280; font-size: 14px;">
          This notification was sent because you confirmed this date and enabled email notifications in LeaseIO.
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          You can manage your notification preferences from your lease review page.
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          <a href="https://leaseio.app" style="color: #2563eb;">View in LeaseIO</a>
        </p>
      </div>
    </body>
    </html>
  `;
}
