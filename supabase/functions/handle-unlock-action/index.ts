import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

function htmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Unlock Link Retired</title>
</head>
<body style="font-family: sans-serif; max-width: 560px; margin: 80px auto; line-height: 1.5;">
  <h1>Unlock links have been retired</h1>
  <p>For security, lease unlock requests must now be reviewed after signing in to LeaseIO.</p>
</body>
</html>`;
}

serve(() => {
  return new Response(htmlPage(), {
    status: 410,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
