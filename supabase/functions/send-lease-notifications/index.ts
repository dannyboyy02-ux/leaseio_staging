import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface LeaseNotification {
  type: "expiration" | "escalation" | "renewal_window";
  lease_id: string;
  property_address: string;
  user_email: string;
  event_date: string;
  current_rent?: number;
  new_rent?: number;
  days_until_event: number;
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
    const notificationWindows = [90, 60, 30, 14, 7]; // Days before event to notify
    const notifications: LeaseNotification[] = [];

    console.log("Starting lease notification scan...");

    // Fetch all active leases with their workspace owner emails
    const { data: leases, error: leasesError } = await supabase
      .from("leases")
      .select(`
        id,
        filename,
        lease_end,
        extracted_json,
        workspace_id,
        workspaces!inner (
          owner_id,
          profiles!inner (
            email
          )
        )
      `)
      .in("status", ["Ready", "Review"])
      .not("lease_end", "is", null);

    if (leasesError) {
      console.error("Error fetching leases:", leasesError);
      throw leasesError;
    }

    console.log(`Found ${leases?.length || 0} active leases to check`);

    // Check each lease for upcoming events
    for (const lease of leases || []) {
      const userEmail = (lease.workspaces as any)?.profiles?.email;
      if (!userEmail) continue;

      const propertyAddress = 
        (lease.extracted_json as any)?.property_address || 
        lease.filename || 
        "Unknown Property";

      // Check lease expiration
      if (lease.lease_end) {
        const endDate = new Date(lease.lease_end);
        const daysUntilExpiration = Math.ceil(
          (endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (notificationWindows.includes(daysUntilExpiration)) {
          notifications.push({
            type: "expiration",
            lease_id: lease.id,
            property_address: propertyAddress,
            user_email: userEmail,
            event_date: lease.lease_end,
            days_until_event: daysUntilExpiration,
          });
        }

        // Check renewal window (typically 90-120 days before expiration)
        if (daysUntilExpiration >= 90 && daysUntilExpiration <= 120) {
          const renewalWindowDays = [120, 90];
          if (renewalWindowDays.includes(daysUntilExpiration)) {
            notifications.push({
              type: "renewal_window",
              lease_id: lease.id,
              property_address: propertyAddress,
              user_email: userEmail,
              event_date: lease.lease_end,
              days_until_event: daysUntilExpiration,
            });
          }
        }
      }

      // Check rent escalations from rent_schedules
      const { data: rentSchedules } = await supabase
        .from("rent_schedules")
        .select("*")
        .eq("lease_id", lease.id)
        .order("period_start", { ascending: true });

      if (rentSchedules && rentSchedules.length > 0) {
        for (let i = 1; i < rentSchedules.length; i++) {
          const schedule = rentSchedules[i];
          const previousSchedule = rentSchedules[i - 1];
          
          if (schedule.period_start) {
            const escalationDate = new Date(schedule.period_start);
            const daysUntilEscalation = Math.ceil(
              (escalationDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
            );

            if (notificationWindows.includes(daysUntilEscalation)) {
              notifications.push({
                type: "escalation",
                lease_id: lease.id,
                property_address: propertyAddress,
                user_email: userEmail,
                event_date: schedule.period_start,
                current_rent: previousSchedule.monthly_rent,
                new_rent: schedule.monthly_rent,
                days_until_event: daysUntilEscalation,
              });
            }
          }
        }
      }
    }

    console.log(`Found ${notifications.length} notifications to send`);

    // Send emails for each notification
    const emailResults = [];
    for (const notification of notifications) {
      const emailHtml = generateEmailHtml(notification);
      const subject = generateSubject(notification);

      try {
        const result = await resend.emails.send({
          from: "LeaseIO <notifications@resend.dev>",
          to: [notification.user_email],
          subject: subject,
          html: emailHtml,
        });
        
        console.log(`Email sent to ${notification.user_email}:`, result);
        emailResults.push({ success: true, notification, result });
      } catch (emailError) {
        console.error(`Failed to send email to ${notification.user_email}:`, emailError);
        emailResults.push({ success: false, notification, error: emailError });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        notificationsProcessed: notifications.length,
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

function generateSubject(notification: LeaseNotification): string {
  switch (notification.type) {
    case "expiration":
      return `⚠️ Lease Expiring in ${notification.days_until_event} Days - ${notification.property_address}`;
    case "escalation":
      return `📈 Rent Escalation in ${notification.days_until_event} Days - ${notification.property_address}`;
    case "renewal_window":
      return `🔄 Renewal Window Open - ${notification.property_address}`;
    default:
      return `Lease Notification - ${notification.property_address}`;
  }
}

function generateEmailHtml(notification: LeaseNotification): string {
  const baseStyles = `
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    line-height: 1.6;
    color: #333;
  `;

  let content = "";
  const eventDate = new Date(notification.event_date).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  switch (notification.type) {
    case "expiration":
      content = `
        <h2 style="color: #dc2626;">⚠️ Lease Expiration Alert</h2>
        <p>Your lease for <strong>${notification.property_address}</strong> is expiring in <strong>${notification.days_until_event} days</strong>.</p>
        <p><strong>Expiration Date:</strong> ${eventDate}</p>
        <p>Please review your lease and take action to renew or prepare for the end of your lease term.</p>
      `;
      break;
    case "escalation":
      const rentIncrease = notification.new_rent && notification.current_rent 
        ? notification.new_rent - notification.current_rent 
        : 0;
      const percentIncrease = notification.current_rent && rentIncrease
        ? ((rentIncrease / notification.current_rent) * 100).toFixed(1)
        : 0;
      content = `
        <h2 style="color: #2563eb;">📈 Rent Escalation Notice</h2>
        <p>A rent escalation is scheduled for <strong>${notification.property_address}</strong> in <strong>${notification.days_until_event} days</strong>.</p>
        <p><strong>Effective Date:</strong> ${eventDate}</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;">Current Rent:</td>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;"><strong>$${notification.current_rent?.toLocaleString() || 'N/A'}</strong></td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;">New Rent:</td>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;"><strong>$${notification.new_rent?.toLocaleString() || 'N/A'}</strong></td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;">Increase:</td>
            <td style="padding: 8px 16px; border: 1px solid #e5e7eb;"><strong>$${rentIncrease.toLocaleString()} (${percentIncrease}%)</strong></td>
          </tr>
        </table>
      `;
      break;
    case "renewal_window":
      content = `
        <h2 style="color: #059669;">🔄 Renewal Window Now Open</h2>
        <p>The renewal window for <strong>${notification.property_address}</strong> is now open.</p>
        <p><strong>Lease Expires:</strong> ${eventDate}</p>
        <p><strong>Days Remaining:</strong> ${notification.days_until_event} days</p>
        <p>Now is a good time to begin renewal negotiations with your landlord.</p>
      `;
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
        ${content}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #6b7280; font-size: 14px;">
          This notification was sent by LeaseIO to help you manage your lease obligations.
        </p>
        <p style="color: #6b7280; font-size: 14px;">
          <a href="https://leaseio.app" style="color: #2563eb;">View in LeaseIO</a>
        </p>
      </div>
    </body>
    </html>
  `;
}
